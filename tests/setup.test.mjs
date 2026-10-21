// Run: node --test <skill-dir>/tests/
//
// scripts/setup.mjs against a stand-in for the Cloudflare API
// (setup-cloudflare-mock.mjs) and a fake npx that logs the secrets wrangler
// would be handed. It pins down that setup creates each resource once, fills
// in sharing.config.json without overwriting it, never prints a token, reports
// the manual steps as TODOs (exit 2), and that --check changes nothing.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, "../scripts/setup.mjs");
const mock = resolve(here, "setup-cloudflare-mock.mjs");

const OWNER = "owner@example.com";
const HOST = "hub.pages.dev";
const ACCESS_TOKEN = "access-token-value-never-printed";

const work = mkdtempSync(resolve(tmpdir(), "setup-cli-"));
after(() => rmSync(work, { recursive: true, force: true }));

// Fake npx and security: npx logs its arguments and stdin; security finds no
// Keychain item, so the real one on a developer's Mac is never read.
const bin = resolve(work, "bin");
mkdirSync(bin);
writeFileSync(resolve(bin, "npx"), '#!/bin/sh\nprintf "%s :: %s\\n" "$*" "$(cat)" >> "$NPX_LOG"\n');
writeFileSync(resolve(bin, "security"), "#!/bin/sh\nexit 44\n");
chmodSync(resolve(bin, "npx"), 0o755);
chmodSync(resolve(bin, "security"), 0o755);

const siteApp = {
  id: "app-site",
  name: "hub",
  aud: "site-aud",
  destinations: [
    { type: "public", uri: HOST },
    { type: "public", uri: `*.${HOST}` },
  ],
  policies: [{ decision: "allow", include: [{ email: { email: OWNER } }], exclude: [], require: [] }],
};

let dir;
let root;
let paths;
beforeEach(() => {
  dir = mkdtempSync(resolve(work, "case-"));
  root = resolve(dir, "root");
  mkdirSync(root);
  paths = { state: resolve(dir, "state.json"), d1: resolve(dir, "d1.sqlite"), npx: resolve(dir, "npx.log") };
  writeFileSync(paths.npx, "");
  setState({
    accessToken: ACCESS_TOKEN,
    accounts: [{ id: "acct" }],
    projects: { hub: { subdomain: HOST, secrets: [] } },
    kv: [],
    d1: [],
    workers: {},
    org: { auth_domain: "team.cloudflareaccess.com" },
    idps: [
      { id: "g", type: "google" },
      { id: "p", type: "onetimepin" },
    ],
    tags: [],
    apps: [siteApp],
    revoked: [],
    calls: [],
  });
});

const state = () => JSON.parse(readFileSync(paths.state, "utf8"));
function setState(value) {
  writeFileSync(paths.state, JSON.stringify(value));
}
const config = () => JSON.parse(readFileSync(resolve(root, "sharing.config.json"), "utf8"));

function run(args, { token = ACCESS_TOKEN } = {}) {
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, MOCK_STATE: paths.state, MOCK_D1: paths.d1, NPX_LOG: paths.npx, CLOUDFLARE_API_TOKEN: "account-token" };
  delete env.CF_ACCESS_TOKEN;
  if (token) env.CF_ACCESS_TOKEN = token;
  const result = spawnSync(process.execPath, ["--import", mock, cli, "--root", root, ...args], { env, encoding: "utf8" });
  const output = result.stdout + result.stderr;
  assert.ok(!output.includes(ACCESS_TOKEN), "a token was printed");
  return { status: result.status, output };
}

const BASE = ["--project", "hub", "--owner", "Owner@Example.com", "--owner-name", "Sam"];

test("a first run creates KV, D1 and the schema, writes the config and sets the Pages secret", () => {
  const { status, output } = run(BASE);
  assert.equal(status, 2, output);
  const s = state();
  assert.deepEqual(s.kv.map((ns) => ns.title), ["hub-links"]);
  assert.deepEqual(s.d1.map((db) => db.name), ["hub-comments"]);
  const tables = new DatabaseSync(paths.d1).prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
  assert.deepEqual(tables, ["comments", "endorsements", "threads"]);
  assert.deepEqual(config(), {
    project: "hub",
    siteName: "hub",
    sourceRoot: root,
    hostname: HOST,
    accountId: "acct",
    kvNamespaceId: s.kv[0].id,
    owner: OWNER,
    ownerName: "Sam",
    teamDomain: "team.cloudflareaccess.com",
    d1DatabaseId: s.d1[0].uuid,
  });
  // The /_link rule, its tag, and the scope probe (a made-up address).
  assert.ok(s.apps.some((app) => app.domain === `${HOST}/_link`));
  assert.deepEqual(s.tags.map((t) => t.name), ["per-page-sharing"]);
  assert.deepEqual(s.revoked, ["setup-scope-check@invalid.example"]);
  // The secret went to wrangler on stdin, and only the Access calls used the Access token.
  const [tokenPut, keyPut, ...more] = readFileSync(paths.npx, "utf8").trim().split("\n");
  assert.equal(tokenPut, `wrangler pages secret put ACCESS_API_TOKEN --project-name hub :: ${ACCESS_TOKEN}`);
  assert.match(keyPut, /^wrangler pages secret put SHARE_COOKIE_KEY --project-name hub :: [A-Za-z0-9_-]{43}$/);
  assert.ok(!output.includes(keyPut.split(" :: ")[1]), "the cookie key was printed");
  assert.deepEqual(more, []);
  assert.ok(s.calls.every((c) => (c.path.includes("/access/") ? c.auth === "access" : c.auth === "account")));
  // The revoker doesn't exist until the first publish.
  assert.match(output, /TODO  The hub-revoker Worker isn't deployed yet/);
  assert.match(output, /Publish again/);
});

test("a re-run creates nothing twice, and finishes once the revoker is deployed", () => {
  run(BASE);
  const first = config();
  const s = state();
  s.projects.hub.secrets = ["ACCESS_API_TOKEN", "SHARE_COOKIE_KEY"];
  s.workers["hub-revoker"] = { secrets: [] };
  setState(s);
  writeFileSync(paths.npx, "");
  const { status, output } = run([]);
  assert.equal(status, 0, output);
  assert.deepEqual(config(), first);
  const after = state();
  assert.equal(after.kv.length, 1);
  assert.equal(after.d1.length, 1);
  assert.equal(after.apps.filter((app) => app.domain === `${HOST}/_link`).length, 1);
  assert.equal(readFileSync(paths.npx, "utf8"), `wrangler secret put ACCESS_API_TOKEN --name hub-revoker :: ${ACCESS_TOKEN}\n`);
  assert.match(output, /Sharing and comments are set up/);
});

test("--check reports what it would do and changes nothing", () => {
  const { status, output } = run([...BASE, "--check"]);
  assert.equal(status, 2, output);
  assert.equal(existsSync(resolve(root, "sharing.config.json")), false);
  const s = state();
  assert.deepEqual(s.calls.filter((c) => c.method !== "GET"), []);
  assert.equal(readFileSync(paths.npx, "utf8"), "");
  assert.match(output, /would KV namespace hub-links/);
  assert.match(output, /would D1 database hub-comments/);
  assert.match(output, /would write sharing.config.json/);
});

test("without an Access token it lists the scopes to create one with", () => {
  const { status, output } = run(BASE, { token: null });
  assert.equal(status, 2, output);
  assert.match(output, /Access: Apps and Policies — Edit/);
  assert.match(output, /Access: Tags — Edit/);
  assert.match(output, /Access: Organizations, Identity Providers, and Groups — Edit/);
  assert.match(output, /security add-generic-password -a "\$USER" -s cf-access-share-mac -w/);
  // Only the cookie key, which needs no Access token.
  assert.match(readFileSync(paths.npx, "utf8"), /^wrangler pages secret put SHARE_COOKIE_KEY --project-name hub :: \S+\n$/);
  // KV and D1 don't need the Access token, so they're made anyway.
  assert.equal(config().kvNamespaceId, state().kv[0].id);
});

test("a token missing a scope, a missing login method and a public site are TODOs", () => {
  const s = state();
  s.denied = ["access/organizations/revoke_user"];
  s.idps = [{ id: "p", type: "onetimepin" }];
  s.apps = [];
  setState(s);
  const { status, output } = run(BASE);
  assert.equal(status, 2, output);
  assert.match(output, /Access sign-out \(revoke_user\): the Access token is missing a scope/);
  assert.match(output, /found 0 Google, 1 one-time PIN/);
  assert.match(output, /Sharing needs a private hub/);
  assert.ok(!state().apps.length, "the /_link rule waits for the site-wide app");
});

test("a value that disagrees with sharing.config.json is refused", () => {
  writeFileSync(resolve(root, "sharing.config.json"), JSON.stringify({ project: "hub", owner: "someone@example.com" }));
  const { status, output } = run(BASE);
  assert.equal(status, 1);
  assert.match(output, /already has owner = "someone@example.com"; edit it by hand/);
});
