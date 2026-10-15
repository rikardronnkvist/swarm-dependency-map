"use strict";

let graph = null;
let selected = null;
const byId = new Map();
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
const names = ids => ids.map(id => byId.get(id)?.name || id).join(", ") || "–";

function select(id) {
  selected = id;
  render();
}

function renderDetails() {
  const details = document.getElementById("details");
  details.replaceChildren(element("h2", "Service details"));
  const node = byId.get(selected);
  if (!node) {
    details.append(element("p", "Select a node or a service in the table."));
    return;
  }
  details.append(element("h3", node.id));
  const list = element("dl");
  for (const [label, value] of [
    ["Category / type", `${node.category} / ${node.kind}`],
    ["Depends on", names(node.depends_on)],
    ["Used by", names(node.used_by)],
    ["Transitively affects", names(node.transitive_impact)],
    ["Via Traefik/Authentik", names(node.implicit_used_by)],
  ]) {
    list.append(element("dt", label), element("dd", value));
  }
  details.append(list);
}

function renderGraph(query) {
  const root = document.getElementById("graph");
  root.replaceChildren();
  // Derived-only targets belong in the impact table, not the explicit graph.
  const explicitTargets = new Set(graph.edges.map(edge => edge.target));
  const nodes = graph.nodes.filter(node => node.kind === "service" || explicitTargets.has(node.id));
  if (!nodes.length) {
    root.append(element("p", "No services found in this swarm."));
    return;
  }
  const categories = [...new Set(nodes.map(node => node.category))].sort();
  const positions = new Map();
  const width = Math.max(760, categories.length * 260);
  const height = Math.max(180, ...categories.map(category =>
    80 + nodes.filter(node => node.category === category).length * 70));
  const svg = svgElement("svg", {width, height, role: "group", "aria-label": "Dependencies by category"});
  const defs = svgElement("defs");
  const marker = svgElement("marker", {
    id: "arrow", viewBox: "0 0 10 10", refX: 9, refY: 5,
    markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse",
  });
  marker.append(svgElement("path", {d: "M 0 0 L 10 5 L 0 10 z", fill: "#94a3b8"}));
  defs.append(marker);
  svg.append(defs);
  categories.forEach((category, column) => {
    const x = column * (width / categories.length) + 15;
    const groupWidth = width / categories.length - 30;
    svg.append(svgElement("rect", {
      x, y: 10, width: groupWidth, height: height - 20, rx: 8, class: "category",
    }));
    const title = svgElement("text", {x: x + 10, y: 35, class: "category-title"});
    title.textContent = category;
    svg.append(title);
    nodes.filter(node => node.category === category).forEach((node, row) => {
      positions.set(node.id, {x: x + 10, y: 55 + row * 70, width: groupWidth - 20});
    });
  });
  for (const edge of graph.edges) {
    const from = positions.get(edge.source);
    const to = positions.get(edge.target);
    const active = edge.source === selected || edge.target === selected;
    const x1 = from.x + from.width;
    const y1 = from.y + 20;
    const x2 = to.x + to.width;
    const y2 = to.y + 20;
    const bend = from.x === to.x ? 20 : Math.abs(x1 - x2) / 3 + 20;
    const path = svgElement("path", {
      d: `M ${x1} ${y1} C ${x1 + bend} ${y1 - 25}, ${x2 + bend} ${y2 + 25}, ${x2} ${y2}`,
      class: active ? "edge active" : "edge", "marker-end": "url(#arrow)",
    });
    const title = svgElement("title");
    title.textContent = `${edge.source} → ${edge.target}`;
    path.append(title);
    svg.append(path);
  }
  const current = byId.get(selected);
  const affected = new Set(current ? [...current.used_by, ...current.transitive_impact] : []);
  for (const node of nodes) {
    const position = positions.get(node.id);
    const classes = ["node", node.kind];
    if (node.id === selected) classes.push("selected");
    else if (affected.has(node.id)) classes.push("dependent");
    else if (current?.depends_on.includes(node.id)) classes.push("dependency");
    if (!matches(node, query)) classes.push("dimmed");
    const group = svgElement("g", {
      class: classes.join(" "), tabindex: 0, role: "button",
      "aria-label": node.id, "aria-pressed": String(node.id === selected),
    });
    group.append(svgElement("rect", {...position, height: 40, rx: 6}));
    const text = svgElement("text", {x: position.x + 8, y: position.y + 25});
    text.textContent = node.name.length > 25 ? `${node.name.slice(0, 23)}…` : node.name;
    const title = svgElement("title");
    title.textContent = `${node.id} (${node.category}, ${node.kind})`;
    group.append(text, title);
    group.addEventListener("click", () => select(node.id));
    group.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        select(node.id);
      }
    });
    svg.append(group);
  }
  root.append(svg);
}

function matches(node, query) {
  return [node.id, node.name, node.category, ...node.depends_on]
    .some(value => value.toLowerCase().includes(query));
}

function render() {
  if (!graph) return;
  const query = document.getElementById("search").value.toLowerCase().trim();
  renderGraph(query);
  renderDetails();
  const tbody = document.getElementById("impact");
  tbody.replaceChildren();
  const sorted = [...graph.nodes].sort((a, b) =>
    b.impact_count - a.impact_count || a.id.localeCompare(b.id));
  for (const node of sorted.filter(node => matches(node, query))) {
    const row = element("tr");
    if (node.id === selected) row.className = "selected";
    const cell = element("td");
    const button = element("button", node.name);
    button.title = node.id;
    button.addEventListener("click", () => select(node.id));
    cell.append(button);
    row.append(cell);
    for (const value of [
      node.category, names(node.used_by), names(node.transitive_impact),
      node.impact_count, node.implicit_used_by.length || "–",
    ]) row.append(element("td", value));
    tbody.append(row);
  }
  if (!tbody.children.length) {
    const cell = element("td", "No matching services.");
    cell.colSpan = 6;
    const row = element("tr");
    row.append(cell);
    tbody.append(row);
  }
}

async function refresh() {
  const button = document.getElementById("refresh");
  const status = document.getElementById("status");
  const error = document.getElementById("error");
  button.disabled = true;
  error.hidden = true;
  status.textContent = "Loading services…";
  try {
    const response = await fetch("/api/dependencies", {cache: "no-store"});
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not load dependencies.");
    graph = data;
    byId.clear();
    for (const node of graph.nodes) byId.set(node.id, node);
    if (!byId.has(selected)) selected = null;
    render();
    const warnings = document.getElementById("warnings");
    warnings.replaceChildren();
    for (const warning of graph.warnings) warnings.append(element("li", warning));
    if (!graph.warnings.length) warnings.append(element("li", "No warnings."));
    status.textContent = `${graph.service_count} services · Updated ${new Date(graph.generated_at).toLocaleString()}`;
  } catch (failure) {
    error.textContent = failure.message;
    error.hidden = false;
    status.textContent = graph ? "Refresh failed. Showing last successful snapshot." : "No data loaded.";
  } finally {
    button.disabled = false;
  }
}

document.getElementById("refresh").addEventListener("click", refresh);
document.getElementById("search").addEventListener("input", render);
refresh();
