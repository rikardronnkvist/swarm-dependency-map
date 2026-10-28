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
Use `doc.depends_on: "stack:backend"` to depend on an entire stack instead of a
particular service. Stack membership comes exclusively from
`com.docker.stack.namespace`, not name prefixes. Arrows attach directly to the
stack enclosure, with no synthetic service card. Referenced stacks retain an
enclosure even with one service or when their members are filtered out.
Select the enclosure to highlight stack consumers and visible members.
Failure of any member affects services depending on
the stack and their transitive dependents. Synthetic stack targets are not counted
as impacted services; repeated paths are deduplicated and cycles terminate.
Unknown stacks are shown as missing targets with a warning. Membership contributes
to impact analysis but is not drawn as individual dependency arrows.
The JSON snapshot includes `stacks` with their member IDs, a `stack` field on
services, and `kind: "stack"` targets with `members` when explicitly referenced.
`doc.used_by` declares the same relationship in reverse: on a service,
`doc.used_by: "ext:homeassistant"` creates `ext:homeassistant -> service`.
It accepts comma-separated full service names or `ext:` names, ignoring whitespace,
empty entries, and duplicates. Relationships from both labels are merged and
deduplicated, and both participate in direct/transitive impact analysis.
Unknown non-`ext:` names produce missing-service warnings. An empty `doc.used_by`
declares no reverse relationships; it does not replace `doc.depends_on: ""`.

`doc.category` accepts comma-separated categories, for example `"apps,infra"`.
Whitespace, duplicates, and empty entries are ignored; missing or empty categories
default to `uncategorized`. Each category gets its own node badge and dropdown
entry; badges run horizontally from right to left and wrap to additional rows
when needed. A service appears under every assigned category. The JSON API exposes the
normalized `categories` array and retains the original `category` string.

`doc.icon` is a [homarr-labs/dashboard-icons](https://github.com/homarr-labs/dashboard-icons)
slug (for example `radarr`, no extension or `-light`/`-dark` suffix). The slug must match
`^[a-z0-9-]+$`. Alternatively, use an absolute HTTPS URL with a fully qualified hostname,
for example `doc.icon=https://kvitt.teambail.se/apple-touch-icon-v2.png`.
HTTP, embedded credentials and other URL schemes are rejected. Invalid or missing
values use `docker`. For slugs, the browser loads icons directly from the jsDelivr CDN (allowed in the CSP
`img-src`): `{slug}-light.svg`, then `{slug}.svg`, then `{slug}.png`, then the `docker`
icon. Direct URLs are loaded as-is, without variant or extension probing, and fall back
to `docker` on failure. Resolved URLs are cached per slug or URL and a failed icon never
breaks rendering. The JSON API exposes the validated slug or URL as `icon`. Custom images
are fetched by the browser, not the backend, with no referrer; CSP `img-src` permits
HTTPS image sources. This applies to graph nodes, stack icons and the info panel.

External nodes use the name after `ext:` as an icon slug when it matches
`^[a-z0-9-]+$`, for example `ext:plex` or `ext:home-assistant`. There are no
per-service aliases. Unknown icons fall back to `docker` using the same cached
SVG/PNG resolution as service icons.

Service metadata such as categories and dependencies is read from service labels
(`deploy.labels` / `Spec.Labels`), not `TaskTemplate.ContainerSpec.Labels`. For icon
selection only, running task container labels from `/tasks` are matched to their Swarm
service. If all running containers agree on `doc.icon`, that icon is used. When they
differ, a container with a published port is preferred. If the task icons differ but
none has a published port, or there are no running task icons, the service's `doc.icon`
is used.

Stack icons are derived from their member service icons. A shared member icon is used
when all services agree; otherwise a service with a published port is preferred, with
the first service by name used if none are published.

Dependency discovery reads Swarm service specifications, so services with zero
replicas are included. Running task data is also used for icon selection; optional host
placement adds node discovery.
Missing-target warnings mean a name is absent
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
read-only. The web UI issues discovery requests that read `GET /services`,
`GET /nodes`, `GET /tasks`, and `GET /networks`, including when **Show Swarm nodes**
is disabled.
Deploy it only in a trusted environment.
A restricted Docker socket proxy allowing these read endpoints is preferable
where available. The web UI/API have no built-in authentication
and expose service names and topology. Keep them private or protect them with an
authenticated reverse proxy, TLS, and firewall rules. Review the stack's
published port before exposing it beyond your trusted network.

## Interface and analysis

- The diagram fills the page, with all filters in a single row at the bottom.
  On narrow screens the filter row scrolls
  horizontally.
- Services are enclosed by blue-tinted stack frames, with each stack arranged as a separate
  force-directed group. Drag a stack's heading or background to move all its
  visible services together; individual cards remain independently draggable.
  Stacks with only one service have no enclosure unless
  the stack itself is referenced as a dependency endpoint.
  Services without a stack label, external targets, and
  Swarm hosts remain outside stack groups. Category and host filters still apply;
  referenced stack targets remain visible as context for filtered services.
- Force-directed dependency diagram: nodes within a stack repel, internal links
  attract, and collision avoidance separates cards. Stack groups have separate
  centers and spacing; cross-stack links do not stretch their contents apart.
  Each node has a small category badge,
  including external and missing targets. External nodes are muted pink with dashed
  borders; dependency and selection highlights override their normal colors.
  Drag nodes to rearrange, scroll to zoom,
  and drag the background to pan. Nodes can be dragged beyond the initial diagram
  bounds; forces resume when released. Selection and search preserve the layout.
- Search by service, category, or dependency; click a node to highlight its
  dependencies and affected services. The selected card or stack has a blue
  background, thick light-blue border, and glow. Direct impact is red; transitive
  impact is orange. Highlighted arrows include every step
  through transitive dependents, including stack dependency endpoints. Indirect
  links are thinner and dimmer than links touching the selected node; hosting
  links remain limited to the selected node.
- Clicking a service, external node, or stack opens a closable information panel in the lower
  right with dependencies and impact. Stack details also list member services;
  their impact combines failures of any member, excluding the stack's own members.
  Service details always list the Swarm hostnames with running tasks, regardless
  of **Show Swarm nodes** or the selected host filter. Multiple replicas on the
  same host produce one entry; services without running tasks are identified.
  Colored dots before headings match selection, dependency, and impact colors;
  combined stack impact uses a split red/orange dot.
  Click empty diagram space or Close to dismiss the panel and clear selection;
  dragging the background to pan keeps the selection.
- **Show non-dependant**, below the diagram, is unchecked by default. Enable it
  to include standalone services with neither incoming nor outgoing explicit
  dependencies. Services that others depend on remain visible.
- **Show Swarm nodes** is unchecked by default. Enable it to show manager/worker
  hosts as purple cards, with dashed purple hosting links to visible services
  that have running tasks on them. Replicas on the same host produce one link;
  services spanning hosts have one link per host. Stopped/pending tasks do not
  produce links. Hover a host for its role, state, and availability; select it to
  highlight its services. Hosting links do not affect dependency impact.
  Category and standalone-service filters still apply to services; with a category
  selected, only hosts running visible services are shown. Without a category,
  all Swarm hosts are shown, including idle hosts.
- **Show networks** is unchecked by default. Enable it to show networks attached
  to visible services, with dashed green links. Selecting a network shows its
  driver, scope, and connected services. Network links do not affect dependency
  impact.
- The **Swarm node** dropdown is enabled with **Show Swarm nodes**. Select a host
  to show only services with running tasks there. Other hosts running those same
  services remain visible with muted cards and hosting links; unrelated services
  on those hosts are not added.
  Category and standalone-service filters still apply. Changing host rebuilds the
  layout; reloading discovery preserves the selected host while it still exists.
- Search and the **Category** dropdown are below the diagram. Selecting a category
  filters the diagram to that category and edges between matching nodes; the standalone-service
  checkbox still applies. Changing category rebuilds the layout and resets zoom
  and pan. Clicking a category in the info panel applies the same filter while
  preserving the selected node and its highlight. **All categories** restores the
  unfiltered category view.
- Direct dependents, additional transitive dependents, and total explicit impact
  are available in the JSON API.
  Cycles terminate safely; a target is not counted as its own impacted service.
- Separate direct Traefik/Authentik counts in the JSON API: `traefik.enable=true` implies a
  dependency on `traefik_traefik` (except for Traefik itself). Traefik middleware
  label values containing `authentik` imply a dependency on `authentik_server`.
  These derived relationships are not drawn or included in transitive impact,
  and their counts can overlap explicit relationships.
- Warnings in the JSON API for missing `doc.depends_on`, self-dependencies, and unknown service
  targets. An explicitly empty dependency label produces no warning.
- Reload the page to re-read the current service specifications without restarting
  the application. Discovery errors are shown explicitly in the UI.

`GET /api/dependencies` returns the same snapshot as JSON. `GET /healthz` is a
process liveness check, not a Docker connectivity/readiness check. Discovery
failures return HTTP 503 with an actionable message; details go to server logs.
`GET /api/dependencies?include_swarm_nodes=true` also returns `swarm_nodes` and
`placement_edges`, populated from `/nodes` and `/tasks`. These endpoints are not
queried by the default API request without the query parameter. The web UI always
requests this expanded topology so service information can list hosts even when
their cards are hidden. Page load and changes to **Show Swarm nodes** re-read all
three resources. All API requests also read `/networks` for the optional network
view. Discovery failures
are explicit; no partial topology is returned.

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
