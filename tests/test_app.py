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
    def test_stack_icon_uses_member_service_icon(self):
        graph = app.build_graph([
            service("media_radarr", {
                "com.docker.stack.namespace": "media",
                "doc.icon": "radarr",
                "doc.depends_on": "",
            }),
            service("media_sonarr", {
                "com.docker.stack.namespace": "media",
                "doc.icon": "radarr",
                "doc.depends_on": "",
            }),
        ])
        stack = next(stack for stack in graph["stacks"] if stack["id"] == "stack:media")
        self.assertEqual(stack["icon"], "radarr")

    def test_stack_with_different_icons_prefers_published_service(self):
        published = service("media_radarr", {
            "com.docker.stack.namespace": "media",
            "doc.icon": "radarr",
            "doc.depends_on": "",
        })
        published["Endpoint"] = {"Ports": [{
            "PublishedPort": 7878,
            "TargetPort": 7878,
            "Protocol": "tcp",
        }]}
        graph = app.build_graph([
            service("media_sonarr", {
                "com.docker.stack.namespace": "media",
                "doc.icon": "sonarr",
                "doc.depends_on": "",
            }),
            published,
        ])
        stack = next(stack for stack in graph["stacks"] if stack["id"] == "stack:media")
        self.assertEqual(stack["icon"], "radarr")

    def test_stack_dependencies_propagate_member_failure_without_counting_stack(self):
        graph = app.build_graph([
            service("db", {"com.docker.stack.namespace": "backend", "doc.depends_on": ""}),
            service("cache", {"com.docker.stack.namespace": "backend", "doc.depends_on": ""}),
            service("web", {"com.docker.stack.namespace": "frontend", "doc.depends_on": "stack:backend"}),
            service("client", {"doc.depends_on": "web"}),
        ])
        nodes = {node["id"]: node for node in graph["nodes"]}
        self.assertEqual(nodes["stack:backend"]["kind"], "stack")
        self.assertEqual(nodes["stack:backend"]["name"], "backend")
        self.assertEqual(nodes["stack:backend"]["members"], ["cache", "db"])
        self.assertEqual(nodes["stack:backend"]["used_by"], ["web"])
        for member in ("cache", "db"):
            self.assertEqual(nodes[member]["stack"], "backend")
            self.assertEqual(nodes[member]["used_by"], [])
            self.assertEqual(nodes[member]["transitive_impact"], ["client", "web"])
            self.assertEqual(nodes[member]["impact_count"], 2)
        self.assertEqual(graph["service_count"], 4)
        self.assertEqual(graph["warnings"], [])
        self.assertEqual(graph["edges"], [
            {"source": "client", "target": "web"},
            {"source": "web", "target": "stack:backend"},
        ])

    def test_stack_cycles_missing_and_authoritative_membership(self):
        graph = app.build_graph([
            service("a", {"com.docker.stack.namespace": "one", "doc.depends_on": "stack:two"}),
            service("b", {"com.docker.stack.namespace": "two", "doc.depends_on": "stack:one"}),
            service("looks_like_a_stack", {"doc.depends_on": "stack:unknown"}),
        ])
        nodes = {node["id"]: node for node in graph["nodes"]}
        self.assertEqual(nodes["a"]["transitive_impact"], ["b"])
        self.assertEqual(nodes["b"]["transitive_impact"], ["a"])
        self.assertEqual(nodes["a"]["impact_count"], 1)
        self.assertEqual(nodes["stack:unknown"]["kind"], "missing")
        self.assertIsNone(nodes["looks_like_a_stack"]["stack"])
        self.assertEqual(graph["warnings"], [
            "looks_like_a_stack depends on stack:unknown, which is not a known stack",
        ])
        self.assertEqual([stack["id"] for stack in graph["stacks"]], ["stack:one", "stack:two"])

    def test_stack_dependencies_merge_with_used_by_and_terminate_self_cycle(self):
        graph = app.build_graph([
            service("a", {"com.docker.stack.namespace": "one", "doc.depends_on": "stack:one",
                          "doc.used_by": "ext:client"}),
            service("web", {"doc.depends_on": "stack:one,a"}),
        ])
        nodes = {node["id"]: node for node in graph["nodes"]}
        self.assertEqual(nodes["a"]["used_by"], ["ext:client", "web"])
        self.assertEqual(nodes["a"]["impact_count"], 2)
        self.assertEqual(nodes["a"]["transitive_impact"], [])
        self.assertNotIn("a", nodes["a"]["used_by"])

    def test_used_by_merges_reverse_dependencies_and_external_impact(self):
        graph = app.build_graph([
            service("db", {"doc.depends_on": "", "doc.used_by": " web,ext:homeassistant,web, , "}),
            service("web", {"doc.depends_on": "db", "doc.used_by": "ext:homeassistant"}),
        ])
        nodes = {node["id"]: node for node in graph["nodes"]}
        self.assertEqual(graph["edges"], [
            {"source": "ext:homeassistant", "target": "db"},
            {"source": "ext:homeassistant", "target": "web"},
            {"source": "web", "target": "db"},
        ])
        self.assertEqual(nodes["ext:homeassistant"]["kind"], "external")
        self.assertEqual(nodes["ext:homeassistant"]["depends_on"], ["db", "web"])
        self.assertEqual(nodes["db"]["used_by"], ["ext:homeassistant", "web"])
        self.assertEqual(nodes["db"]["impact_count"], 2)
        self.assertEqual(graph["service_count"], 2)
        self.assertEqual(graph["warnings"], [])

    def test_used_by_transitive_cycles_missing_and_label_precedence(self):
        graph = app.build_graph([
            service("db", {"doc.depends_on": "", "doc.used_by": "web"}),
            service("web", {"doc.depends_on": "", "doc.used_by": "ext:homeassistant"}),
        ])
        nodes = {node["id"]: node for node in graph["nodes"]}
        self.assertEqual(nodes["db"]["transitive_impact"], ["ext:homeassistant"])
        graph = app.build_graph([
            service("a", {"doc.depends_on": "", "doc.used_by": "b,a,missing"}),
            service("b", {"doc.depends_on": "", "doc.used_by": "a"},
                    {"doc.used_by": "ext:ignored"}),
        ])
        nodes = {node["id"]: node for node in graph["nodes"]}
        self.assertEqual(nodes["a"]["impact_count"], 2)
        self.assertEqual(nodes["a"]["used_by"], ["b", "missing"])
        self.assertEqual(nodes["missing"]["kind"], "missing")
        self.assertNotIn("ext:ignored", nodes)
        self.assertEqual(graph["warnings"], [
            "a depends on itself",
            "a is used by missing, which is not a running service",
        ])

    def test_task_template_labels_are_not_used_as_service_metadata(self):
        graph = app.build_graph([
            service("a", {"doc.category": "service"},
                    {"doc.category": "container", "doc.depends_on": ""}),
        ])
        node = next(node for node in graph["nodes"] if node["id"] == "a")
        self.assertEqual(node["category"], "service")
        self.assertEqual(node["depends_on"], [])
        self.assertEqual(graph["warnings"], ["a has no doc.depends_on label"])

    def test_task_container_icons_use_common_icon_or_published_container_icon(self):
        svc = service("media_player", {
            "doc.icon": "service-icon",
            "doc.depends_on": "",
        })
        svc["ID"] = "media-player-id"
        svc["Endpoint"] = {"Ports": [{
            "PublishedPort": 8080,
            "TargetPort": 80,
            "Protocol": "tcp",
            "PublishMode": "host",
        }]}
        tasks = [
            {
                "ID": "a",
                "ServiceID": "media-player-id",
                "DesiredState": "running",
                "Status": {
                    "State": "running",
                    "PortStatus": {"Ports": [{
                        "PublishedPort": 8080,
                        "TargetPort": 80,
                        "Protocol": "tcp",
                    }]},
                },
                "Spec": {"ContainerSpec": {"Labels": {"doc.icon": "radarr"}}},
            },
            {
                "ID": "b",
                "ServiceID": "media-player-id",
                "DesiredState": "running",
                "Status": {"State": "running", "PortStatus": {}},
                "Spec": {"ContainerSpec": {"Labels": {"doc.icon": "plex"}}},
            },
            {
                "ID": "old",
                "ServiceID": "media-player-id",
                "DesiredState": "shutdown",
                "Status": {"State": "shutdown"},
                "Spec": {"ContainerSpec": {"Labels": {"doc.icon": "bazarr"}}},
            },
        ]
        task_containers = app.task_icon_containers([svc], tasks)
        graph = app.build_graph([svc], task_containers=task_containers)
        node = next(node for node in graph["nodes"] if node["id"] == "media_player")
        self.assertEqual(node["icon"], "radarr")

        for task in tasks[:2]:
            task["Spec"]["ContainerSpec"]["Labels"]["doc.icon"] = "radarr"
        task_containers = app.task_icon_containers([svc], tasks)
        graph = app.build_graph([svc], task_containers=task_containers)
        node = next(node for node in graph["nodes"] if node["id"] == "media_player")
        self.assertEqual(node["icon"], "radarr")

    def test_task_container_icon_falls_back_to_service_icon_without_published_choice(self):
        graph = app.build_graph(
            [service("media_player", {"doc.icon": "plex", "doc.depends_on": ""})],
            task_containers=[
                {
                    "Id": "a",
                    "Labels": {
                        "com.docker.swarm.service.name": "media_player",
                        "doc.icon": "radarr",
                    },
                    "Ports": [],
                },
                {
                    "Id": "b",
                    "Labels": {
                        "com.docker.swarm.service.name": "media_player",
                        "doc.icon": "bazarr",
                    },
                    "Ports": [],
                },
            ],
        )
        node = next(node for node in graph["nodes"] if node["id"] == "media_player")
        self.assertEqual(node["icon"], "plex")

    def test_swarm_placements_use_running_tasks_and_preserve_impact(self):
        services = [
            {**service("web", {"doc.depends_on": "db"}), "ID": "web-id"},
            {**service("db", {"doc.depends_on": ""}), "ID": "db-id"},
            {**service("scaled-zero", {"doc.depends_on": ""}), "ID": "zero-id"},
        ]
        swarm_nodes = [{
            "ID": node_id, "Description": {"Hostname": f"docker{index}"},
            "Spec": {"Role": "manager" if index == 1 else "worker", "Availability": "active"},
            "Status": {"State": "ready"},
        } for index, node_id in enumerate(["n1", "n2", "idle"], 1)]
        tasks = [
            {"ServiceID": service_id, "NodeID": node_id, "Status": {"State": state}}
            for service_id, node_id, state in [
                ("web-id", "n1", "running"), ("web-id", "n1", "running"),
                ("web-id", "n2", "running"), ("db-id", "n2", "running"),
                ("zero-id", "n1", "shutdown"), ("web-id", "n2", "failed"),
                ("web-id", "n1", "starting"), ("web-id", "gone", "running"),
                ("removed-service", "n1", "running"),
            ]
        ]
        tasks.append({"ServiceID": "web-id", "Status": {"State": "pending"}})
        baseline = app.build_graph(services)
        graph = app.build_graph(services, swarm_nodes, tasks)
        for key in ("nodes", "edges", "implicit_edges", "warnings", "service_count"):
            self.assertEqual(graph[key], baseline[key])
        self.assertEqual(graph["placement_edges"], [
            {"source": "db", "target": "swarm-node:n2"},
            {"source": "web", "target": "swarm-node:n1"},
            {"source": "web", "target": "swarm-node:n2"},
        ])
        self.assertEqual(len(graph["swarm_nodes"]), 3)
        manager = next(node for node in graph["swarm_nodes"] if node["id"] == "swarm-node:n1")
        self.assertEqual(manager["name"], "docker1")
        self.assertEqual(manager["role"], "manager")
        self.assertEqual(manager["kind"], "swarm")
        self.assertNotIn("swarm_nodes", baseline)
        self.assertEqual(app.build_graph([], [], [])["placement_edges"], [])

    def test_icon_slug_is_validated_with_docker_fallback(self):
        graph = app.build_graph([
            service("a", {"doc.icon": "radarr", "doc.depends_on": ""}),
            service("b", {"doc.icon": "../evil\"x", "doc.depends_on": "ext:plex"}),
            service("c", {"doc.depends_on": ""}),
            service("d", {"doc.icon": "Radarr", "doc.depends_on": ""}),
        ])
        icons = {node["id"]: node["icon"] for node in graph["nodes"]}
        self.assertEqual(icons, {
            "a": "radarr", "b": "docker", "c": "docker", "d": "docker", "ext:plex": "plex",
        })

    def test_external_icon_uses_valid_name_without_aliases(self):
        graph = app.build_graph([service("web", {
            "doc.depends_on": "ext:plex,ext:home-assistant,ext:unknown-icon,ext:../invalid",
            "doc.used_by": "ext:consumer",
        })])
        icons = {node["id"]: node["icon"] for node in graph["nodes"]}
        self.assertEqual(icons["ext:plex"], "plex")
        self.assertEqual(icons["ext:home-assistant"], "home-assistant")
        self.assertEqual(icons["ext:unknown-icon"], "unknown-icon")
        self.assertEqual(icons["ext:../invalid"], "docker")
        self.assertEqual(icons["ext:consumer"], "consumer")

    def test_https_icon_urls_are_preserved_in_services_and_stacks(self):
        url = "https://kvitt.teambail.se/apple-touch-icon-v2.png"
        graph = app.build_graph([service("example_web", {
            "doc.icon": url,
            "doc.depends_on": "",
            "com.docker.stack.namespace": "example",
        })])
        self.assertEqual(graph["nodes"][0]["icon"], url)
        self.assertEqual(graph["stacks"][0]["icon"], url)
        self.assertEqual(app.icon_slug("https://icons.example.com:8443/icon.png?v=2"),
                         "https://icons.example.com:8443/icon.png?v=2")

    def test_invalid_icon_urls_fall_back_to_docker(self):
        for value in (
            "http://icons.example.com/icon.png", "//icons.example.com/icon.png",
            "javascript:alert(1)", "data:image/png;base64,AA", "https://",
            "https://user:password@icons.example.com/icon.png",
            "https://icons.example.com:65536/icon.png",
            "https://icons.example.com/icon.png\n",
            "https://icons.example.com\\other/icon.png", "https://localhost/icon.png",
        ):
            with self.subTest(value=value):
                self.assertEqual(app.icon_slug(value), "docker")

    def test_multiple_categories(self):
        graph = app.build_graph([
            service("multi", {"doc.category": " apps, infra,apps, , ", "doc.depends_on": "ext:internet,missing"}),
            service("blank", {"doc.category": " , ", "doc.depends_on": ""}),
            service("default", {"doc.depends_on": ""}),
        ])
        nodes = {node["id"]: node for node in graph["nodes"]}
        self.assertEqual(nodes["multi"]["categories"], ["apps", "infra"])
        self.assertEqual(nodes["multi"]["category"], " apps, infra,apps, , ")
        self.assertEqual(nodes["blank"]["categories"], ["uncategorized"])
        self.assertEqual(nodes["default"]["categories"], ["uncategorized"])
        self.assertEqual(nodes["ext:internet"]["categories"], ["external"])
        self.assertEqual(nodes["missing"]["categories"], ["missing"])

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

    def test_task_template_labels_do_not_override_service_labels(self):
        graph = app.build_graph([service(
            "your_spotify_web",
            {"doc.category": "service", "com.docker.stack.namespace": "your_spotify"},
            {"doc.category": "container", "doc.depends_on": ""},
        )])
        node = graph["nodes"][0]
        self.assertEqual(node["category"], "service")
        self.assertEqual(node["name"], "your_spotify-web")
        self.assertEqual(graph["warnings"], ["your_spotify_web has no doc.depends_on label"])

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
                    for endpoint in ("/containers/json", "/nodes", "/tasks"):
                        self.assertEqual(app.read_docker_list(endpoint), [{"Spec": {"Name": "test"}}])
                        self.assertEqual(server.request_path, endpoint)
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
            ("/android-chrome-192x192.png", "image/png"),
            ("/android-chrome-512x512.png", "image/png"),
            ("/apple-touch-icon.png", "image/png"),
            ("/favicon-16x16.png", "image/png"),
            ("/favicon-32x32.png", "image/png"),
            ("/favicon.ico", "image/x-icon"),
            ("/site.webmanifest", "application/manifest+json"),
            ("/healthz", "text/plain"),
        ]:
            with self.subTest(path=path):
                status, headers, body = self.get(path)
                self.assertEqual(status, 200)
                self.assertIn(content_type, headers["Content-Type"])
                self.assertEqual(int(headers["Content-Length"]), len(body))
                self.assertIn("default-src 'self'", headers["Content-Security-Policy"])
                self.assertIn("img-src 'self' https:;",
                              headers["Content-Security-Policy"])
                self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
        self.assertEqual(self.get("/../app.py")[0], 404)

    def test_api_refreshes_discovery(self):
        with patch.object(app, "read_services", return_value=[]) as discovery, \
                patch.object(app, "read_docker_list", return_value=[]) as extra_discovery:
            for _ in range(2):
                status, _, body = self.get("/api/dependencies")
                self.assertEqual(status, 200)
                self.assertEqual(json.loads(body)["nodes"], [])
            self.assertEqual(discovery.call_count, 2)
            self.assertEqual([call.args[0] for call in extra_discovery.call_args_list],
                             ["/tasks", "/tasks"])

    def test_swarm_discovery_is_opt_in_and_refreshes(self):
        with patch.object(app, "read_services", return_value=[]), \
                patch.object(app, "read_docker_list", return_value=[]) as discovery:
            for _ in range(2):
                status, _, body = self.get("/api/dependencies?include_swarm_nodes=true")
                self.assertEqual(status, 200)
                self.assertEqual(json.loads(body)["swarm_nodes"], [])
                self.assertEqual(json.loads(body)["placement_edges"], [])
            self.assertEqual([call.args[0] for call in discovery.call_args_list],
                             ["/tasks", "/nodes", "/tasks", "/nodes"])

    def test_swarm_discovery_failure_is_explicit(self):
        with patch.object(app, "read_services", return_value=[]), \
                patch.object(app, "read_docker_list", side_effect=RuntimeError("private details")):
            with self.assertLogs(level="ERROR"):
                status, _, body = self.get("/api/dependencies?include_swarm_nodes=true")
        self.assertEqual(status, 503)
        self.assertIn("/nodes and /tasks", json.loads(body)["error"])
        self.assertNotIn("private details", body.decode())

    def test_unavailable_docker_is_a_safe_actionable_error(self):
        with patch.object(app, "read_services", side_effect=PermissionError("private path")):
            with self.assertLogs(level="ERROR"):
                status, _, body = self.get("/api/dependencies")
        self.assertEqual(status, 503)
        self.assertIn("Swarm manager", json.loads(body)["error"])
        self.assertNotIn("private path", body.decode())


if __name__ == "__main__":
    unittest.main()
