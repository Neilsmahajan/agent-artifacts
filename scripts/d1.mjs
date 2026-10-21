// The comments database (D1) from a local agent, through the Cloudflare REST API
// with the wrangler login — the same OAuth token that publishes the site. The
// token is read from wrangler's config file, refreshed by running
// `wrangler whoami` when it is about to expire, and never printed.
// CLOUDFLARE_API_TOKEN (a token with D1 edit) overrides it.

import { spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

const API = "https://api.cloudflare.com/client/v4";
// Where wrangler keeps its login: the legacy home folder, macOS, and Linux
// (XDG_CONFIG_HOME, else ~/.config).
const CONFIGS = [
  resolve(homedir(), ".wrangler/config/default.toml"),
  resolve(homedir(), "Library/Preferences/.wrangler/config/default.toml"),
  resolve(process.env.XDG_CONFIG_HOME || resolve(homedir(), ".config"), ".wrangler/config/default.toml"),
];

async function newestConfig() {
  const found = [];
  for (const path of CONFIGS) {
    const info = await stat(path).catch(() => null);
    if (info) found.push({ path, at: info.mtimeMs });
  }
  found.sort((a, b) => b.at - a.at);
  return found[0]?.path || null;
}

async function readWranglerToken() {
  const path = await newestConfig();
  if (!path) return null;
  const text = await readFile(path, "utf8");
  const token = text.match(/^oauth_token\s*=\s*"([^"]+)"/m)?.[1];
  const expires = Date.parse(text.match(/^expiration_time\s*=\s*"([^"]+)"/m)?.[1] || "");
  return token ? { token, expires } : null;
}

function quiet(command, args) {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("error", fail);
    child.on("exit", (code) => (code === 0 ? done() : fail(new Error(`${command} ${args.join(" ")} failed: ${err.trim().slice(-300)}`))));
  });
}

let cached = null;

export async function cloudflareToken() {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  if (cached && cached.expires - Date.now() > 120_000) return cached.token;
  let found = await readWranglerToken();
  if (!found || !(found.expires - Date.now() > 120_000)) {
    // Any authenticated wrangler command refreshes the OAuth token on disk.
    await quiet("npx", ["wrangler", "whoami"]);
    found = await readWranglerToken();
  }
  if (!found) throw new Error("No wrangler login: run `npx wrangler login` (or set CLOUDFLARE_API_TOKEN)");
  cached = found;
  return found.token;
}

// One SQL statement with ? params; returns its rows.
export async function d1Query(config, sql, params = [], { fetchImpl = fetch } = {}) {
  if (!config.d1DatabaseId) throw new Error("sharing.config.json has no d1DatabaseId: comments are off for this root");
  const response = await fetchImpl(`${API}/accounts/${config.accountId}/d1/database/${config.d1DatabaseId}/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await cloudflareToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sql, params }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false) {
    const detail = (data.errors || []).map((e) => `${e.code}: ${e.message}`).join("; ") || response.statusText;
    throw new Error(`D1 query failed (${response.status}): ${detail}`);
  }
  const [first] = data.result || [];
  if (first && first.success === false) throw new Error(`D1 query failed: ${first.error || "unknown error"}`);
  return first?.results || [];
}

// Pages that hold threads (any status but archived) without being published
// pipeline artifacts: a new page with that name would inherit them.
export async function orphanedThreadSlugs(config, publishedSlugs, options) {
  const rows = await d1Query(config, "SELECT slug, COUNT(*) AS n FROM threads WHERE status != 'archived' GROUP BY slug", [], options);
  return rows.filter((row) => !publishedSlugs.has(row.slug)).map((row) => ({ slug: row.slug, threads: row.n }));
}

// Pages that take comments: built pipeline artifacts (never static ones).
export async function pipelineSlugs(root) {
  const slugs = new Set();
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-z0-9][a-z0-9-]*$/.test(entry.name)) continue;
    const has = (name) => stat(resolve(root, entry.name, name)).then(() => true, () => false);
    if ((await has("artifact.json")) && (await has("index.html")) && !(await has("static-artifact.json"))) slugs.add(entry.name);
  }
  return slugs;
}
