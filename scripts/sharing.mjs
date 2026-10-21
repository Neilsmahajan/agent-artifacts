// Shared plumbing for per-page sharing: the site config, the Keychain token,
// link codes in Workers KV (through the wrangler login), and the full audit
// that share.mjs and publish-pages.mjs both run.

import { spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { AccessClient, auditApps, prefixProblems } from "./access.mjs";

// Top-level paths every hub publish generates besides page directories.
export const GENERATED_PATHS = ["notes", "projects", "index.html", "index.json", "llms.txt", "robots.txt", "404.html", "_share", "_link"];

export async function loadConfig(rootDir) {
  const config = JSON.parse(await readFile(resolve(rootDir, "sharing.config.json"), "utf8"));
  for (const key of ["project", "hostname", "accountId", "kvNamespaceId", "owner"]) {
    if (!config[key]) throw new Error(`sharing.config.json is missing ${key}`);
  }
  // The project's pages.dev address: the audit covers one hostname, so
  // sharing never runs on a custom domain (publish checks it's the only one).
  if (!/^[a-z0-9-]+\.pages\.dev$/.test(config.hostname)) throw new Error("sharing.config.json: hostname must be the project's <name>.pages.dev address");
  return config;
}

// Pages a rule or link may point at: artifact directories with a built page.
export async function pageSlugs(rootDir) {
  const slugs = new Set();
  for (const entry of await readdir(rootDir, { withFileTypes: true })) {
    // Only valid slugs, never a generated path (notes, projects, ...): a rule on
    // /projects would cover every project hub, which publish never stages
    // from the root.
    if (!entry.isDirectory() || !/^[a-z0-9][a-z0-9-]*$/.test(entry.name) || entry.name === "archive" || GENERATED_PATHS.includes(entry.name)) continue;
    const dir = resolve(rootDir, entry.name);
    const has = (name) => stat(resolve(dir, name)).then(() => true, () => false);
    if ((await has("index.html")) && ((await has("artifact.json")) || (await has("static-artifact.json")))) slugs.add(entry.name);
  }
  return slugs;
}

export function capture(cmd, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolvePromise(out) : reject(new Error(`${cmd} ${args.slice(0, 3).join(" ")} failed: ${err.trim()}`))));
  });
}

export async function accessToken() {
  if (process.env.CF_ACCESS_TOKEN) return process.env.CF_ACCESS_TOKEN;
  try {
    return (await capture("security", ["find-generic-password", "-s", "cf-access-share-mac", "-w"])).trim();
  } catch {
    throw new Error("No Access API token: Keychain item cf-access-share-mac is missing (or set CF_ACCESS_TOKEN)");
  }
}

export function accessClient(config, token) {
  return new AccessClient({ token, accountId: config.accountId });
}

export function wranglerKv(config, args) {
  return capture("npx", ["wrangler", "kv", ...args, "--namespace-id", config.kvNamespaceId, "--remote"]);
}

export async function listLinks(config) {
  const out = await wranglerKv(config, ["key", "list", "--prefix", "code:"]);
  const keys = JSON.parse(out.slice(out.indexOf("[")));
  const links = [];
  for (const { name, metadata } of keys) {
    // Codes carry their slug in metadata; older ones fall back to a read.
    const slug = metadata?.slug || (await wranglerKv(config, ["key", "get", name, "--text"]).catch(() => "")).trim();
    links.push({ code: name.slice(5), slug: slug || null });
  }
  return links;
}

// The small KV interface access.mjs's revoke queue expects, over wrangler.
export function wranglerKvStore(config) {
  return {
    get: async (key) => {
      try {
        return (await wranglerKv(config, ["key", "get", key, "--text"])) || null;
      } catch {
        return null;
      }
    },
    put: (key, value, { expirationTtl } = {}) =>
      wranglerKv(config, ["key", "put", key, value, ...(expirationTtl ? ["--ttl", String(expirationTtl)] : [])]),
  };
}

export const linkUrl = (config, code) => `https://${config.hostname}/_link/${code}/`;

// Everything that must hold before a publish or a share: conforming Access
// rules, no rule or link for a page that isn't published, no shared slug that
// prefixes another path. publishedSlugs = null skips the orphan checks (used
// when removing an orphan).
export async function auditSite({ config, client, publishedSlugs, allPaths }) {
  const guestIdps = await client.guestIdps();
  const result = auditApps(await client.listApps(), {
    host: config.hostname,
    owner: config.owner,
    publishedSlugs,
    guestIdps,
  });
  const links = await listLinks(config);
  if (publishedSlugs) {
    for (const l of links) {
      if (!publishedSlugs.has(l.slug)) {
        result.problems.push(`link code for /${l.slug}, which is not a published page — a new page with that name would inherit it; unlink it`);
      }
    }
  }
  if (allPaths) {
    result.problems.push(...prefixProblems(new Set([...result.pages.keys(), ...links.map((l) => l.slug)]), allPaths));
  }
  return { ...result, links, guestIdps };
}
