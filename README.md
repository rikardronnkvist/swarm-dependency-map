# Swarm dependency map

A containerized, read-only web application for exploring Docker Swarm service
dependencies and the impact of a service failure. Uses Python's standard library;
no Docker CLI, database, CDN, or third-party Python packages are needed.

## Labels

Add labels to your stack's services:

```yaml
services:
  radarr:
    image: your-radarr-image
    deploy:
      labels:
        doc.category: media
        doc.depends_on: "prowlarr_prowlarr,bittorrent_qbittorrent,nzbget_nzbget,ext:internet"
```

Use full Swarm service names (`stack_service`) in `doc.depends_on`. Whitespace
and duplicate dependencies are ignored. Use `ext:` for dependencies outside
the swarm, and `doc.depends_on: ""` to explicitly declare no dependencies.
`doc.category` defaults to `uncategorized`.

Both service labels (`deploy.labels`) and container labels (`labels`) are read;
service labels take precedence when the same key appears in both places.
Discovery reads Swarm service specifications, not individual tasks, so services
with zero replicas are included. Missing-target warnings mean a name is absent
from Swarm, not that its tasks are unhealthy.

## Run on a Swarm manager

```sh
docker build -t swarm-dependency-map:latest .
docker run -d --name swarm-dependency-map \
  --publish 127.0.0.1:8080:8080 \
  --group-add "$(stat -c '%g' /var/run/docker.sock)" \
  --volume /var/run/docker.sock:/var/run/docker.sock:ro \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  swarm-dependency-map:latest
```

Open <http://localhost:8080>. The image runs as UID 10001; the socket's group is
added to permit Docker API access. These examples assume Linux and a rootful
Docker engine. For rootless Docker, mount the actual socket path instead.
The engine must be a **Swarm manager**: workers cannot list Swarm services.

For a stack deployment:

```sh
export DOCKER_GID="$(stat -c '%g' /var/run/docker.sock)"
docker stack deploy -c stack.yml dependency-map
```

The supplied stack schedules one replica on a manager and publishes port 8080
through the Swarm routing mesh. Ensure the image is available on every eligible
manager. For a multi-node swarm, publish the built image to your own registry
and set `DEPENDENCY_MAP_IMAGE` to that image before deploying. Socket group IDs
must match on eligible managers, or constrain deployment to a suitable node.

**Security:** Docker socket access is effectively host-administrator access,
even when the socket is mounted `:ro`; that flag does not make the Docker API
read-only. This application only issues `GET /services`, but deploy it only in a
trusted environment. A restricted Docker socket proxy allowing service listing
is preferable where available. The web UI/API have no built-in authentication
and expose service names and topology. Keep them private or protect them with an
authenticated reverse proxy, TLS, and firewall rules. Review the stack's
published port before exposing it beyond your trusted network.

## Interface and analysis

- Category-grouped dependency diagram, including external and missing targets.
- Search by service, category, or dependency; click a node or table entry for details.
- Direct dependents, additional transitive dependents, and total explicit impact.
  Cycles terminate safely; a target is not counted as its own impacted service.
- Separate direct Traefik/Authentik counts: `traefik.enable=true` implies a
  dependency on `traefik_traefik` (except for Traefik itself). Traefik middleware
  label values containing `authentik` imply a dependency on `authentik_server`.
  These derived relationships are not drawn or included in transitive impact,
  and their counts can overlap explicit relationships.
- Warnings for missing `doc.depends_on`, self-dependencies, and unknown service
  targets. An explicitly empty dependency label produces no warning.
- **Refresh** re-reads the current service specifications without restarting.
  If discovery fails, the UI marks the last successful snapshot as stale.

`GET /api/dependencies` returns the same snapshot as JSON. `GET /healthz` is a
process liveness check, not a Docker connectivity/readiness check. Discovery
failures return HTTP 503 with an actionable message; details go to server logs.

Configuration via environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP listening port (also update port mapping and image health check if changed) |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | Unix socket path inside the container |
| `TRAEFIK_SERVICE` | `traefik_traefik` | Target for derived Traefik relationships |
| `AUTHENTIK_SERVICE` | `authentik_server` | Target for derived Authentik relationships |

## Local development and tests

```sh
python3 app.py
python3 -m unittest discover -s tests -v
```

Tests use only the standard library, including a mock Docker Unix socket and a
local HTTP server; they do not require a running Docker daemon.
