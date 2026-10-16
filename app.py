import http.client
import json
import logging
import os
import re
import socket
from collections import defaultdict, deque
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit


STATIC = Path(__file__).parent / "static"
TRAEFIK = os.environ.get("TRAEFIK_SERVICE", "traefik_traefik")
AUTHENTIK = os.environ.get("AUTHENTIK_SERVICE", "authentik_server")
ICON_SLUG = re.compile(r"^[a-z0-9-]+$")
ICON_URL = re.compile(
    r"https://(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+"
    r"[a-zA-Z](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?"
    r"(?::[1-9][0-9]{0,4})?(?:[/?#][^\s\\]*)?"
)
DEFAULT_ICON = "docker"


def icon_slug(value):
    if not isinstance(value, str):
        return DEFAULT_ICON
    if ICON_SLUG.fullmatch(value):
        return value
    if ICON_URL.fullmatch(value):
        try:
            if urlsplit(value).port is None or urlsplit(value).port <= 65535:
                return value
        except ValueError:
            pass
    return DEFAULT_ICON


def container_has_published_port(container, service):
    container_ports = container.get("Ports") or []
    if any(port.get("PublicPort") for port in container_ports):
        return True

    published_targets = {
        (port.get("TargetPort"), (port.get("Protocol") or "tcp").lower())
        for port in ((service.get("Endpoint") or {}).get("Ports") or [])
        if port.get("PublishedPort")
    }
    return any(
        (port.get("PrivatePort"), (port.get("Type") or "tcp").lower())
        in published_targets
        for port in container_ports
    )


def task_icon_containers(services, tasks):
    services_by_id = {
        service["ID"]: service
        for service in services
        if service.get("ID")
    }
    containers = []
    for task in tasks:
        status = task.get("Status") or {}
        if status.get("State") != "running" or task.get("DesiredState", "running") != "running":
            continue
        service = services_by_id.get(task.get("ServiceID"))
        if service is None:
            continue

        container_spec = (task.get("Spec") or {}).get("ContainerSpec") or {}
        labels = container_spec.get("Labels") or {}
        service_name = service["Spec"]["Name"]
        labels = {
            **labels,
            "com.docker.swarm.service.name": service_name,
        }
        ports = [
            {
                "PublicPort": port.get("PublishedPort"),
                "PrivatePort": port.get("TargetPort"),
                "Type": port.get("Protocol") or "tcp",
            }
            for port in ((status.get("PortStatus") or {}).get("Ports") or [])
        ]
        if not ports:
            ports = [
                {
                    "PrivatePort": port.get("TargetPort"),
                    "Type": port.get("Protocol") or "tcp",
                }
                for port in ((service.get("Endpoint") or {}).get("Ports") or [])
                if port.get("PublishedPort") and port.get("PublishMode") == "ingress"
            ]
        containers.append({
            "Id": task.get("ID", ""),
            "Labels": labels,
            "Ports": ports,
        })
    return containers


def service_icon(service, task_containers):
    spec = service["Spec"]
    name = spec["Name"]
    service_labels = spec.get("Labels") or {}
    service_icon_slug = icon_slug(service_labels.get("doc.icon"))
    members = []
    for container in task_containers:
        labels = container.get("Labels") or {}
        if labels.get("com.docker.swarm.service.name") == name:
            members.append((
                icon_slug(labels.get("doc.icon", service_icon_slug)),
                container_has_published_port(container, service),
                container.get("Id", ""),
            ))

    if not members:
        return service_icon_slug
    icons = {icon for icon, _, _ in members}
    if len(icons) == 1:
        return next(iter(icons))
    published = sorted(
        (member for member in members if member[1]),
        key=lambda member: (member[2], member[0]),
    )
    return published[0][0] if published else service_icon_slug


def has_published_port(service):
    return any(
        port.get("PublishedPort")
        for port in ((service.get("Endpoint") or {}).get("Ports") or [])
    )


class DockerConnection(http.client.HTTPConnection):
    def __init__(self, socket_path):
        super().__init__("localhost", timeout=10)
        self.socket_path = socket_path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.socket_path)


def read_docker_list(path):
    connection = DockerConnection(
        os.environ.get("DOCKER_SOCKET", "/var/run/docker.sock")
    )
    try:
        connection.request("GET", path)
        response = connection.getresponse()
        if response.status != 200:
            raise RuntimeError(f"Docker {path} discovery returned HTTP {response.status}")
        items = json.loads(response.read())
        if not isinstance(items, list):
            raise ValueError(f"Docker returned an invalid list for {path}")
        return items
    finally:
        connection.close()


def read_services():
    return read_docker_list("/services")


def short_name(name, labels):
    if name.startswith("ext:"):
        return name[4:]
    if name.startswith("stack:"):
        return name[6:]
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


def build_graph(services, swarm_nodes=None, tasks=(), task_containers=()):
    services_by_name = {service["Spec"]["Name"]: service for service in services}
    labels = {
        name: service["Spec"].get("Labels") or {}
        for name, service in services_by_name.items()
    }

    stacks = defaultdict(list)
    for name, lab in labels.items():
        stack = lab.get("com.docker.stack.namespace")
        if stack:
            stacks[f"stack:{stack}"].append(name)

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
            elif dependency.startswith("stack:") and dependency not in stacks:
                warnings.append(f"{name} depends on {dependency}, which is not a known stack")
            elif not dependency.startswith("ext:") and dependency not in labels and dependency not in stacks:
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

    for name, lab in sorted(labels.items()):
        dependents = sorted({
            value.strip() for value in lab.get("doc.used_by", "").split(",")
            if value.strip()
        })
        for dependent in dependents:
            targets = dependencies.setdefault(dependent, [])
            if name not in targets:
                targets.append(name)
                targets.sort()
                if dependent == name:
                    warnings.append(f"{name} depends on itself")
            used_by[name].add(dependent)
            if not dependent.startswith("ext:") and dependent not in labels and dependent not in stacks:
                warnings.append(
                    f"{name} is used by {dependent}, which is not a running service"
                )

    impact_used_by = {name: set(dependents) for name, dependents in used_by.items()}
    for stack, members in stacks.items():
        for member in members:
            impact_used_by.setdefault(member, set()).add(stack)

    service_icons = {
        name: service_icon(service, task_containers)
        for name, service in services_by_name.items()
    }
    stack_icons = {}
    for stack, members in stacks.items():
        candidates = sorted(
            (
                name,
                service_icons[name],
                has_published_port(services_by_name[name]),
            )
            for name in members
        )
        icons = {icon for _, icon, _ in candidates}
        if len(icons) == 1:
            stack_icons[stack] = next(iter(icons))
        else:
            published = [candidate for candidate in candidates if candidate[2]]
            stack_icons[stack] = (
                published[0][1] if published else candidates[0][1]
            ) if candidates else DEFAULT_ICON

    def impact(target):
        seen = {target}
        queue = deque([target])
        while queue:
            for dependent in impact_used_by.get(queue.popleft(), ()):
                if dependent not in seen:
                    seen.add(dependent)
                    queue.append(dependent)
        return seen - {target} - set(stacks)

    nodes = []
    targets = set(labels) | set(dependencies) | set(used_by) | set(implicit_used_by)
    for name in sorted(targets):
        direct = used_by.get(name, set()) - {name} - set(stacks)
        affected = impact(name)
        kind = "service" if name in labels else (
            "stack" if name in stacks else "external" if name.startswith("ext:") else "missing"
        )
        category = labels[name].get("doc.category", "uncategorized") if name in labels else kind
        categories = sorted({value.strip() for value in category.split(",") if value.strip()})
        if not categories:
            categories = ["uncategorized"]
        nodes.append({
            "id": name,
            "name": short_name(name, labels),
            "icon": service_icons.get(name, stack_icons.get(
                name,
                name[4:] if kind == "external" and ICON_SLUG.fullmatch(name[4:])
                else DEFAULT_ICON,
            )),
            "kind": kind,
            "stack": labels.get(name, {}).get("com.docker.stack.namespace"),
            "members": sorted(stacks.get(name, [])),
            "category": category,
            "categories": categories,
            "depends_on": dependencies.get(name, []),
            "used_by": sorted(direct),
            "transitive_impact": sorted(affected - direct),
            "impact_count": len(affected),
            "implicit_used_by": sorted(implicit_used_by.get(name, ())),
        })

    graph = {
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
        "stacks": [
            {
                "id": stack,
                "name": stack[6:],
                "members": sorted(members),
                "icon": stack_icons[stack],
            }
            for stack, members in sorted(stacks.items())
        ],
    }
    if swarm_nodes is not None:
        service_names = {service["ID"]: service["Spec"]["Name"] for service in services}
        node_ids = {node["ID"] for node in swarm_nodes}
        placements = sorted({
            (service_names[task["ServiceID"]], task["NodeID"])
            for task in tasks
            if task["Status"]["State"] == "running"
            and task.get("ServiceID") in service_names
            and task.get("NodeID") in node_ids
        })
        graph["swarm_nodes"] = [{
            "id": f"swarm-node:{node['ID']}",
            "name": node["Description"]["Hostname"],
            "kind": "swarm",
            "icon": DEFAULT_ICON,
            "category": "Swarm node",
            "categories": ["Swarm node"],
            "role": node["Spec"]["Role"],
            "state": node["Status"]["State"],
            "availability": node["Spec"]["Availability"],
            "depends_on": [],
            "used_by": [],
            "transitive_impact": [],
            "implicit_used_by": [],
            "impact_count": 0,
        } for node in sorted(swarm_nodes, key=lambda node: node["ID"])]
        graph["placement_edges"] = [
            {"source": name, "target": f"swarm-node:{node_id}"}
            for name, node_id in placements
        ]
    return graph


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/healthz":
            self.respond(200, b"ok\n", "text/plain")
        elif path == "/api/dependencies":
            try:
                services = read_services()
                tasks = read_docker_list("/tasks")
                task_containers = task_icon_containers(services, tasks)
                include_swarm = parse_qs(urlsplit(self.path).query).get("include_swarm_nodes") == ["true"]
                if include_swarm:
                    data = build_graph(
                        services,
                        read_docker_list("/nodes"),
                        tasks,
                        task_containers,
                    )
                else:
                    data = build_graph(
                        services,
                        tasks=tasks,
                        task_containers=task_containers,
                    )
            except (OSError, http.client.HTTPException, ValueError, KeyError,
                    TypeError, RuntimeError):
                logging.exception("Cannot read Swarm discovery data")
                self.respond(
                    503,
                    json.dumps({
                        "error": "Cannot read Swarm services. Check that the Docker "
                        "socket is accessible and this application is on a Swarm manager. "
                        "Task discovery requires access to /tasks. "
                        "When Show Swarm nodes is enabled, access to /nodes and /tasks "
                        "is also required."
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
                         "default-src 'self'; img-src 'self' https:; object-src 'none'; "
                         "base-uri 'none'; frame-ancestors 'none'")
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    port = int(os.environ.get("PORT", "8080"))
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    logging.info("Serving dependency map on port %s", port)
    server.serve_forever()
