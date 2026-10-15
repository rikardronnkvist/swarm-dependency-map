import http.client
import json
import logging
import os
import socket
from collections import defaultdict, deque
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit


STATIC = Path(__file__).parent / "static"
TRAEFIK = os.environ.get("TRAEFIK_SERVICE", "traefik_traefik")
AUTHENTIK = os.environ.get("AUTHENTIK_SERVICE", "authentik_server")


class DockerConnection(http.client.HTTPConnection):
    def __init__(self, socket_path):
        super().__init__("localhost", timeout=10)
        self.socket_path = socket_path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.socket_path)


def read_services():
    connection = DockerConnection(
        os.environ.get("DOCKER_SOCKET", "/var/run/docker.sock")
    )
    try:
        connection.request("GET", "/services")
        response = connection.getresponse()
        if response.status != 200:
            raise RuntimeError(f"Docker service discovery returned HTTP {response.status}")
        services = json.loads(response.read())
        if not isinstance(services, list):
            raise ValueError("Docker returned an invalid service list")
        return services
    finally:
        connection.close()


def short_name(name, labels):
    if name.startswith("ext:"):
        return name[4:]
    stack = labels.get(name, {}).get("com.docker.stack.namespace")
    if stack and name.startswith(stack + "_"):
        service = name[len(stack) + 1:]
    else:
        stack, _, service = name.partition("_")
    if not service or service == stack:
        return stack
    if service.startswith(stack):
        return service
    return f"{stack}-{service}"


def build_graph(services):
    labels = {}
    for service in services:
        spec = service["Spec"]
        # Swarm supports both service labels and task container labels.
        container = spec.get("TaskTemplate", {}).get("ContainerSpec", {})
        labels[spec["Name"]] = {
            **(container.get("Labels") or {}),
            **(spec.get("Labels") or {}),
        }

    dependencies = {}
    implicit = {}
    used_by = defaultdict(set)
    implicit_used_by = defaultdict(set)
    warnings = []
    for name, lab in sorted(labels.items()):
        raw = lab.get("doc.depends_on")
        if raw is None:
            warnings.append(f"{name} has no doc.depends_on label")
            raw = ""
        dependencies[name] = sorted({d.strip() for d in raw.split(",") if d.strip()})
        for dependency in dependencies[name]:
            used_by[dependency].add(name)
            if dependency == name:
                warnings.append(f"{name} depends on itself")
            elif not dependency.startswith("ext:") and dependency not in labels:
                warnings.append(
                    f"{name} depends on {dependency}, which is not a running service"
                )

        derived = set()
        if lab.get("traefik.enable") == "true" and name != TRAEFIK:
            derived.add(TRAEFIK)
        if any(
            "authentik" in value.lower()
            for key, value in lab.items()
            if key.startswith("traefik.") and "middlewares" in key
        ):
            derived.add(AUTHENTIK)
        implicit[name] = sorted(derived)
        for dependency in derived:
            implicit_used_by[dependency].add(name)

    def impact(target):
        seen = {target}
        queue = deque([target])
        while queue:
            for dependent in used_by.get(queue.popleft(), ()):
                if dependent not in seen:
                    seen.add(dependent)
                    queue.append(dependent)
        return seen - {target}

    nodes = []
    targets = set(labels) | set(used_by) | set(implicit_used_by)
    for name in sorted(targets):
        direct = used_by.get(name, set()) - {name}
        affected = impact(name)
        kind = "service" if name in labels else (
            "external" if name.startswith("ext:") else "missing"
        )
        category = labels[name].get("doc.category", "uncategorized") if name in labels else kind
        categories = sorted({value.strip() for value in category.split(",") if value.strip()})
        if not categories:
            categories = ["uncategorized"]
        nodes.append({
            "id": name,
            "name": short_name(name, labels),
            "kind": kind,
            "category": category,
            "categories": categories,
            "depends_on": dependencies.get(name, []),
            "used_by": sorted(direct),
            "transitive_impact": sorted(affected - direct),
            "impact_count": len(affected),
            "implicit_used_by": sorted(implicit_used_by.get(name, ())),
        })

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "service_count": len(labels),
        "nodes": nodes,
        "edges": [
            {"source": name, "target": target}
            for name, targets in sorted(dependencies.items()) for target in targets
        ],
        "implicit_edges": [
            {"source": name, "target": target}
            for name, targets in sorted(implicit.items()) for target in targets
        ],
        "warnings": warnings,
    }


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/healthz":
            self.respond(200, b"ok\n", "text/plain")
        elif path == "/api/dependencies":
            try:
                data = build_graph(read_services())
            except (OSError, http.client.HTTPException, ValueError, KeyError,
                    TypeError, RuntimeError):
                logging.exception("Cannot read Swarm services")
                self.respond(
                    503,
                    json.dumps({
                        "error": "Cannot read Swarm services. Check that the Docker "
                        "socket is accessible and this application is on a Swarm manager."
                    }).encode(),
                    "application/json",
                )
                return
            self.respond(200, json.dumps(data).encode(), "application/json")
        else:
            files = {
                "/": ("index.html", "text/html"),
                "/app.js": ("app.js", "text/javascript"),
                "/style.css": ("style.css", "text/css"),
            }
            if path not in files:
                self.respond(404, b"Not found\n", "text/plain")
                return
            filename, content_type = files[path]
            self.respond(200, (STATIC / filename).read_bytes(), content_type)

    def respond(self, status, body, content_type):
        self.send_response(status)
        self.send_header("Content-Type", f"{content_type}; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy",
                         "default-src 'self'; object-src 'none'; "
                         "base-uri 'none'; frame-ancestors 'none'")
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    port = int(os.environ.get("PORT", "8080"))
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    logging.info("Serving dependency map on port %s", port)
    server.serve_forever()
