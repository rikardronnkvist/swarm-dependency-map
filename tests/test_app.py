import http.client
import json
import os
import socketserver
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from tempfile import TemporaryDirectory
from unittest.mock import patch

import app


def service(name, labels=None, container_labels=None):
    return {"Spec": {
        "Name": name,
        "Labels": labels,
        "TaskTemplate": {"ContainerSpec": {"Labels": container_labels}},
    }}


class GraphTests(unittest.TestCase):
    def test_dependencies_and_transitive_impact(self):
        graph = app.build_graph([
            service("media_radarr", {
                "doc.category": "media",
                "doc.depends_on": " index_prowlarr, ext:internet, index_prowlarr, ",
            }),
            service("index_prowlarr", {"doc.depends_on": "vpn_vpn"}),
            service("vpn_vpn", {"doc.depends_on": ""}),
        ])
        nodes = {node["id"]: node for node in graph["nodes"]}
        self.assertEqual(graph["service_count"], 3)
        self.assertEqual(graph["warnings"], [])
        self.assertEqual(nodes["media_radarr"]["category"], "media")
        self.assertEqual(nodes["media_radarr"]["depends_on"],
                         ["ext:internet", "index_prowlarr"])
        self.assertEqual(nodes["vpn_vpn"]["used_by"], ["index_prowlarr"])
        self.assertEqual(nodes["vpn_vpn"]["transitive_impact"], ["media_radarr"])
        self.assertEqual(nodes["vpn_vpn"]["impact_count"], 2)
        self.assertEqual(nodes["ext:internet"]["kind"], "external")
        self.assertEqual(nodes["ext:internet"]["name"], "internet")
        self.assertEqual(len(graph["edges"]), 3)

    def test_warnings_and_missing_targets(self):
        graph = app.build_graph([
            service("a", {"doc.depends_on": "a,missing,ext:outside"}),
            service("b"),
        ])
        self.assertEqual(graph["warnings"], [
            "a depends on itself",
            "a depends on missing, which is not a running service",
            "b has no doc.depends_on label",
        ])
        nodes = {node["id"]: node for node in graph["nodes"]}
        self.assertEqual(nodes["missing"]["kind"], "missing")
        self.assertEqual(nodes["a"]["impact_count"], 0)

    def test_cycles_terminate_and_exclude_target(self):
        graph = app.build_graph([
            service("a", {"doc.depends_on": "b"}),
            service("b", {"doc.depends_on": "a"}),
            service("c", {"doc.depends_on": "b"}),
        ])
        nodes = {node["id"]: node for node in graph["nodes"]}
        self.assertEqual(nodes["a"]["used_by"], ["b"])
        self.assertEqual(nodes["a"]["transitive_impact"], ["c"])
        self.assertEqual(nodes["a"]["impact_count"], 2)
        self.assertEqual(nodes["b"]["used_by"], ["a", "c"])
        self.assertEqual(nodes["b"]["transitive_impact"], [])

    def test_implicit_edges_are_separate_from_explicit_impact(self):
        with patch.object(app, "TRAEFIK", "proxy"), patch.object(app, "AUTHENTIK", "auth"):
            graph = app.build_graph([
                service("web", {
                    "doc.depends_on": "",
                    "traefik.enable": "true",
                    "traefik.http.routers.web.middlewares": "AUTHENTIK@file",
                }),
                service("proxy", {"doc.depends_on": "", "traefik.enable": "true"}),
            ])
        nodes = {node["id"]: node for node in graph["nodes"]}
        self.assertEqual(nodes["proxy"]["implicit_used_by"], ["web"])
        self.assertEqual(nodes["auth"]["implicit_used_by"], ["web"])
        self.assertEqual(nodes["proxy"]["impact_count"], 0)
        self.assertEqual(graph["edges"], [])
        self.assertEqual(graph["implicit_edges"], [
            {"source": "web", "target": "auth"},
            {"source": "web", "target": "proxy"},
        ])

    def test_container_labels_and_service_label_precedence(self):
        graph = app.build_graph([service(
            "your_spotify_web",
            {"doc.category": "service", "com.docker.stack.namespace": "your_spotify"},
            {"doc.category": "container", "doc.depends_on": ""},
        )])
        node = graph["nodes"][0]
        self.assertEqual(node["category"], "service")
        self.assertEqual(node["name"], "your_spotify-web")
        self.assertEqual(graph["warnings"], [])

    def test_short_names(self):
        for name, expected in [
            ("radarr_radarr", "radarr"),
            ("teslamate_teslamate-mcp", "teslamate-mcp"),
            ("karakeep_web", "karakeep-web"),
            ("standalone", "standalone"),
            ("ext:internet", "internet"),
        ]:
            with self.subTest(name=name):
                self.assertEqual(app.short_name(name, {}), expected)

    def test_empty_swarm(self):
        graph = app.build_graph([])
        self.assertEqual(graph["service_count"], 0)
        for key in ("nodes", "edges", "implicit_edges", "warnings"):
            self.assertEqual(graph[key], [])


class DockerTests(unittest.TestCase):
    def test_discovery_over_unix_socket_and_error_handling(self):
        class DockerHandler(BaseHTTPRequestHandler):
            status = 200
            payload = b'[{"Spec":{"Name":"test"}}]'

            def do_GET(self):
                self.server.request_path = self.path
                self.send_response(self.status)
                self.end_headers()
                self.wfile.write(self.payload)

            def log_message(self, *args):
                pass

        with TemporaryDirectory() as directory:
            path = directory + "/docker.sock"
            server = socketserver.UnixStreamServer(path, DockerHandler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                with patch.dict(os.environ, {"DOCKER_SOCKET": path}):
                    self.assertEqual(app.read_services(), [{"Spec": {"Name": "test"}}])
                    self.assertEqual(server.request_path, "/services")
                    DockerHandler.status = 503
                    with self.assertRaises(RuntimeError):
                        app.read_services()
                    DockerHandler.status = 200
                    DockerHandler.payload = b"{}"
                    with self.assertRaises(ValueError):
                        app.read_services()
            finally:
                server.shutdown()
                server.server_close()
                thread.join()


class HTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), app.Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def get(self, path):
        connection = http.client.HTTPConnection(*self.server.server_address)
        try:
            connection.request("GET", path)
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def test_static_routes_and_security_headers(self):
        for path, content_type in [
            ("/", "text/html"),
            ("/app.js", "text/javascript"),
            ("/style.css", "text/css"),
            ("/healthz", "text/plain"),
        ]:
            with self.subTest(path=path):
                status, headers, body = self.get(path)
                self.assertEqual(status, 200)
                self.assertIn(content_type, headers["Content-Type"])
                self.assertEqual(int(headers["Content-Length"]), len(body))
                self.assertIn("default-src 'self'", headers["Content-Security-Policy"])
                self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
        self.assertEqual(self.get("/../app.py")[0], 404)

    def test_api_refreshes_discovery(self):
        with patch.object(app, "read_services", return_value=[]) as discovery:
            for _ in range(2):
                status, _, body = self.get("/api/dependencies")
                self.assertEqual(status, 200)
                self.assertEqual(json.loads(body)["nodes"], [])
            self.assertEqual(discovery.call_count, 2)

    def test_unavailable_docker_is_a_safe_actionable_error(self):
        with patch.object(app, "read_services", side_effect=PermissionError("private path")):
            with self.assertLogs(level="ERROR"):
                status, _, body = self.get("/api/dependencies")
        self.assertEqual(status, 503)
        self.assertIn("Swarm manager", json.loads(body)["error"])
        self.assertNotIn("private path", body.decode())


if __name__ == "__main__":
    unittest.main()
