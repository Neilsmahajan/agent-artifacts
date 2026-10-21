// Run: node --test <skill-dir>/tests/
//
// The /_link/ worker is the whole boundary for "anyone with the link" pages:
// Access lets /_link through without a login, so these tests pin down that a
// code serves exactly its page's files and nothing else — no traversal, no
// encoded tricks, no redirect out of /_link/, and the full header set.

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import worker, { resetManifestCache } from "../assets/pages-worker/index.js";

const ORIGIN = "https://hub.example";
const CODE = "A".repeat(20) + "b_-" + "9".repeat(20); // 43 chars
const STATIC_CODE = "s".repeat(43);
const ORPHAN_CODE = "o".repeat(43);

const files = {
  "/shared-page/": "<p>shared page</p>",
  "/shared-page/artifact.md": "# shared",
  "/static-page/": "<p>static</p>",
  "/static-page/photo.jpg": "JPEG",
  "/private-page/": "<p>PRIVATE</p>",
  "/shared-page-other/": "<p>PRIVATE neighbour</p>",
  "/_share/pages.json": JSON.stringify({
    pages: { "shared-page": { kind: "artifact" }, "static-page": { kind: "static" } },
  }),
};

const kv = new Map([
  [`code:${CODE}`, "shared-page"],
  [`code:${STATIC_CODE}`, "static-page"],
  [`code:${ORPHAN_CODE}`, "deleted-page"],
]);

const assetCalls = [];
const env = {
  LINKS: { get: async (key) => kv.get(key) ?? null },
  ASSETS: {
    async fetch(request) {
      const path = new URL(request.url).pathname;
      assetCalls.push(path);
      // Pages canonicalisation, as the asset server does it.
      if (path.endsWith("/index.html")) return new Response(null, { status: 308, headers: { Location: path.slice(0, -10) } });
      if (!path.endsWith("/") && files[path + "/"]) return new Response(null, { status: 308, headers: { Location: path + "/" } });
      if (path === "/shared-page/escape") return new Response(null, { status: 302, headers: { Location: "/private-page/" } });
      if (path === "/shared-page/offsite") return new Response(null, { status: 302, headers: { Location: "https://evil.example/" } });
      if (path in files) {
        const type = path.endsWith(".json") ? "application/json" : path.endsWith(".jpg") ? "image/jpeg" : "text/html";
        return new Response(files[path], { status: 200, headers: { "Content-Type": type, "Set-Cookie": "x=1" } });
      }
      return new Response("404 page", { status: 404 });
    },
  },
};

beforeEach(() => {
  resetManifestCache();
  assetCalls.length = 0;
});

function get(path, method = "GET") {
  return worker.fetch(new Request(ORIGIN + path, { method }), env);
}

async function body(response) {
  return response.status === 200 ? await response.text() : "";
}

test("a code serves its page with the full header set", async () => {
  const response = await get(`/_link/${CODE}/`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "<p>shared page</p>");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(response.headers.get("permissions-policy"), /camera=\(\)/);
  assert.match(response.headers.get("content-security-policy"), /^default-src 'none'.*connect-src 'none'/);
  assert.equal(response.headers.get("set-cookie"), null);
});

test("files inside the page are served; static pages get the static CSP", async () => {
  assert.equal(await body(await get(`/_link/${CODE}/artifact.md`)), "# shared");
  const photo = await get(`/_link/${STATIC_CODE}/photo.jpg`);
  assert.equal(photo.status, 200);
  assert.equal(photo.headers.get("content-type"), "image/jpeg");
  assert.match(photo.headers.get("content-security-policy"), /^default-src 'self'.*connect-src 'none'/);
});

test("HEAD returns headers without a body", async () => {
  const response = await get(`/_link/${CODE}/`, "HEAD");
  assert.equal(response.status, 200);
  assert.equal(response.body, null);
});

test("other methods are refused", async () => {
  assert.equal((await get(`/_link/${CODE}/`, "POST")).status, 405);
});

test("the bare code redirects to its trailing-slash form", async () => {
  const response = await get(`/_link/${CODE}`);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), `/_link/${CODE}/`);
});

test("asset canonical redirects stay under /_link/<code>/", async () => {
  const response = await get(`/_link/${CODE}/index.html`);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), `/_link/${CODE}/`);
});

test("asset redirects that leave the page are refused", async () => {
  assert.equal((await get(`/_link/${CODE}/escape`)).status, 404);
  assert.equal((await get(`/_link/${CODE}/offsite`)).status, 404);
});

test("unknown, revoked and orphaned codes are 404", async () => {
  assert.equal((await get(`/_link/${"z".repeat(43)}/`)).status, 404);
  assert.equal((await get(`/_link/${ORPHAN_CODE}/`)).status, 404);
});

test("a code never reaches a neighbouring or private page", async () => {
  for (const path of [
    `/_link/${CODE}/../private-page/`,
    `/_link/${CODE}/%2e%2e/private-page/`,
    `/_link/${CODE}/%2E%2E/private-page/`,
    `/_link/${CODE}/.%2e/private-page/`,
    `/_link/${CODE}/..%2fprivate-page/`,
    `/_link/${CODE}/..%5cprivate-page/`,
    `/_link/${CODE}/%2fprivate-page/`,
    `/_link/${CODE}//private-page/`,
    `/_link/${CODE}/.hidden`,
    `/_link/${CODE}-other/`,
  ]) {
    const response = await get(path);
    const text = await body(response);
    assert.doesNotMatch(text, /PRIVATE/, path);
    if (response.status === 302) {
      // Only allowed redirect target: an address outside /_link/, i.e. the login.
      assert.doesNotMatch(response.headers.get("location"), /^\/_link\//, path);
    }
  }
  assert.ok(!assetCalls.some((p) => p.startsWith("/private-page") || p.startsWith("/shared-page-other")));
});

test("raw dot segments are caught even though URL parsing resolves them", async () => {
  // new URL() turns /_link/CODE/../x into /_link/x — not a code, so it
  // redirects to the protected /x, never serves it.
  const response = await get(`/_link/${CODE}/../private-page/`);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/private-page/");
});

test("relative links out of a shared page go to the normal (login) address", async () => {
  for (const [path, location] of [
    ["/_link/other-page/", "/other-page/"],
    ["/_link/notes/ai-tooling/status/", "/notes/ai-tooling/status/"],
    ["/_link/", "/"],
    ["/_link", "/"],
  ]) {
    const response = await get(path);
    assert.equal(response.status, 302, path);
    assert.equal(response.headers.get("location"), location, path);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});

test("no open redirects", async () => {
  for (const path of ["/_link//evil.example/", "/_link/%2F%2Fevil.example/", "/_link/a//evil.example"]) {
    const response = await get(path);
    const location = response.headers.get("location") || "";
    assert.ok(!location.startsWith("//") && !/^[a-z]+:/i.test(location), `${path} → ${location}`);
  }
});

test("a missing manifest serves nothing", async () => {
  const saved = files["/_share/pages.json"];
  delete files["/_share/pages.json"];
  try {
    assert.equal((await get(`/_link/${CODE}/`)).status, 404);
  } finally {
    files["/_share/pages.json"] = saved;
  }
});
