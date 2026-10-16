const assert = require("node:assert/strict");
const {readFileSync} = require("node:fs");
const {test} = require("node:test");
const vm = require("node:vm");

const source = readFileSync(`${__dirname}/../static/app.js`, "utf8")
  .split("function select(id)")[0];

function resolver(available) {
  const requests = [];
  class Image {
    set src(url) {
      requests.push(url);
      queueMicrotask(() => available.has(url) ? this.onload() : this.onerror());
    }
  }
  const context = vm.createContext({Image, URL, TypeError});
  vm.runInContext(source, context);
  return {resolve: context.resolveIcon, requests};
}

test("HTTPS URLs load directly and share the resolution cache", async () => {
  const url = "https://icons.example.com/icon.png?v=2";
  const {resolve, requests} = resolver(new Set([url]));
  assert.deepEqual(await Promise.all([resolve(url), resolve(url)]), [url, url]);
  assert.deepEqual(requests, [url]);
});

test("failed HTTPS images fall back to the Docker icon", async () => {
  const fallback = "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/docker.svg";
  const {resolve, requests} = resolver(new Set([fallback]));
  assert.equal(await resolve("https://icons.example.com/missing.png"), fallback);
  assert.equal(requests[0], "https://icons.example.com/missing.png");
});

test("unsafe or invalid URLs are never requested", async () => {
  const fallback = "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/docker.svg";
  for (const url of [
    "http://icons.example.com/icon.png", "javascript:alert(1)",
    "data:image/png;base64,AA", "//icons.example.com/icon.png",
    "https://user:password@icons.example.com/icon.png",
    "https://icons.example.com:65536/icon.png",
    "https://icons.example.com/icon.png\n",
  ]) {
    const {resolve, requests} = resolver(new Set([fallback]));
    assert.equal(await resolve(url), fallback);
    assert.ok(!requests.includes(url));
  }
});

test("slugs still try variants and PNG and cache the result", async () => {
  const png = "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/example.png";
  const {resolve, requests} = resolver(new Set([png]));
  assert.equal(await resolve("example"), png);
  assert.equal(await resolve("example"), png);
  assert.equal(requests.length, 3);
});

test("unknown external names fall back to Docker and are cached", async () => {
  const fallback = "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/docker.svg";
  const {resolve, requests} = resolver(new Set([fallback]));
  assert.equal(await resolve("unknown-external"), fallback);
  const count = requests.length;
  assert.equal(await resolve("unknown-external"), fallback);
  assert.equal(requests.length, count);
});
