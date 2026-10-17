const assert = require("node:assert/strict");
const {readFileSync} = require("node:fs");
const {test} = require("node:test");
const vm = require("node:vm");

function load() {
  const element = {addEventListener() {}};
  const context = vm.createContext({document: {getElementById: () => element}, URL});
  const source = readFileSync(`${__dirname}/../static/app.js`, "utf8")
    .replace(/refresh\(\);\s*$/, "");
  vm.runInContext(source, context);
  return context;
}

function components(edges) {
  const byName = new Map();
  const get = name => {
    if (!byName.has(name)) byName.set(name, {name, dependsOn: new Set()});
    return byName.get(name);
  };
  for (const [source, target] of edges) get(source).dependsOn.add(get(target));
  return byName;
}

test("dependencies sit to the right of the components using them", () => {
  const {rankComponents} = load();
  const byName = components([["web", "api"], ["api", "db"], ["admin", "db"]]);
  const rank = rankComponents([...byName.values()]);
  const column = name => rank.get(byName.get(name));
  assert.ok(column("web") < column("api"));
  assert.ok(column("api") < column("db"));
  assert.equal(column("admin"), column("db") - 1);
});

test("a cycle does not reverse dependencies leaving it", () => {
  const {rankComponents} = load();
  const byName = components([["a", "b"], ["b", "a"], ["a", "c"]]);
  const rank = rankComponents([...byName.values()]);
  const column = name => rank.get(byName.get(name));
  assert.ok(column("a") < column("c"));
  assert.ok(Number.isFinite(column("b")));
});
