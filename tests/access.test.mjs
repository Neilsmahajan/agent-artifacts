// Run: node --test <skill-dir>/tests/
//
// The Access audit is what makes per-page sharing fail closed: any rule on the
// hub that isn't one of the three known shapes must be reported. These tests
// feed it the shapes the Cloudflare API returns (as seen on Oct 1, 2026).

import assert from "node:assert/strict";
import { test } from "node:test";

import { auditApps, linkAppBody, normalizeEmail, pageAppBody, prefixProblems, TAG } from "../assets/pages-worker/access.mjs";

const host = "hub.example.dev";
const owner = "owner@example.com";
const idps = ["google-id", "otp-id"];
const published = new Set(["page-a", "page-b"]);

const site = {
  id: "site",
  name: "hub",
  destinations: [
    { type: "public", uri: `*.${host}` },
    { type: "public", uri: host },
  ],
  policies: [{ decision: "allow", include: [{ email: { email: owner } }], exclude: [], require: [] }],
};

// What Cloudflare returns for an app created from our own request body.
const stored = (body, id) => ({ id, ...body, policies: body.policies.map((p) => ({ ...p, reusable: false })) });
const page = (slug, guests = ["guest@example.com"]) =>
  stored(pageAppBody({ host, slug, owner, guests, idps }), `page-${slug}`);
const link = stored(linkAppBody({ host }), "link");
const other = { id: "other", name: "elsewhere", destinations: [{ type: "public", uri: "other.example.dev" }], policies: [] };

const audit = (apps, published_ = published) => auditApps(apps, { host, owner, publishedSlugs: published_, guestIdps: idps });

test("the known shapes pass, and unrelated apps are ignored", () => {
  const result = audit([site, page("page-a"), link, other]);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.pages.get("page-a").guests, ["guest@example.com"]);
  assert.equal(result.link.id, "link");
});

test("a missing or widened site-wide rule fails", () => {
  assert.match(audit([]).problems.join(), /No conforming site-wide/);
  const wide = structuredClone(site);
  wide.policies[0].include.push({ everyone: {} });
  assert.match(audit([wide]).problems.join(), /exactly owner@example.com/);
  const extra = structuredClone(site);
  extra.policies[0].include.push({ email: { email: "someone@example.com" } });
  assert.match(audit([extra]).problems.join(), /exactly owner@example.com/);
});

test("path overrides and the preflight bypass fail on any app on the host", () => {
  const overridden = structuredClone(site);
  overridden.destinations[1].overrides = [{ behavior: "public", path_pattern: "/page-a/*" }];
  assert.match(audit([overridden, page("page-a")]).problems.join(), /path overrides/);
  assert.match(audit([overridden]).problems.join(), /No conforming site-wide/);
  const pageOverride = page("page-a");
  pageOverride.destinations[0].overrides = [{ behavior: "public", path_pattern: "/page-a/x" }];
  assert.match(audit([site, pageOverride]).problems.join(), /path overrides/);
  assert.match(audit([site, { ...link, options_preflight_bypass: true }]).problems.join(), /OPTIONS preflight bypass/);
  // An empty list is what Cloudflare may return for an app without any.
  const empty = structuredClone(site);
  empty.destinations[0].overrides = [];
  assert.deepEqual(audit([empty]).problems, []);
});

test("an untagged rule on the host fails", () => {
  const manual = { ...page("page-a"), tags: [] };
  assert.match(audit([site, manual]).problems.join(), /untagged/);
});

test("a rule for a page that isn't published fails (orphan)", () => {
  assert.match(audit([site, page("gone-page")]).problems.join(), /not a published page/);
  // null skips the orphan check, so unshare can still remove it
  assert.deepEqual(audit([site, page("gone-page")], null).problems, []);
});

test("page rules may only grant plain emails including the owner", () => {
  for (const include of [[{ everyone: {} }], [{ email_domain: { domain: "example.com" } }], [{ group: { id: "g" } }], [{ email: { email: "guest@example.com" } }]]) {
    const app = page("page-a");
    app.policies[0].include = include;
    assert.match(audit([site, app]).problems.join(), /plain emails including the owner/, JSON.stringify(include));
  }
  const bypass = page("page-a");
  bypass.policies[0].decision = "bypass";
  assert.ok(audit([site, bypass]).problems.length);
  const two = page("page-a");
  two.policies.push(two.policies[0]);
  assert.ok(audit([site, two]).problems.length);
});

test("page rules must cover exactly one plain page path", () => {
  for (const uri of [`${host}/page-a/*`, `${host}/page-a/`, `${host}/page-a/sub`, `*.${host}/page-a`, `${host}/PAGE%2Da`, `${host}`]) {
    const app = page("page-a");
    app.destinations = [{ type: "public", uri }];
    assert.ok(audit([site, app]).problems.length, uri);
  }
  const twoDest = page("page-a");
  twoDest.destinations.push({ type: "public", uri: `${host}/page-b` });
  assert.match(audit([site, twoDest]).problems.join(), /unexpected destinations/);
});

test("page rules must use the guest login methods and session settings", () => {
  const idp = { ...page("page-a"), allowed_idps: ["google-id"] };
  assert.match(audit([site, idp]).problems.join(), /login methods/);
  const session = { ...page("page-a"), session_duration: "730h" };
  assert.match(audit([site, session]).problems.join(), /session/);
  const cookie = { ...page("page-a"), path_cookie_attribute: false };
  assert.match(audit([site, cookie]).problems.join(), /session/);
});

test("duplicate rules fail", () => {
  assert.match(audit([site, page("page-a"), { ...page("page-a"), id: "dup" }]).problems.join(), /second rule/);
  assert.match(audit([site, link, { ...link, id: "dup" }]).problems.join(), /second \/_link/);
});

test("the /_link rule must be a single bypass for everyone", () => {
  const allowLink = structuredClone(link);
  allowLink.policies[0].decision = "allow";
  assert.match(audit([site, allowLink]).problems.join(), /single Bypass/);
  const wildcard = structuredClone(link);
  wildcard.destinations = [{ type: "public", uri: `${host}/_link*` }];
  assert.ok(audit([site, wildcard]).problems.length);
  const root = structuredClone(link);
  root.destinations = [{ type: "public", uri: `${host}/_lin` }];
  assert.ok(audit([site, root]).problems.length);
});

test("rules on preview hostnames are caught", () => {
  const preview = page("page-a");
  preview.destinations = [{ type: "public", uri: `abc123.${host}/page-a` }];
  assert.ok(audit([site, preview]).problems.length);
});

test("legacy apps without destinations are still checked, and fail closed", () => {
  const legacy = { ...page("page-a") };
  delete legacy.destinations;
  legacy.self_hosted_domains = [`${host}/page-a`];
  legacy.domain = `${host}/page-a`;
  assert.ok(audit([site, legacy]).problems.length > 0);
});

test("prefix overlaps are refused", () => {
  assert.deepEqual(prefixProblems(["page-a"], ["page-a", "page-b", "notes"]), []);
  assert.match(prefixProblems(["page-a"], ["page-a", "page-a-other"]).join(), /prefix of \/page-a-other/);
  assert.match(prefixProblems(["page"], ["Page-two"]).join(), /prefix/);
});

test("emails are normalized and validated", () => {
  assert.equal(normalizeEmail("  Pat@Example.NET "), "pat@example.net");
  for (const bad of ["", "mom", "a@b", "a b@c.com", "a@b.com,c@d.com", "<a@b.com>"]) {
    assert.throws(() => normalizeEmail(bad), /Not an email/, bad);
  }
});

test("rule bodies carry the tag and the generic name", () => {
  const body = pageAppBody({ host, slug: "page-a", owner, guests: ["X@Y.com"], idps });
  assert.ok(body.tags.includes(TAG));
  assert.doesNotMatch(body.name, /page-a/);
  assert.deepEqual(body.policies[0].include, [{ email: { email: owner } }, { email: { email: "x@y.com" } }]);
  assert.throws(() => pageAppBody({ host, slug: "../x", owner, guests: [], idps }));
});

test("shareable pages never include generated paths or invalid slugs", async () => {
  const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { resolve } = await import("node:path");
  const { pageSlugs } = await import("../scripts/sharing.mjs");
  const root = mkdtempSync(resolve(tmpdir(), "page-slugs-"));
  try {
    for (const name of ["page-a", "projects", "notes", "_link", "archive", "Bad_Name"]) {
      mkdirSync(resolve(root, name));
      writeFileSync(resolve(root, name, "index.html"), "<!doctype html>");
      writeFileSync(resolve(root, name, "artifact.json"), "{}");
    }
    assert.deepEqual([...(await pageSlugs(root))], ["page-a"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
