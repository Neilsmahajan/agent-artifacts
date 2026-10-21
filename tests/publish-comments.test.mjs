// Run: node --test <skill-dir>/tests/
//
// What a publish with comments on stages (a --dry-run, so nothing reaches
// Cloudflare): the /*/_comments/* route, a path-scoped connect-src for
// pipeline pages that later rules take away again from static pages, notes,
// hubs and /_share/, a per-page anchor manifest, and the hub-comments meta
// tag in the staged pipeline page only. Without a database id, none of it.
//
// Scratch dirs live under ~/.cache because the scripts refuse temp roots.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const skillDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = (name) => resolve(skillDir, "scripts", name);
const scratchParent = process.env.PUBLISH_TEST_SCRATCH || resolve(homedir(), ".cache", "publish-cloudflare-artifact-tests");
const HOST = "hub.example.dev";
const DB = "11111111-2222-4333-8444-555555555555";

let scratch;
const staged = [];

before(async () => {
  await mkdir(scratchParent, { recursive: true });
  scratch = await mkdtemp(resolve(scratchParent, "pubcomments-"));
});

after(async () => {
  for (const dir of [scratch, ...staged]) if (dir) await rm(dir, { recursive: true, force: true });
});

async function makeRoot(name, config) {
  const root = resolve(scratch, name);
  const page = resolve(root, "plan-page");
  const created = spawnSync(process.execPath, [script("create-artifact.mjs"), "--output", page], { encoding: "utf8" });
  assert.equal(created.status, 0, created.stderr);
  await writeFile(
    resolve(page, "artifact.json"),
    JSON.stringify({
      title: "Comments fixture",
      summary: "Fixture.",
      status: "Test fixture",
      updated: "2026-10-19",
      sections: [{ title: "Cash", paragraphs: ["One paragraph."], bullets: ["A bullet"] }],
    }),
  );
  const built = spawnSync(process.execPath, [script("build-artifact.mjs"), page], { encoding: "utf8" });
  assert.equal(built.status, 0, built.stderr);
  const stat = resolve(root, "static-page");
  await mkdir(stat, { recursive: true });
  await writeFile(resolve(stat, "index.html"), "<!doctype html><html><head><title>s</title></head><body>static</body></html>");
  await writeFile(resolve(stat, "static-artifact.json"), JSON.stringify({ title: "Static", summary: "s", status: "s", updated: "2026-10-19" }));
  await writeFile(
    resolve(root, "sharing.config.json"),
    JSON.stringify({
      project: "hub-test",
      hostname: HOST,
      accountId: "acct",
      kvNamespaceId: "0".repeat(32),
      teamDomain: "team.cloudflareaccess.com",
      owner: "owner@example.com",
      ...config,
    }),
  );
  return root;
}

function dryRun(root) {
  const result = spawnSync(process.execPath, [script("publish-pages.mjs"), "--root", root, "--project", "hub-test", "--dry-run", "--working-tree"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const dir = result.stdout.match(/staged site at (\S+)/)[1];
  staged.push(dir);
  return dir;
}

test("comments on: route, scoped CSP, manifest and meta", async () => {
  const site = dryRun(await makeRoot("on", { d1DatabaseId: DB, siteName: "test-hub", sourceRoot: "~/test-artifacts" }));
  const routes = JSON.parse(await readFile(resolve(site, "_routes.json"), "utf8"));
  assert.ok(routes.include.includes("/*/_comments/*"));

  const headers = await readFile(resolve(site, "_headers"), "utf8");
  const order = ["/*", "/:slug/*", "/notes/*", "/projects/*", "/_share/*", "/static-page/*"].map((rule) => headers.indexOf(`\n${rule}\n`) + 1 || headers.indexOf(`${rule}\n`) + 1);
  assert.ok(order.every((at) => at > 0), `every rule present: ${order}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, "later rules override the comments rule");
  const block = (rule) => headers.slice(headers.indexOf(`\n${rule}\n`)).split("\n\n")[0];
  assert.match(block("/:slug/*"), new RegExp(`connect-src https://${HOST.replace(/\./g, "\\.")}/:slug/_comments/;`));
  assert.equal(headers.split("connect-src 'self'").length, 2, "'self' appears once...");
  assert.match(block("/_share/*"), /connect-src 'self'/, "...on the Share screen only");
  for (const rule of ["/notes/*", "/projects/*", "/static-page/*"]) assert.match(block(rule), /connect-src 'none'/, rule);
  // Pages isolate their windows from static pages and /_link/ views.
  assert.match(block("/:slug/*"), /\n  Cross-Origin-Opener-Policy: same-origin/);
  assert.match(block("/static-page/*"), /\n  ! Cross-Origin-Opener-Policy/);
  // The Share screen's COOP replaces the pages' one and differs from it.
  assert.match(block("/_share/*"), /\n  ! Cross-Origin-Opener-Policy\n/);
  assert.match(block("/_share/*"), /\n  Cross-Origin-Opener-Policy: same-origin-allow-popups\n/);
  // A 404 under a mangled placeholder (/;/) still can't fetch or run script.
  assert.match(await readFile(resolve(site, "404.html"), "utf8"), /<meta http-equiv="Content-Security-Policy" content="connect-src 'none'; script-src 'none'"/);

  const manifest = JSON.parse(await readFile(resolve(site, "_share/comments/plan-page.json"), "utf8"));
  assert.ok(manifest.anchors.includes("title"));
  assert.ok(manifest.anchors.includes("sec-cash.p1"));
  assert.ok(manifest.anchors.includes("sec-cash.b1"));
  assert.equal(manifest.aud, undefined, "audiences are only added after the live audit");
  await assert.rejects(readFile(resolve(site, "_share/comments/static-page.json")), "no comments on static pages");

  const page = await readFile(resolve(site, "plan-page/index.html"), "utf8");
  assert.equal((page.match(/<meta name="hub-comments" content=/g) || []).length, 1);
  assert.match(page, new RegExp(`<meta name="hub-comments" content="https://${HOST.replace(/\./g, "\\.")}/plan-page/_comments/"></head>`));
  assert.match(page, /<meta name="hub-site" content="test-hub"><meta name="hub-source-root" content="~\/test-artifacts"><meta name="hub-comments" /);
  const staticPage = await readFile(resolve(site, "static-page/index.html"), "utf8");
  assert.doesNotMatch(staticPage, /<meta name="hub-(comments|site|source-root)"/);
});

test("comments off without a database id", async () => {
  const site = dryRun(await makeRoot("off", {}));
  const offPage = await readFile(resolve(site, "plan-page/index.html"), "utf8");
  assert.match(offPage, /<meta name="hub-site" content="hub-test">/, "siteName defaults to the project");
  assert.doesNotMatch(offPage, /<meta name="hub-source-root"/, "no sourceRoot configured");
  assert.ok(!JSON.parse(await readFile(resolve(site, "_routes.json"), "utf8")).include.includes("/*/_comments/*"));
  assert.doesNotMatch(await readFile(resolve(site, "_headers"), "utf8"), /_comments|:slug/);
  assert.doesNotMatch(await readFile(resolve(site, "plan-page/index.html"), "utf8"), /<meta name="hub-comments" content=/);
});

test("a malformed database id is refused", async () => {
  const root = await makeRoot("bad", { d1DatabaseId: "not-an-id" });
  const result = spawnSync(process.execPath, [script("publish-pages.mjs"), "--root", root, "--project", "hub-test", "--dry-run", "--working-tree"], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /d1DatabaseId/);
});
