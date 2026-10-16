const assert = require("node:assert/strict");
const {readFileSync} = require("node:fs");
const {test} = require("node:test");
const vm = require("node:vm");

class Element {
  constructor() {
    this.children = [];
    this.listeners = {};
    this.value = "";
    this.classList = {add() {}, toggle() {}};
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this[name] = value; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
}

test("info category click applies filter without selecting a same-named service", () => {
  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new Element());
      return elements.get(id);
    },
    createElement() { return new Element(); },
    createTextNode(text) { return {textContent: text}; },
  };
  const context = vm.createContext({document, URL});
  const source = readFileSync(`${__dirname}/../static/app.js`, "utf8")
    .replace(/refresh\(\);\s*$/, "");
  vm.runInContext(source, context);
  vm.runInContext(`
    infoIconElement = () => document.createElement("img");
    const service = {
      id: "web", name: "Web", kind: "service", categories: ["media", "apps"],
      depends_on: [], used_by: [], transitive_impact: [],
    };
    graph = {stacks: [], placement_edges: []};
    byId.set(service.id, service);
    byId.set("media", {id: "media", name: "Media service"});
    selected = service.id;
    positions.set("web", {});
    let renderedSelection;
    updateFilters = () => { renderedSelection = selected; };
    renderInfo();
  `, context);
  const details = elements.get("node-info-content").children[0];
  const labelIndex = details.children.findIndex(child => child.textContent === "Categories");
  const list = details.children[labelIndex + 1].children[0];
  const button = list.children[0].children[0];
  assert.equal(button.textContent, "media");
  button.listeners.click();
  assert.equal(elements.get("category").value, "media");
  assert.equal(vm.runInContext("selected", context), "web");
  assert.equal(vm.runInContext("renderedSelection", context), "web");
  assert.equal(vm.runInContext("positions.size", context), 0);
  vm.runInContext("renderInfo()", context);
  const updated = elements.get("node-info-content").children[0];
  const updatedIndex = updated.children.findIndex(child => child.textContent === "Categories");
  assert.equal(updated.children[updatedIndex + 1].children[0].children[0]
    .children[0]["aria-pressed"], "true");
});
