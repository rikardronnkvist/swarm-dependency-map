"use strict";

let graph = null;
let selected = null;
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

function select(id) {
  selected = id;
  render();
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
  const category = document.getElementById("category").value;
  const showSwarm = document.getElementById("show-swarm-nodes").checked;
  const swarmNode = showSwarm ? document.getElementById("swarm-node").value : "";
  const hostedServices = new Set((graph.placement_edges || [])
    .filter(edge => edge.target === swarmNode).map(edge => edge.source));
  const nodes = graph.nodes
    .filter(node => node.kind !== "stack")
    .filter(node => node.kind === "service" || connectedIds.has(node.id))
    .filter(node => showNonDependant || connectedIds.has(node.id))
    .filter(node => !category || node.categories.includes(category))
    .filter(node => !swarmNode || hostedServices.has(node.id))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const serviceIds = new Set(nodes.map(node => node.id));
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
  components.sort((a, b) => b.ids.length - a.ids.length);
  const gap = 140;
  for (const component of components) {
    component.width = Math.max(300, Math.sqrt(component.ids.length) * 260);
    component.height = Math.max(160, Math.sqrt(component.ids.length) * (nodeHeight + 65));
  }
  const rowWidth = Math.max(1000, components[0].width,
    Math.sqrt(components.reduce((area, c) => area + (c.width + gap) * (c.height + gap), 0) * 1.5));
  let x = gap;
  let y = gap;
  let rowHeight = 0;
  let width = 1000;
  for (const component of components) {
    if (x > gap && x + component.width > rowWidth + gap) {
      x = gap;
      y += rowHeight + gap;
      rowHeight = 0;
    }
    component.x = x + component.width / 2;
    component.y = y + component.height / 2;
    x += component.width + gap;
    rowHeight = Math.max(rowHeight, component.height);
    width = Math.max(width, x);
  }
  const height = Math.max(650, y + rowHeight + gap);
  const componentById = new Map(components.flatMap(c => c.ids.map(id => [id, c])));
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
    if (!component.stack || (component.stack.members.length < 2 && !component.referenced)) continue;
    const outline = svgElement("g", {class: "stack-group", "data-stack": component.stack.id});
    component.rect = svgElement("rect", {rx: 14});
    component.title = svgElement("text");
    component.title.textContent = component.stack.name;
    const title = svgElement("title");
    title.textContent = `Stack: ${component.stack.name}`;
    outline.append(component.rect, component.title, title);
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
    component.stack?.id === selected && component.stack.members.length > 1)) selected = null;
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
        ? `edge placement${swarmNode && edge.target !== swarmNode ? " secondary" : ""}` : "edge",
      ...(edge.kind === "placement" ? {} : {"marker-end": "url(#arrow)"}),
      "data-source": edge.source, "data-target": edge.target,
    });
    const title = svgElement("title");
    title.textContent = edge.kind === "placement"
      ? `${edge.source} runs on ${byId.get(edge.target).name}`
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
    const text = svgElement("text", {x: 8, y: 25});
    text.textContent = node.name.length > 25 ? `${node.name.slice(0, 23)}…` : node.name;
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
      component.title.setAttribute("x", left + 14);
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
  panel.hidden = !stack && node?.kind !== "service" && node?.kind !== "external";
  if (panel.hidden) return;
  document.getElementById("node-info-title").textContent = stack ? stack.name : node.name;
  const details = element("dl");
  const add = (label, values, color) => {
    details.append(element("dt", label, color ? `info-color ${color}` : undefined));
    const value = element("dd");
    if (Array.isArray(values) && values.length) {
      const list = element("ul");
      for (const id of values) list.append(element("li", byId.get(id)?.name || id));
      value.append(list);
    } else {
      value.textContent = Array.isArray(values) ? "None" : values;
    }
    details.append(value);
  };
  add("Type", stack ? "Stack" : node.kind === "external" ? "External" : "Service");
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
    add(node.kind === "external" ? "External ID" : "Service ID", node.id);
    if (node.kind === "service") add("Stack", node.stack || "None");
    add("Categories", node.categories);
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
  const button = document.getElementById("refresh");
  const swarmCheckbox = document.getElementById("show-swarm-nodes");
  const swarmFilter = document.getElementById("swarm-node");
  const error = document.getElementById("error");
  button.disabled = true;
  swarmCheckbox.disabled = true;
  swarmFilter.disabled = true;
  error.hidden = true;
  try {
    const url = swarmCheckbox.checked ? "/api/dependencies?include_swarm_nodes=true" : "/api/dependencies";
    const response = await fetch(url, {cache: "no-store"});
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not load dependencies.");
    graph = data;
    byId.clear();
    for (const node of [...graph.nodes, ...(graph.swarm_nodes || [])]) byId.set(node.id, node);
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
    button.disabled = false;
    swarmCheckbox.disabled = false;
    swarmFilter.disabled = !swarmCheckbox.checked || !graph?.swarm_nodes;
  }
}

document.getElementById("refresh").addEventListener("click", refresh);
document.getElementById("close-info").addEventListener("click", () => select(null));
document.getElementById("search").addEventListener("input", render);
function updateFilters() {
  if (!graph) return;
  renderGraph();
  render();
}
document.getElementById("show-non-dependant").addEventListener("change", updateFilters);
document.getElementById("show-swarm-nodes").addEventListener("change", () => {
  stopLayout();
  positions.clear();
  refresh();
});
document.getElementById("category").addEventListener("change", () => {
  positions.clear();
  updateFilters();
});
document.getElementById("swarm-node").addEventListener("change", () => {
  positions.clear();
  updateFilters();
});
refresh();
