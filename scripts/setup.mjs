#!/usr/bin/env node

// Sets up per-page sharing and page comments for one hub (SETUP.md section 8).
//
//   node setup.mjs --root <root> --project <project> --owner <email>
//                  [--owner-name <name>] [--site-name <name>] [--source-root <path>]
//                  [--account-id <id>] [--no-comments] [--check] [--rotate-token]
//
// Does what can be scripted, and checks the rest:
//
//   - finds the account and the Pages project (it never creates the project:
//     that needs the owner's OK, SETUP.md step 7)
//   - creates the KV namespace <project>-links and, unless --no-comments, the
//     D1 database <project>-comments, and applies assets/comments/schema.sql
//     (every statement is idempotent, so each run applies it again)
//   - writes <root>/sharing.config.json, keeping every value already there
//   - checks the Access API token's scopes, the login methods, the owner-only
//     site-wide Access app and the team domain, and creates the /_link rule
//   - sets the Pages secrets ACCESS_API_TOKEN and SHARE_COOKIE_KEY (the Share
//     screen's cookie key, generated here) and the revoker Worker's token
//
// What it can't do (create the Access token, add login methods, create the
// site-wide Access app) it prints as a TODO with the steps. Re-run it after
// doing them; it's safe to run any number of times. --check reports and
// changes nothing. A secret that's already set is left alone (its value
// can't be read back), so after rolling the Access token, store the new one
// and run with --rotate-token: it sets ACCESS_API_TOKEN on the Pages project
// and the revoker again.
//
// Exit status: 0 when everything is in place, 2 when TODOs remain, 1 on an
// error. Cloudflare calls use the wrangler login (d1.mjs) for the account's
// resources and the Access token (sharing.mjs) for Access. No token or secret
// is ever printed; secrets go to wrangler on stdin.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AccessClient, auditApps, linkAppBody, normalizeEmail } from "../assets/pages-worker/access.mjs";
import { cloudflareToken, d1Query } from "./d1.mjs";
import { accessToken } from "./sharing.mjs";

const API = "https://api.cloudflare.com/client/v4";
const skillDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// A made-up address: revoking it ends no one's session, but the call needs
// the scope that unsharing uses, so it proves the token has it.
const PROBE_EMAIL = "setup-scope-check@invalid.example";
const CONFIG_KEYS = ["project", "siteName", "sourceRoot", "hostname", "accountId", "kvNamespaceId", "owner", "ownerName", "teamDomain", "d1DatabaseId"];

export const TOKEN_STEPS = `Create the Access API token: Cloudflare dashboard → My Profile → API Tokens →
  Create Token → Custom token, scoped to this account only, with these
  account permissions:
    Access: Apps and Policies — Edit
    Access: Tags — Edit
    Access: Organizations, Identity Providers, and Groups — Edit
  (that last one is for revoke_user, which signs people out on unshare; it
  also covers reading the login methods). Nothing else: no zone, DNS, Pages,
  Workers or D1 permissions. Then the owner stores it, typing it themselves:
    macOS:  security add-generic-password -a "$USER" -s cf-access-share-mac -w
    other:  export CF_ACCESS_TOKEN=... in the shell that runs these scripts`;

function parseArgs(argv) {
  const args = { comments: true, check: false };
  const valued = { "--root": "root", "--project": "project", "--owner": "owner", "--owner-name": "ownerName", "--site-name": "siteName", "--source-root": "sourceRoot", "--account-id": "accountId" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (valued[arg]) {
      if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error(`${arg} needs a value`);
      args[valued[arg]] = argv[(i += 1)];
    } else if (arg === "--no-comments") args.comments = false;
    else if (arg === "--check") args.check = true;
    else if (arg === "--rotate-token") args.rotate = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

const USAGE =
  "Usage: setup.mjs --root <root> --project <project> --owner <email> [--owner-name <name>] [--site-name <name>] [--source-root <path>] [--account-id <id>] [--no-comments] [--check] [--rotate-token]";

// The account's resources, with the wrangler login (or CLOUDFLARE_API_TOKEN).
async function cf(method, path, body) {
  const response = await fetch(`${API}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${await cloudflareToken()}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 404) return null;
  if (!response.ok || data.success === false) {
    const detail = (data.errors || []).map((e) => `${e.code}: ${e.message}`).join("; ") || response.statusText;
    throw new Error(`Cloudflare API ${method} ${path.split("?")[0]} failed (${response.status}): ${detail}`);
  }
  return data.result;
}

// wrangler reads a secret's value from stdin when it isn't a terminal.
function putSecret(args, value) {
  return new Promise((done, fail) => {
    const child = spawn("npx", ["wrangler", ...args], { cwd: tmpdir(), stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("error", fail);
    child.on("exit", (code) => (code === 0 ? done() : fail(new Error(`wrangler ${args.slice(0, 3).join(" ")} failed: ${err.trim().slice(-300)}`))));
    child.stdin.end(value);
  });
}

function tildePath(path) {
  const home = homedir();
  return path === home ? "~" : path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.root) {
    console.log(USAGE);
    process.exit(args.help ? 0 : 1);
  }
  const root = resolve(args.root);
  const configPath = resolve(root, "sharing.config.json");
  let existing = {};
  try {
    existing = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error(`sharing.config.json is invalid: ${error.message}`);
  }

  // Values given now must agree with the config: setup fills gaps, and a
  // change to an existing value is an edit the owner makes by hand.
  const config = { ...existing };
  const given = (key, value) => {
    if (value === undefined) return;
    if (existing[key] !== undefined && existing[key] !== value) {
      throw new Error(`sharing.config.json already has ${key} = ${JSON.stringify(existing[key])}; edit it by hand to change it`);
    }
    config[key] = value;
  };
  given("project", args.project);
  given("owner", args.owner && normalizeEmail(args.owner));
  given("ownerName", args.ownerName);
  given("siteName", args.siteName);
  given("accountId", args.accountId);
  if (!config.project || !/^[a-z0-9][a-z0-9-]{0,57}$/.test(config.project)) throw new Error("Give --project <project>: the Pages project's name");
  if (!config.owner) throw new Error("Give --owner <email>: the owner's Access login");
  config.siteName ??= config.project;
  config.sourceRoot ??= args.sourceRoot ?? tildePath(root);

  const todos = [];
  const report = (status, text) => console.log(`${status.padEnd(5)} ${text}`);
  const todo = (text) => {
    todos.push(text);
    report("TODO", text);
  };
  const act = !args.check;
  let made = false;

  // ---- the account and the Pages project (wrangler login) ----------------
  if (!config.accountId) {
    const accounts = (await cf("GET", "accounts?per_page=50")) || [];
    if (accounts.length !== 1) {
      throw new Error(`The wrangler login sees ${accounts.length} accounts; give --account-id <id> (see npx wrangler whoami)`);
    }
    config.accountId = accounts[0].id;
  }
  const acct = `accounts/${config.accountId}`;
  report("ok", "Cloudflare login and account");

  const project = await cf("GET", `${acct}/pages/projects/${config.project}`);
  if (!project) {
    todo(`Pages project ${config.project} doesn't exist: create it and publish once first (SETUP.md step 7), then re-run`);
    return finish(todos);
  }
  // Sharing audits Access rules on one hostname, so the project's pages.dev
  // address must be its only one (publish refuses otherwise).
  given("hostname", project.subdomain);
  report("ok", `Pages project ${config.project} (${config.hostname})`);
  const custom = (project.domains || []).filter((domain) => domain !== project.subdomain);
  if (custom.length) todo(`Remove the project's custom domains (${custom.join(", ")}): sharing works on ${project.subdomain} only`);

  // ---- KV and D1 -----------------------------------------------------------
  const kvTitle = `${config.project}-links`;
  if (config.kvNamespaceId) {
    if (!(await cf("GET", `${acct}/storage/kv/namespaces/${config.kvNamespaceId}`))) {
      throw new Error(`sharing.config.json's kvNamespaceId names no KV namespace on this account`);
    }
    report("ok", "KV namespace for link codes");
  } else {
    const found = ((await cf("GET", `${acct}/storage/kv/namespaces?per_page=100`)) || []).find((ns) => ns.title === kvTitle);
    if (found) config.kvNamespaceId = found.id;
    else if (act) {
      config.kvNamespaceId = (await cf("POST", `${acct}/storage/kv/namespaces`, { title: kvTitle })).id;
      made = true;
    }
    report(config.kvNamespaceId ? (found ? "ok" : "made") : "would", `KV namespace ${kvTitle}`);
  }

  if (args.comments || config.d1DatabaseId) {
    const dbName = `${config.project}-comments`;
    if (config.d1DatabaseId) {
      if (!(await cf("GET", `${acct}/d1/database/${config.d1DatabaseId}`))) {
        throw new Error(`sharing.config.json's d1DatabaseId names no D1 database on this account`);
      }
      report("ok", `D1 database ${dbName}`);
    } else {
      const found = ((await cf("GET", `${acct}/d1/database?name=${encodeURIComponent(dbName)}`)) || []).find((db) => db.name === dbName);
      if (found) config.d1DatabaseId = found.uuid;
      else if (act) {
        config.d1DatabaseId = (await cf("POST", `${acct}/d1/database`, { name: dbName })).uuid;
        made = true;
      }
      report(config.d1DatabaseId ? (found ? "ok" : "made") : "would", `D1 database ${dbName}`);
    }
    if (config.d1DatabaseId && act) {
      await d1Query(config, await readFile(resolve(skillDir, "assets/comments/schema.sql"), "utf8"));
      report("ok", "comments schema applied");
    } else if (config.d1DatabaseId) {
      const tables = await d1Query(config, "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('threads', 'comments', 'endorsements')");
      if (tables.length === 3) report("ok", "comments schema");
      else todo("comments schema isn't applied: run setup.mjs without --check");
    }
  } else report("skip", "comments (--no-comments)");

  // ---- the Access token and what it reaches ---------------------------------
  let token = null;
  try {
    token = await accessToken();
  } catch {
    todo(TOKEN_STEPS);
  }
  let site = null;
  if (token) {
    const client = new AccessClient({ token, accountId: config.accountId });
    const step = async (label, fn) => {
      try {
        return await fn();
      } catch (error) {
        const scope = /\(403\)|\(401\)|10000|Authentication error/.test(error.message);
        todo(`${label}: ${scope ? `the Access token is missing a scope (${error.message}).\n  ${TOKEN_STEPS}` : error.message}`);
        return undefined;
      }
    };

    const org = await step("Access organization", async () => (await client.call("GET", "access/organizations")).result);
    if (org?.auth_domain) {
      given("teamDomain", org.auth_domain);
      report("ok", `Access team ${config.teamDomain}`);
    } else if (org) todo("Zero Trust isn't set up on this account: open Cloudflare Zero Trust and pick a team name (SETUP.md step 7)");

    const idps = await step("Access login methods", () => client.identityProviders());
    if (idps) {
      const count = (type) => idps.filter((idp) => idp.type === type).length;
      if (count("google") === 1 && count("onetimepin") === 1) report("ok", "login methods: Google and one-time PIN");
      else {
        todo(
          `Guests sign in with Google or a one-time PIN, so Zero Trust needs exactly one of each (found ${count("google")} Google, ${count("onetimepin")} one-time PIN). ` +
            "Zero Trust → Settings → Authentication → Login methods → Add new: One-time PIN, and Google (it asks for a Google Cloud OAuth client; Cloudflare's guide is linked there).",
        );
      }
    }

    const apps = await step("Access applications", () => client.listApps());
    if (apps && config.hostname) {
      const audit = auditApps(apps, { host: config.hostname, owner: config.owner, publishedSlugs: null, guestIdps: null });
      site = audit.site;
      if (site) report("ok", "site-wide Access app (owner only)");
      for (const problem of audit.problems) {
        todo(
          problem.startsWith("No conforming site-wide")
            ? `${problem}. Sharing needs a private hub: add the self-hosted Access app for ${config.hostname} and *.${config.hostname}, one Allow policy with only ${config.owner} (SETUP.md step 7)`
            : `${problem} (fix with share.mjs or in Zero Trust → Access → Applications)`,
        );
      }
      if (site && !audit.problems.length) {
        if (audit.link) report("ok", "/_link rule (secret links)");
        else if (act) {
          const created = await step("/_link rule", () => client.createApp(linkAppBody({ host: config.hostname })));
          if (created) report("made", "/_link rule (secret links)");
        } else report("would", "/_link rule (secret links)");
      }
    }

    if (act) {
      const revoked = await step("Access sign-out (revoke_user)", () => client.revokeUser(PROBE_EMAIL));
      if (revoked) report("ok", "Access token can sign people out");
    }
  }

  // ---- the config file -------------------------------------------------------
  const ordered = Object.fromEntries([
    ...CONFIG_KEYS.filter((key) => config[key] !== undefined).map((key) => [key, config[key]]),
    ...Object.entries(config).filter(([key]) => !CONFIG_KEYS.includes(key)),
  ]);
  const text = `${JSON.stringify(ordered, null, 2)}\n`;
  const before = JSON.stringify(existing) === "{}" ? null : `${JSON.stringify(existing, null, 2)}\n`;
  if (text === before) report("ok", "sharing.config.json");
  else if (act) {
    await writeFile(configPath, text, "utf8");
    report("made", `sharing.config.json (${before ? "filled in" : "written"}; commit it, it holds no secrets)`);
  } else report("would", `${before ? "fill in" : "write"} sharing.config.json`);
  if (!config.teamDomain) todo("sharing.config.json has no teamDomain yet (it comes from the Access organization)");

  // ---- secrets -----------------------------------------------------------------
  // Pages and Workers list secret names, never values. A rotation pushes the
  // token only once every check above has passed with it.
  const rotate = Boolean(args.rotate && act && token && !todos.length);
  if (args.rotate && act && !rotate) todo("--rotate-token: not rotating until the TODOs above are done");
  const pageSecrets = new Set(Object.keys(project.deployment_configs?.production?.env_vars || {}));
  let secretsChanged = false;
  const pagesSecret = async (name, value, { replace = false } = {}) => {
    if (pageSecrets.has(name) && !(replace && act)) return report("ok", `Pages secret ${name}`);
    if (!act || !value) return todo(`Pages secret ${name} isn't set${act ? "" : ": run setup.mjs without --check"}`);
    await putSecret(["pages", "secret", "put", name, "--project-name", config.project], value);
    secretsChanged = true;
    report("made", `Pages secret ${name}`);
  };
  if (token) await pagesSecret("ACCESS_API_TOKEN", token, { replace: rotate });
  else todo("Pages secret ACCESS_API_TOKEN waits for the Access token");
  // The Share screen's cookie key: random, made here, never shown or stored.
  await pagesSecret("SHARE_COOKIE_KEY", randomBytes(32).toString("base64url"));

  const revoker = `${config.project}-revoker`;
  const workerSecrets = await cf("GET", `${acct}/workers/scripts/${revoker}/secrets`);
  if (!workerSecrets) {
    todo(`The ${revoker} Worker isn't deployed yet: publish once with sharing on (it deploys it), then re-run setup.mjs to give it ACCESS_API_TOKEN`);
  } else if (workerSecrets.some((s) => s.name === "ACCESS_API_TOKEN") && !rotate) report("ok", `${revoker} secret ACCESS_API_TOKEN`);
  else if (act && token) {
    await putSecret(["secret", "put", "ACCESS_API_TOKEN", "--name", revoker], token);
    report("made", `${revoker} secret ACCESS_API_TOKEN`);
  } else todo(`${revoker} has no ACCESS_API_TOKEN secret`);

  if (secretsChanged) console.log("\nPublish again: a Pages deployment picks up secrets when it's made, not afterwards.");
  if (made) console.log("Made new Cloudflare resources; they are named after the project, so a re-run finds them.");
  return finish(todos);
}

function finish(todos) {
  if (todos.length) {
    console.log(`\n${todos.length} step(s) left. Do them, then run setup.mjs again (same arguments).`);
    process.exitCode = 2;
  } else console.log("\nSharing and comments are set up. Publish, then try share.mjs list.");
}

main().catch((error) => {
  console.error(`ERROR: ${error.message}`);
  process.exit(1);
});
