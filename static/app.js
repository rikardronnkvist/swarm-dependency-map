"use strict";

let graph = null;
let selected = null;
const hiddenNodes = new Set();
const byId = new Map();
const positions = new Map();
let stopLayout = () => {};
const svgNamespace = "http://www.w3.org/2000/svg";
const element = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const svgElement = (tag, attributes = {}) => {
  const node = document.createElementNS(svgNamespace, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  return node;
};

const ICON_BASE = "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons";
const FALLBACK_ICON = "docker";
const ICON_SLUG = /^[a-z0-9-]+$/;
const ICON_URL = /^https:\/\/(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?::[1-9][0-9]{0,4})?(?:[/?#][^\s\\]*)?$/;
const iconUrls = new Map();
const probeImage = url => new Promise(resolve => {
  const image = new Image();
  image.referrerPolicy = "no-referrer";
  image.onload = () => resolve(true);
  image.onerror = () => resolve(false);
  image.src = url;
});

// The UI is dark-only, so try the "-light" variant first, SVG before PNG.
async function probeIcon(slug) {
  const candidates = [
    `${ICON_BASE}/svg/${slug}-light.svg`,
    `${ICON_BASE}/svg/${slug}.svg`,
    `${ICON_BASE}/png/${slug}.png`,
  ];
  for (const url of candidates) {
    if (await probeImage(url)) return url;
  }
  return null;
}

function resolveIcon(value) {
  let icon = FALLBACK_ICON;
  let directUrl = false;
  if (typeof value === "string" && ICON_SLUG.test(value)) {
    icon = value;
  } else if (typeof value === "string" && ICON_URL.test(value) && !/\s/.test(value)) {
    try {
      icon = new URL(value).href;
      directUrl = true;
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
    }
  }
  if (!iconUrls.has(icon)) {
    const resolved = directUrl
      ? probeImage(icon).then(loaded => loaded ? icon : null)
      : probeIcon(icon);
    iconUrls.set(icon, resolved.then(url => url || (
      icon === FALLBACK_ICON ? null : resolveIcon(FALLBACK_ICON))));
  }
  return iconUrls.get(icon);
}

function iconElement(slug, attributes) {
  const image = svgElement("image", {...attributes, "aria-hidden": "true"});
  image.setAttribute("referrerpolicy", "no-referrer");
  image.addEventListener("error", () => image.remove());
  resolveIcon(slug).then(url => {
    if (url) image.setAttribute("href", url);
    else image.remove();
  });
  return image;
}

function infoIconElement(slug) {
  const image = element("img", undefined, "info-icon");
  image.alt = "";
  image.referrerPolicy = "no-referrer";
  image.setAttribute("aria-hidden", "true");
  image.addEventListener("error", () => image.remove());
  resolveIcon(slug).then(url => {
    if (url) image.src = url;
    else image.remove();
  });
  return image;
}

function select(id) {
  selected = id;
  render();
}

// Columns read left to right: every component sits left of the components it depends on.
function rankComponents(members) {
  // Drop edges that close a cycle so ranks stay finite and other edges keep their direction.
  const forward = new Map(members.map(component => [component, []]));
  const state = new Map();
  const visit = a => {
    state.set(a, "open");
    for (const b of a.dependsOn) {
      if (!state.has(b)) visit(b);
      if (state.get(b) === "done") forward.get(a).push(b);
    }
    state.set(a, "done");
  };
  for (const component of members) if (!state.has(component)) visit(component);
  const rank = new Map(members.map(component => [component, 0]));
  for (let pass = 0; pass < members.length; pass++) {
    let changed = false;
    for (const a of members) {
      for (const b of forward.get(a)) {
        if (rank.get(b) <= rank.get(a)) { rank.set(b, rank.get(a) + 1); changed = true; }
      }
    }
    if (!changed) break;
  }
  // Pull pure consumers next to their nearest dependency instead of the far left edge.
  const used = new Set([...forward.values()].flat());
  for (const component of members) {
    const dependencies = forward.get(component);
    if (used.has(component) || !dependencies.length) continue;
    rank.set(component, Math.min(...dependencies.map(b => rank.get(b))) - 1);
  }
  return rank;
}

function renderGraph() {
  stopLayout();
  const root = document.getElementById("graph");
  root.replaceChildren();
  // Hosting links are optional and never change explicit dependency impact.
  const connectedIds = new Set(graph.edges.flatMap(edge => [edge.source, edge.target]));
  for (const stack of graph.stacks || []) {
    if (connectedIds.has(stack.id)) {
      for (const id of stack.members) connectedIds.add(id);
    }
  }
  const showNonDependant = document.getElementById("show-non-dependant").checked;
  const showNetworks = document.getElementById("show-networks").checked;
  const category = document.getElementById("category").value;
  const showSwarm = document.getElementById("show-swarm-nodes").checked;
  const swarmNode = showSwarm ? document.getElementById("swarm-node").value : "";
  const hostedServices = new Set((graph.placement_edges || [])
    .filter(edge => edge.target === swarmNode).map(edge => edge.source));
  const nodes = graph.nodes
    .filter(node => node.kind !== "stack")
    .filter(node => !hiddenNodes.has(node.id))
    .filter(node => node.id === selected || node.kind === "service" || connectedIds.has(node.id))
    .filter(node => node.id === selected || showNonDependant || connectedIds.has(node.id))
    .filter(node => node.id === selected || !category || node.categories.includes(category))
    .filter(node => node.id === selected || !swarmNode || hostedServices.has(node.id))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const serviceIds = new Set(nodes.map(node => node.id));
  const networkEdges = showNetworks
    ? (graph.network_edges || []).filter(edge => serviceIds.has(edge.source)
      && !hiddenNodes.has(edge.target)) : [];
  const visibleNetworkIds = new Set(networkEdges.map(edge => edge.target));
  nodes.push(...(graph.networks || []).filter(node => visibleNetworkIds.has(node.id)
    && !hiddenNodes.has(node.id)));
  const referencedStacks = new Set(graph.edges
    .filter(edge => serviceIds.has(edge.source) || serviceIds.has(edge.target))
    .flatMap(edge => [edge.source, edge.target]));
  const stackTargets = graph.nodes.filter(node => node.kind === "stack" && referencedStacks.has(node.id));
  // Empty, filtered stacks still need a layout anchor, but never a service card.
  nodes.push(...stackTargets.filter(stack => !nodes.some(node => node.stack === stack.name)));
  const placements = showSwarm
    ? (graph.placement_edges || []).filter(edge => serviceIds.has(edge.source)) : [];
  const hostIds = new Set(placements.map(edge => edge.target));
  if (showSwarm) {
    nodes.push(...(graph.swarm_nodes || []).filter(node =>
      swarmNode ? node.id === swarmNode || hostIds.has(node.id) : !category || hostIds.has(node.id)));
  }
  if (!nodes.length) {
    selected = null;
    root.append(element("p", graph.service_count
      ? "No services match these filters. Enable Show non-dependant or choose another category."
      : "No services found in this swarm."));
    return;
  }
  const nodeWidth = 230;
  const categoryBadges = new Map(nodes.map(node => {
    let right = nodeWidth - 8;
    let y = 35;
    const badges = node.categories.map(value => {
      const label = value.length > 28 ? `${value.slice(0, 26)}…` : value;
      const width = 16 + label.length * 7;
      if (right - width < 8) {
        right = nodeWidth - 8;
        y += 24;
      }
      const x = right - width;
      right = x - 6;
      return {label, x, y, width};
    });
    return [node.id, badges];
  }));
  const nodeHeight = Math.max(...[...categoryBadges.values()].map(badges =>
    badges[badges.length - 1].y + 29));
  const visibleIds = new Set(nodes.map(node => node.id));
  for (const stack of stackTargets) visibleIds.add(stack.id);
  const edges = [
    ...graph.edges.filter(edge => visibleIds.has(edge.source) && visibleIds.has(edge.target)),
    ...networkEdges.map(edge => ({...edge, kind: "network"})),
    ...placements.map(edge => ({...edge, kind: "placement"})),
  ];
  const stackById = new Map((graph.stacks || []).map(stack => [stack.id, stack]));
  const grouped = new Map();
  for (const node of nodes) {
    const stackId = node.kind === "stack" ? node.id : node.stack ? `stack:${node.stack}` : null;
    const key = stackId || node.id;
    if (!grouped.has(key)) grouped.set(key, {ids: [], stack: stackById.get(stackId)});
    grouped.get(key).ids.push(node.id);
  }
  for (const stack of stackTargets) {
    const component = grouped.get(stack.id);
    component.referenced = true;
  }
  const components = [...grouped.values()];
  const gap = 140;
  for (const component of components) {
    component.width = Math.max(300, Math.sqrt(component.ids.length) * 260);
    component.height = Math.max(160, Math.sqrt(component.ids.length) * (nodeHeight + 65));
    component.links = new Set();
    component.dependsOn = new Set();
  }
  const componentById = new Map(components.flatMap(c => c.ids.map(id => [id, c])));
  for (const edge of edges) {
    // Edges may target a stack whose members are visible, so fall back to the stack key.
    const a = componentById.get(edge.source) || grouped.get(edge.source);
    const b = componentById.get(edge.target) || grouped.get(edge.target);
    if (!a || !b || a === b) continue;
    a.links.add(b);
    b.links.add(a);
    a.dependsOn.add(b);
  }
  // Lay out each connected group of stacks separately, starting from its best-connected member.
  const clusters = [];
  const clustered = new Set();
  const byLinks = [...components].sort((a, b) =>
    b.links.size - a.links.size || b.ids.length - a.ids.length);
  for (const start of byLinks) {
    if (clustered.has(start)) continue;
    const members = [start];
    clustered.add(start);
    for (let i = 0; i < members.length; i++) {
      for (const next of members[i].links) {
        if (!clustered.has(next)) { clustered.add(next); members.push(next); }
      }
    }
    clusters.push(members);
  }
  for (const members of clusters) {
    const rank = rankComponents(members);
    const columns = [];
    for (const component of members) {
      const column = rank.get(component) - Math.min(...rank.values());
      (columns[column] ||= []).push(component);
    }
    const stackColumn = column => {
      let columnY = -(column.reduce((total, c) => total + c.height + gap / 2, 0) - gap / 2) / 2;
      for (const component of column) {
        component.y = columnY + component.height / 2;
        columnY += component.height + gap / 2;
      }
    };
    const filled = columns.filter(Boolean);
    filled.forEach(stackColumn);
    // Order each column by the average height of its neighbours to untangle crossing edges.
    for (let sweep = 0; sweep < 8; sweep++) {
      for (const column of filled) {
        const target = new Map(column.map(c => [c, c.links.size
          ? [...c.links].reduce((total, b) => total + b.y, 0) / c.links.size : c.y]));
        column.sort((a, b) => target.get(a) - target.get(b));
        stackColumn(column);
      }
    }
    // Interleave tall columns into side-by-side columns so wide screens are used.
    const area = members.reduce((total, c) => total + (c.width + gap) * (c.height + gap / 2), 0);
    const maxHeight = Math.max(...members.map(c => c.height), Math.sqrt(area / 1.6));
    let columnX = 0;
    for (const column of filled) {
      const height = column.reduce((total, c) => total + c.height + gap / 2, 0);
      const count = Math.min(column.length, Math.ceil(height / maxHeight));
      for (let part = 0; part < count; part++) {
        const split = column.filter((_, index) => index % count === part);
        const columnWidth = Math.max(...split.map(c => c.width));
        stackColumn(split);
        for (const component of split) component.x = columnX + columnWidth / 2;
        columnX += columnWidth + gap;
      }
    }
    members.left = Math.min(...members.map(c => c.x - c.width / 2));
    members.top = Math.min(...members.map(c => c.y - c.height / 2));
    members.width = Math.max(...members.map(c => c.x + c.width / 2)) - members.left;
    members.height = Math.max(...members.map(c => c.y + c.height / 2)) - members.top;
    members.size = members.reduce((total, c) => total + c.ids.length, 0);
  }
  // Connected groups come first; stacks without cross-stack dependencies trail at the end.
  clusters.sort((a, b) => (a.length > 1 ? 0 : 1) - (b.length > 1 ? 0 : 1)
    || b.size - a.size || b.width * b.height - a.width * a.height);
  const rowWidth = Math.max(1000, ...clusters.map(cluster => cluster.width),
    Math.sqrt(clusters.reduce((area, c) => area + (c.width + gap) * (c.height + gap), 0) * 1.5));
  let x = gap;
  let y = gap;
  let rowHeight = 0;
  let width = 1000;
  for (const cluster of clusters) {
    if (x > gap && x + cluster.width > rowWidth + gap) {
      x = gap;
      y += rowHeight + gap;
      rowHeight = 0;
    }
    for (const component of cluster) {
      component.x += x - cluster.left;
      component.y += y - cluster.top;
    }
    x += cluster.width + gap;
    rowHeight = Math.max(rowHeight, cluster.height);
    width = Math.max(width, x);
  }
  const height = Math.max(650, y + rowHeight + gap);
  const svg = svgElement("svg", {
    viewBox: `0 0 ${width} ${height}`, role: "group",
    "aria-label": "Service dependencies. Drag nodes to rearrange. Scroll to zoom.",
  });
  const defs = svgElement("defs");
  const marker = svgElement("marker", {
    id: "arrow", viewBox: "0 0 10 10", refX: 9, refY: 5,
    markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse",
  });
  marker.append(svgElement("path", {d: "M 0 0 L 10 5 L 0 10 z", fill: "#94a3b8"}));
  defs.append(marker);
  const activeMarker = marker.cloneNode(true);
  activeMarker.setAttribute("id", "arrow-active");
  activeMarker.firstElementChild.setAttribute("fill", "#38bdf8");
  defs.append(activeMarker);
  svg.append(defs);
  for (const component of components) {
    if (!component.stack || (component.stack.members.length < 2 && !component.referenced
      && !component.ids.some(id => byId.get(id)?.kind === "network"))) continue;
    const outline = svgElement("g", {class: "stack-group", "data-stack": component.stack.id});
    component.rect = svgElement("rect", {rx: 14});
    component.title = svgElement("text");
    component.title.textContent = component.stack.name;
    const title = svgElement("title");
    title.textContent = `Stack: ${component.stack.name}`;
    component.icon = iconElement(component.stack.icon, {width: 20, height: 20});
    outline.append(component.rect, component.icon, component.title, title);
    outline.setAttribute("tabindex", "0");
    outline.setAttribute("role", "button");
    outline.setAttribute("aria-label", `Stack: ${component.stack.name}`);
    let drag = null;
    let dragged = false;
    outline.addEventListener("click", event => {
      event.stopPropagation();
      if (!dragged) select(component.stack.id);
      dragged = false;
    });
    outline.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      event.stopPropagation();
      autoFit = false;
      drag = {point: pointer(event), startX: event.clientX, startY: event.clientY};
      dragged = false;
      for (const body of component.bodies) {
        body.pinned = true;
        body.vx = body.vy = 0;
      }
      outline.setPointerCapture(event.pointerId);
      outline.classList.add("dragging");
    });
    outline.addEventListener("pointermove", event => {
      if (!drag) return;
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 4) dragged = true;
      if (!dragged) return;
      const point = pointer(event);
      const dx = point.x - drag.point.x;
      const dy = point.y - drag.point.y;
      for (const body of component.bodies) {
        body.x += dx;
        body.y += dy;
      }
      component.x += dx;
      component.y += dy;
      drag.point = point;
      draw();
      restart();
    });
    const release = () => {
      if (!drag) return;
      drag = null;
      for (const body of component.bodies) body.pinned = false;
      outline.classList.remove("dragging");
      restart();
    };
    outline.addEventListener("pointerup", release);
    outline.addEventListener("pointercancel", release);
    outline.addEventListener("lostpointercapture", release);
    outline.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        select(component.stack.id);
      }
    });
    svg.append(outline);
  }
  if (!visibleIds.has(selected) && !components.some(component =>
    component.stack?.id === selected && component.rect)) selected = null;
  for (const id of positions.keys()) {
    if (!byId.has(id)) positions.delete(id);
  }
  nodes.forEach(node => {
    if (!positions.has(node.id)) {
      const component = componentById.get(node.id);
      const index = component.ids.indexOf(node.id);
      const angle = index * Math.PI * (3 - Math.sqrt(5));
      const radius = Math.sqrt((index + .5) / component.ids.length) * .4;
      positions.set(node.id, {
        x: component.x + Math.cos(angle) * radius * component.width,
        y: component.y + Math.sin(angle) * radius * component.height,
        vx: 0, vy: 0, pinned: false,
      });
    }
  });
  const links = [];
  const stackComponent = id => grouped.get(id)?.stack ? grouped.get(id) : null;
  for (const edge of edges) {
    const from = positions.get(edge.source);
    const to = positions.get(edge.target);
    const path = svgElement("path", {
      class: edge.kind === "placement"
        ? `edge placement${swarmNode && edge.target !== swarmNode ? " secondary" : ""}`
        : edge.kind === "network" ? "edge network" : "edge",
      ...(["placement", "network"].includes(edge.kind) ? {} : {"marker-end": "url(#arrow)"}),
      "data-source": edge.source, "data-target": edge.target,
    });
    const title = svgElement("title");
    title.textContent = edge.kind === "placement"
      ? `${edge.source} runs on ${byId.get(edge.target).name}`
      : edge.kind === "network"
        ? `${edge.source} is connected to ${byId.get(edge.target).name}`
        : `${edge.source} → ${edge.target}`;
    path.append(title);
    svg.append(path);
    const fromStack = stackComponent(edge.source);
    const toStack = stackComponent(edge.target);
    links.push({from, to, fromStack, toStack, path,
      internal: !fromStack && !toStack
        && componentById.get(edge.source) === componentById.get(edge.target)});
  }
  const groups = [];
  for (const node of nodes) {
    if (node.kind === "stack") continue;
    const position = positions.get(node.id);
    const group = svgElement("g", {
      class: `node ${node.kind}${node.kind === "swarm" && swarmNode && node.id !== swarmNode ? " secondary" : ""}`,
      tabindex: 0, role: "button",
      "data-id": node.id, "aria-label": node.id, "aria-pressed": "false",
    });
    group.append(svgElement("rect", {
      x: 0, y: 0, width: nodeWidth, height: nodeHeight, rx: 6, class: "node-body",
    }));
    group.append(iconElement(node.icon, {x: 8, y: 7, width: 22, height: 22}));
    const text = svgElement("text", {x: 36, y: 25});
    text.textContent = node.name.length > 21 ? `${node.name.slice(0, 19)}…` : node.name;
    group.append(text);
    for (const {label, x, y, width} of categoryBadges.get(node.id)) {
      const badge = svgElement("rect", {
        x, y, width, height: 20, rx: 8, class: "category-badge",
      });
      const category = svgElement("text", {
        x: x + 8, y: y + 14, class: "category-label",
      });
      category.textContent = label;
      group.append(badge, category);
    }
    const title = svgElement("title");
    title.textContent = node.kind === "swarm"
      ? `${node.name} (${node.role}, ${node.state}, ${node.availability})`
      : `${node.id} (${node.category}, ${node.kind})`;
    group.append(title);
    let drag = null;
    let dragged = false;
    group.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      event.stopPropagation();
      autoFit = false;
      const point = pointer(event);
      drag = {x: point.x - position.x, y: point.y - position.y,
        startX: event.clientX, startY: event.clientY};
      dragged = false;
      position.pinned = true;
      position.vx = position.vy = 0;
      group.setPointerCapture(event.pointerId);
      group.classList.add("dragging");
    });
    group.addEventListener("pointermove", event => {
      if (!drag) return;
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 4) dragged = true;
      if (!dragged) return;
      const point = pointer(event);
      position.x = point.x - drag.x;
      position.y = point.y - drag.y;
      draw();
      restart();
    });
    const release = () => {
      if (!drag) return;
      drag = null;
      position.pinned = false;
      group.classList.remove("dragging");
      restart();
    };
    group.addEventListener("pointerup", release);
    group.addEventListener("pointercancel", release);
    group.addEventListener("lostpointercapture", release);
    group.addEventListener("click", () => {
      if (!dragged) select(node.id);
      dragged = false;
    });
    group.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        select(node.id);
      }
    });
    svg.append(group);
    groups.push({position, group});
  }
  root.append(svg);

  function pointer(event) {
    return new DOMPoint(event.clientX, event.clientY).matrixTransform(svg.getScreenCTM().inverse());
  }

  let view = {x: 0, y: 0, width, height};
  let autoFit = true;
  const updateView = () => svg.setAttribute("viewBox", `${view.x} ${view.y} ${view.width} ${view.height}`);
  svg.addEventListener("wheel", event => {
    event.preventDefault();
    autoFit = false;
    const point = pointer(event);
    const nextWidth = Math.max(width / 4, Math.min(width * 2, view.width * (event.deltaY > 0 ? 1.1 : 1 / 1.1)));
    const scale = nextWidth / view.width;
    view = {x: point.x - (point.x - view.x) * scale,
      y: point.y - (point.y - view.y) * scale, width: nextWidth, height: view.height * scale};
    updateView();
  }, {passive: false});
  let pan = null;
  let panStart = null;
  let panned = false;
  svg.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    autoFit = false;
    pan = pointer(event);
    panStart = {x: event.clientX, y: event.clientY};
    panned = false;
    svg.setPointerCapture(event.pointerId);
  });
  svg.addEventListener("pointermove", event => {
    if (!pan) return;
    if (Math.hypot(event.clientX - panStart.x, event.clientY - panStart.y) > 4) panned = true;
    const point = pointer(event);
    view.x += pan.x - point.x;
    view.y += pan.y - point.y;
    updateView();
  });
  const endPan = () => { pan = null; };
  svg.addEventListener("pointerup", endPan);
  svg.addEventListener("pointercancel", endPan);
  svg.addEventListener("lostpointercapture", endPan);
  svg.addEventListener("click", event => {
    if (!panned && !event.target.closest(".node, .stack-group")) select(null);
  });

  function draw() {
    for (const component of components) {
      if (!component.rect) continue;
      const left = Math.min(...component.bodies.map(b => b.x)) - nodeWidth / 2 - 24;
      const top = Math.min(...component.bodies.map(b => b.y)) - nodeHeight / 2 - 48;
      component.rect.setAttribute("x", left);
      component.rect.setAttribute("y", top);
      component.rect.setAttribute("width",
        Math.max(...component.bodies.map(b => b.x)) + nodeWidth / 2 + 24 - left);
      component.rect.setAttribute("height",
        Math.max(...component.bodies.map(b => b.y)) + nodeHeight / 2 + 24 - top);
      component.icon.setAttribute("x", left + 14);
      component.icon.setAttribute("y", top + 9);
      component.title.setAttribute("x", left + 40);
      component.title.setAttribute("y", top + 25);
    }
    if (autoFit) {
      const left = Math.min(...bodies.map(b => b.x)) - nodeWidth / 2 - 80;
      const top = Math.min(...bodies.map(b => b.y)) - nodeHeight / 2 - 80;
      view = {
        x: left, y: top,
        width: Math.max(...bodies.map(b => b.x)) + nodeWidth / 2 + 80 - left,
        height: Math.max(...bodies.map(b => b.y)) + nodeHeight / 2 + 80 - top,
      };
      updateView();
    }
    for (const {position, group} of groups) {
      group.setAttribute("transform", `translate(${position.x - nodeWidth / 2} ${position.y - nodeHeight / 2})`);
    }
    const endpoint = (body, stack) => {
      if (!stack) return {x: body.x, y: body.y, width: nodeWidth + 8, height: nodeHeight + 8};
      const bounds = stack.rect.getBBox();
      return {x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2,
        width: bounds.width + 8, height: bounds.height + 8};
    };
    for (const {from, to, fromStack, toStack, path} of links) {
      const a = endpoint(from, fromStack);
      const b = endpoint(to, toStack);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const start = 1 / Math.max(Math.abs(dx) / (a.width / 2), Math.abs(dy) / (a.height / 2), .001);
      const end = 1 / Math.max(Math.abs(dx) / (b.width / 2), Math.abs(dy) / (b.height / 2), .001);
      path.setAttribute("d", `M ${a.x + dx * start} ${a.y + dy * start} L ${b.x - dx * end} ${b.y - dy * end}`);
    }
  }

  let frame = null;
  let energy = 1;
  const bodies = nodes.map(node => positions.get(node.id));
  for (const component of components) {
    component.bodies = component.ids.map(id => positions.get(id));
  }
  function tick(animate = true) {
    frame = null;
    for (let i = 0; i < bodies.length; i++) {
      const a = bodies[i];
      for (let j = i + 1; j < bodies.length; j++) {
        if (componentById.get(nodes[i].id) !== componentById.get(nodes[j].id)) continue;
        const b = bodies[j];
        const dx = b.x - a.x || .01;
        const dy = b.y - a.y || .01;
        const distance = Math.hypot(dx, dy);
        const force = Math.min(8, 12000 / (distance * distance)) * energy;
        const fx = dx / distance * force;
        const fy = dy / distance * force;
        if (!a.pinned) { a.vx -= fx; a.vy -= fy; }
        if (!b.pinned) { b.vx += fx; b.vy += fy; }
      }
    }
    for (const {from, to, internal} of links) {
      if (!internal) continue;
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const distance = Math.hypot(dx, dy) || 1;
      const force = (distance - 300) * .008 * energy;
      if (!from.pinned) { from.vx += dx / distance * force; from.vy += dy / distance * force; }
      if (!to.pinned) { to.vx -= dx / distance * force; to.vy -= dy / distance * force; }
    }
    for (const node of nodes) {
      const body = positions.get(node.id);
      const center = componentById.get(node.id);
      if (body.pinned) continue;
      body.vx = (body.vx + (center.x - body.x) * .01 * energy) * .75;
      body.vy = (body.vy + (center.y - body.y) * .01 * energy) * .75;
      body.x += Math.max(-18, Math.min(18, body.vx));
      body.y += Math.max(-18, Math.min(18, body.vy));
    }
    // Keep stack enclosures separate, including their headings and padding.
    for (let pass = 0; pass < 6; pass++) {
      const bounds = components.map(component => ({
        component,
        left: Math.min(...component.bodies.map(b => b.x)) - nodeWidth / 2 - 24,
        right: Math.max(...component.bodies.map(b => b.x)) + nodeWidth / 2 + 24,
        top: Math.min(...component.bodies.map(b => b.y)) - nodeHeight / 2 - 48,
        bottom: Math.max(...component.bodies.map(b => b.y)) + nodeHeight / 2 + 24,
      }));
      for (let i = 0; i < bounds.length; i++) {
        for (let j = i + 1; j < bounds.length; j++) {
          const a = bounds[i];
          const b = bounds[j];
          const overlapX = Math.min(a.right - b.left, b.right - a.left) + gap;
          const overlapY = Math.min(a.bottom - b.top, b.bottom - a.top) + gap;
          if (overlapX <= 0 || overlapY <= 0) continue;
          const axis = overlapX < overlapY ? "x" : "y";
          const direction = axis === "x"
            ? Math.sign(b.left + b.right - a.left - a.right) || 1
            : Math.sign(b.top + b.bottom - a.top - a.bottom) || 1;
          const aPinned = a.component.bodies.some(body => body.pinned);
          const bPinned = b.component.bodies.some(body => body.pinned);
          if (aPinned && bPinned) continue;
          const shift = (axis === "x" ? overlapX : overlapY) * direction;
          const aShift = aPinned ? 0 : bPinned ? -shift : -shift / 2;
          const bShift = bPinned ? 0 : aPinned ? shift : shift / 2;
          for (const body of a.component.bodies) body[axis] += aShift;
          for (const body of b.component.bodies) body[axis] += bShift;
          if (axis === "x") {
            a.left += aShift; a.right += aShift;
            b.left += bShift; b.right += bShift;
          } else {
            a.top += aShift; a.bottom += aShift;
            b.top += bShift; b.bottom += bShift;
          }
        }
      }
    }
    // Resolve rectangular collisions separately so cooling never leaves overlapping cards.
    for (let pass = 0; pass < 16; pass++) {
      for (let i = 0; i < bodies.length; i++) {
        for (let j = i + 1; j < bodies.length; j++) {
          const a = bodies[i];
          const b = bodies[j];
          const dx = b.x - a.x || .01;
          const dy = b.y - a.y || .01;
          const overlapX = nodeWidth + 24 - Math.abs(dx);
          const overlapY = nodeHeight + 24 - Math.abs(dy);
          if (overlapX <= 0 || overlapY <= 0 || (a.pinned && b.pinned)) continue;
          const share = a.pinned || b.pinned ? 1 : .5;
          const axis = overlapX < overlapY ? "x" : "y";
          const offset = (axis === "x" ? Math.sign(dx) * overlapX : Math.sign(dy) * overlapY) * share;
          if (!a.pinned) a[axis] -= offset;
          if (!b.pinned) b[axis] += offset;
        }
      }
    }
    energy *= .985;
    if (animate) {
      draw();
      if (energy > .003) frame = requestAnimationFrame(() => tick());
    }
  }
  function restart() {
    energy = 1;
    if (frame === null) frame = requestAnimationFrame(() => tick());
  }
  stopLayout = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    for (const body of bodies) body.pinned = false;
  };
  for (let step = 0; step < 120; step++) tick(false);
  draw();
  frame = requestAnimationFrame(() => tick());
}

function matches(node, query) {
  return [node.id, node.name, node.stack || "", ...node.categories, ...node.depends_on]
    .some(value => value.toLowerCase().includes(query));
}

function renderInfo() {
  const panel = document.getElementById("node-info");
  const node = byId.get(selected);
  const stack = (graph.stacks || []).find(stack => stack.id === selected);
  const hideButton = document.getElementById("hide-node");
  panel.hidden = !stack && !["service", "external", "network"].includes(node?.kind);
  if (panel.hidden) return;
  hideButton.hidden = Boolean(stack) || !node;
  const title = document.getElementById("node-info-title");
  title.replaceChildren(
    infoIconElement(stack?.icon || node?.icon || FALLBACK_ICON),
    document.createTextNode(stack ? stack.name : node.name),
  );
  const details = element("dl");
  const stacksById = new Map((graph.stacks || []).map(item => [item.id, item]));
  const add = (label, values, color, categories = false) => {
    details.append(element("dt", label, color ? `info-color ${color}` : undefined));
    const value = element("dd");
    if (Array.isArray(values) && values.length) {
      const list = element("ul");
      for (const id of values) {
        if (categories) {
          const item = element("li");
          const button = element("button", id, "info-related");
          button.type = "button";
          button.setAttribute("aria-pressed",
            String(document.getElementById("category").value === id));
          button.addEventListener("click", () => applyCategoryFilter(id));
          item.append(button);
          list.append(item);
          continue;
        }
        const relatedNode = byId.get(id);
        const relatedStack = stacksById.get(id);
        const item = element("li");
        const icon = infoIconElement(relatedNode?.icon || relatedStack?.icon || FALLBACK_ICON);
        icon.classList.add("info-list-icon");
        const name = element("span", relatedNode?.name || relatedStack?.name || id);
        if (relatedNode) {
          const link = element("button", undefined, "info-related");
          link.type = "button";
          link.setAttribute("aria-pressed", String(id === selected));
          link.classList.toggle("selected", id === selected);
          link.append(icon, name);
          link.addEventListener("click", () => select(id));
          item.append(link);
        } else {
          item.append(icon, name);
        }
        list.append(item);
      }
      value.append(list);
    } else {
      value.textContent = Array.isArray(values) ? "None" : values;
    }
    details.append(value);
  };
  add("Type", stack ? "Stack" : node.kind === "external" ? "External"
    : node.kind === "network" ? "Network" : "Service");
  if (stack) {
    add(`Services (${stack.members.length})`, stack.members, "dependency");
    const memberIds = new Set([stack.id, ...stack.members]);
    const members = stack.members.map(id => byId.get(id)).filter(Boolean);
    const dependencies = [...new Set(members.flatMap(member => member.depends_on))]
      .filter(id => !memberIds.has(id)).sort();
    const consumers = graph.edges.filter(edge => memberIds.has(edge.target))
      .map(edge => edge.source);
    const affected = [...new Set([
      ...consumers,
      ...(node ? [...node.used_by, ...node.transitive_impact] : []),
      ...members.flatMap(member => [...member.used_by, ...member.transitive_impact]),
    ])].filter(id => !memberIds.has(id)).sort();
    add("Depends on", dependencies, "dependency");
    add(`Affected services (${affected.length})`, affected, "impact");
  } else {
    add(node.kind === "network" ? "Network ID"
      : node.kind === "external" ? "External ID" : "Service ID", node.id);
    if (node.kind === "network") {
      add("Driver", node.driver);
      add("Scope", node.scope);
      add("Connected services", (graph.network_edges || [])
        .filter(edge => edge.target === node.id).map(edge => edge.source).sort());
    }
    if (node.kind === "service") {
      add("Stack", node.stack || "None");
      const hosts = [...new Set(graph.placement_edges
        .filter(edge => edge.source === node.id).map(edge => edge.target))]
        .sort((a, b) => byId.get(a).name.localeCompare(byId.get(b).name));
      add("Swarm nodes", hosts.length ? hosts : "No running tasks", "swarm");
    }
    add("Categories", node.categories, undefined, true);
    add("Depends on", node.depends_on, "dependency");
    add("Used by", node.used_by, "dependent");
    add("Transitive impact", node.transitive_impact, "transitive");
  }
  document.getElementById("node-info-content").replaceChildren(details);
}

function render() {
  if (!graph) return;
  renderInfo();
  const query = document.getElementById("search").value.toLowerCase().trim();
  const current = byId.get(selected);
  const affected = new Set(current ? [...current.used_by, ...current.transitive_impact] : []);
  const transitive = new Set(current?.transitive_impact || []);
  const impactPath = new Set([selected, ...affected]);
  for (const stack of graph.stacks || []) {
    if (stack.members.some(id => impactPath.has(id))) impactPath.add(stack.id);
  }
  for (const outline of document.querySelectorAll("#graph .stack-group")) {
    outline.classList.toggle("selected", outline.dataset.stack === selected);
    outline.classList.toggle("dependent", outline.dataset.stack !== selected
      && impactPath.has(outline.dataset.stack));
    const stack = (graph.stacks || []).find(stack => stack.id === outline.dataset.stack);
    outline.classList.toggle("transitive", outline.dataset.stack !== selected
      && Boolean(stack?.members.some(id => transitive.has(id)))
      && !stack.members.some(id => current?.used_by.includes(id)));
    outline.classList.toggle("dependency", Boolean(current?.depends_on.includes(outline.dataset.stack)));
    outline.setAttribute("aria-pressed", String(outline.dataset.stack === selected));
  }
  const hosted = new Set();
  if (document.getElementById("show-swarm-nodes").checked) {
    for (const edge of graph.placement_edges || []) {
      if (edge.source === selected) hosted.add(edge.target);
      if (edge.target === selected) hosted.add(edge.source);
    }
  }
  for (const group of document.querySelectorAll("#graph .node")) {
    const node = byId.get(group.dataset.id);
    group.classList.toggle("selected", node.id === selected);
    group.classList.toggle("dependent", node.id !== selected && affected.has(node.id));
    group.classList.toggle("transitive", node.id !== selected && transitive.has(node.id));
    group.classList.toggle("dependency", node.id !== selected && !affected.has(node.id)
      && Boolean(current && [...current.depends_on, ...(current.members || [])].includes(node.id)));
    group.classList.toggle("dimmed", !matches(node, query));
    group.classList.toggle("hosted", node.id !== selected && hosted.has(node.id));
    group.setAttribute("aria-pressed", String(node.id === selected));
  }
  for (const edge of document.querySelectorAll("#graph .edge")) {
    const direct = edge.dataset.source === selected || edge.dataset.target === selected;
    const impact = !edge.classList.contains("placement")
      && affected.has(edge.dataset.source) && impactPath.has(edge.dataset.target);
    edge.classList.toggle("active", direct || impact);
    edge.classList.toggle("indirect", impact && !direct);
  }
}

async function refresh() {
  const swarmCheckbox = document.getElementById("show-swarm-nodes");
  const swarmFilter = document.getElementById("swarm-node");
  const error = document.getElementById("error");
  swarmCheckbox.disabled = true;
  swarmFilter.disabled = true;
  error.hidden = true;
  try {
    const response = await fetch("/api/dependencies?include_swarm_nodes=true", {cache: "no-store"});
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not load dependencies.");
    graph = data;
    byId.clear();
    for (const node of [...graph.nodes, ...(graph.networks || []), ...(graph.swarm_nodes || [])]) {
      byId.set(node.id, node);
    }
    const previousSwarmNode = swarmFilter.value;
    const allNodes = element("option", "All nodes");
    allNodes.value = "";
    swarmFilter.replaceChildren(allNodes);
    for (const node of [...(graph.swarm_nodes || [])].sort((a, b) => a.name.localeCompare(b.name))) {
      const option = element("option", node.name);
      option.value = node.id;
      swarmFilter.append(option);
    }
    swarmFilter.value = (graph.swarm_nodes || []).some(node => node.id === previousSwarmNode)
      ? previousSwarmNode : "";
    const category = document.getElementById("category");
    const previousCategory = category.value;
    const categories = [...new Set(graph.nodes
      .filter(node => node.kind !== "stack").flatMap(node => node.categories))].sort();
    const allCategories = element("option", "All categories");
    allCategories.value = "";
    category.replaceChildren(allCategories);
    for (const value of categories) {
      const option = element("option", value);
      option.value = value;
      category.append(option);
    }
    category.value = categories.includes(previousCategory) ? previousCategory : "";
    if (!byId.has(selected) && !(graph.stacks || []).some(stack => stack.id === selected)) selected = null;
    renderGraph();
    render();
  } catch (failure) {
    error.textContent = failure.message;
    error.hidden = false;
  } finally {
    swarmCheckbox.disabled = false;
    swarmFilter.disabled = !swarmCheckbox.checked || !graph?.swarm_nodes;
  }
}

document.getElementById("close-info").addEventListener("click", () => select(null));
document.getElementById("hide-node").addEventListener("click", () => {
  if (!selected || !byId.has(selected)) return;
  hiddenNodes.add(selected);
  positions.delete(selected);
  selected = null;
  updateFilters();
});
document.getElementById("search").addEventListener("input", render);
function updateFilters() {
  if (!graph) return;
  renderGraph();
  render();
}
document.getElementById("show-non-dependant").addEventListener("change", updateFilters);
document.getElementById("show-networks").addEventListener("change", updateFilters);
document.getElementById("show-swarm-nodes").addEventListener("change", () => {
  stopLayout();
  positions.clear();
  refresh();
});
function applyCategoryFilter(value) {
  document.getElementById("category").value = value;
  positions.clear();
  updateFilters();
}
document.getElementById("category").addEventListener("change", event => {
  applyCategoryFilter(event.target.value);
});
document.getElementById("swarm-node").addEventListener("change", () => {
  positions.clear();
  updateFilters();
});
refresh();
