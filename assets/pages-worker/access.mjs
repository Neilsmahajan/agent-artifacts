// Cloudflare Access rules for per-page sharing on one hub site, and the audit
// that keeps them fail-closed.
//
// Three kinds of Access application may touch the hub hostname:
//
//   site   — the existing site-wide app (apex + *.host), owner only. Never
//            created or modified here; the audit only checks it.
//   page   — one per page shared with named people: exactly one destination,
//            host/<slug>, one allow policy listing the owner plus guest emails.
//   link   — exactly one: destination host/_link, a single Bypass/Everyone
//            policy. The /_link/ worker is the boundary behind it.
//
// Anything else on the host — an unknown app, a wildcard, a policy with
// groups, domains or "everyone", a page rule for a slug that is no longer
// published — fails the audit, and the publish refuses to upload.

const API = "https://api.cloudflare.com/client/v4";
export const TAG = "per-page-sharing";
export const PAGE_SESSION = "336h";
const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const EMAIL = /^[^\s@,;<>"']+@[^\s@,;<>"']+\.[^\s@,;<>"']+$/;

export function normalizeEmail(value) {
  const email = String(value).trim().toLowerCase();
  if (!EMAIL.test(email)) throw new Error(`Not an email address: ${value}`);
  return email;
}

// Shown on the login screen to anyone who opens the address, so it names no
// page: a slug-bearing name would tell a stranger which pages are shared.
export const PAGE_APP_NAME = "Shared page";

export class AccessClient {
  constructor({ token, accountId, fetchImpl = fetch }) {
    if (!token) throw new Error("Missing Cloudflare API token");
    this.token = token;
    this.accountId = accountId;
    // Wrapped: Workers throw "Illegal invocation" when the global fetch is
    // called as a method of another object.
    this.fetch = (...args) => fetchImpl(...args);
  }

  async call(method, path, body) {
    const response = await this.fetch(`${API}/accounts/${this.accountId}/${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) {
      const detail = (data.errors || []).map((e) => `${e.code}: ${e.message}`).join("; ") || response.statusText;
      throw new Error(`Cloudflare API ${method} ${path} failed (${response.status}): ${detail}`);
    }
    return data;
  }

  async listApps() {
    const apps = [];
    for (let page = 1; ; page += 1) {
      const data = await this.call("GET", `access/apps?per_page=100&page=${page}`);
      apps.push(...data.result);
      const info = data.result_info;
      if (!info || page * (info.per_page || 100) >= (info.total_count ?? apps.length)) break;
    }
    return apps;
  }

  async identityProviders() {
    return (await this.call("GET", "access/identity_providers")).result;
  }

  // Login methods for shared pages, looked up by type rather than trusted by
  // id: Google plus the email one-time PIN.
  async guestIdps() {
    const idps = await this.identityProviders();
    const pick = (type) => {
      const found = idps.filter((idp) => idp.type === type);
      if (found.length !== 1) throw new Error(`Expected exactly one ${type} login method, found ${found.length}`);
      return found[0].id;
    };
    return [pick("google"), pick("onetimepin")];
  }

  // Access refuses an app whose tag doesn't exist yet.
  async ensureTag() {
    if (this.tagReady) return;
    const tags = (await this.call("GET", "access/tags")).result || [];
    if (!tags.some((tag) => tag.name === TAG)) await this.call("POST", "access/tags", { name: TAG });
    this.tagReady = true;
  }

  async createApp(body) {
    await this.ensureTag();
    return (await this.call("POST", "access/apps", body)).result;
  }

  updateApp(id, body) {
    return this.call("PUT", `access/apps/${id}`, body).then((d) => d.result);
  }

  deleteApp(id) {
    return this.call("DELETE", `access/apps/${id}`);
  }

  revokeTokens(id) {
    return this.call("POST", `access/apps/${id}/revoke_tokens`);
  }

  // Ends the person's Access sessions everywhere, including the 24-hour
  // global one that would otherwise mint them a fresh page token silently.
  revokeUser(email) {
    return this.call("POST", "access/organizations/revoke_user", { email: normalizeEmail(email) });
  }
}

// Follow-up revokes, run by the revoker Worker's cron. A revoke right after a
// guest-list change can race the change across Cloudflare's edge (proven Oct 1),
// so removal queues more revokes for the next few minutes. Stored in the links
// KV namespace as one key, "revokes" → {<appId>: [due epoch ms...]}: the cron
// reads it every minute, and get() fits the free plan's daily quota where
// list() (1,000 a day, shared with the Share screen) ran out on Oct 3.
export const REVOKE_FOLLOW_UPS_MS = [60_000, 120_000, 300_000];
export const REVOKES_KEY = "revokes";

export async function queueFollowUpRevokes(kv, appId, now = Date.now()) {
  const queue = JSON.parse((await kv.get(REVOKES_KEY)) || "{}");
  queue[appId] = [...new Set([...(queue[appId] || []), ...REVOKE_FOLLOW_UPS_MS.map((ms) => now + ms)])].sort();
  await kv.put(REVOKES_KEY, JSON.stringify(queue), { expirationTtl: 86_400 });
}

// One cron tick: revoke every app whose follow-up is due, then drop the
// times that ran. Apps that no longer exist are fine (nothing to revoke).
// Writes only when something ran, so idle ticks cost one read.
export async function runDueRevokes(kv, client, now = Date.now()) {
  const queue = JSON.parse((await kv.get(REVOKES_KEY)) || "null");
  if (!queue) return [];
  const done = [];
  for (const [appId, due] of Object.entries(queue)) {
    if (!due.some((t) => t <= now)) continue;
    try {
      await client.revokeTokens(appId);
    } catch (error) {
      if (!/\(404\)/.test(error.message)) throw error;
    }
    const rest = due.filter((t) => t > now);
    if (rest.length) queue[appId] = rest;
    else delete queue[appId];
    done.push(appId);
  }
  if (!done.length) return done;
  // Re-read so a removal queued during this tick isn't overwritten.
  const latest = JSON.parse((await kv.get(REVOKES_KEY)) || "{}");
  for (const appId of done) {
    const remaining = (latest[appId] || []).filter((t) => t > now);
    if (remaining.length) latest[appId] = remaining;
    else delete latest[appId];
  }
  if (Object.keys(latest).length) await kv.put(REVOKES_KEY, JSON.stringify(latest), { expirationTtl: 86_400 });
  else await kv.delete(REVOKES_KEY);
  return done;
}

export function pageAppBody({ host, slug, owner, guests, idps }) {
  if (!SLUG.test(slug)) throw new Error(`Not a page slug: ${slug}`);
  const emails = [...new Set([normalizeEmail(owner), ...guests.map(normalizeEmail)])];
  return {
    name: PAGE_APP_NAME,
    type: "self_hosted",
    domain: `${host}/${slug}`,
    destinations: [{ type: "public", uri: `${host}/${slug}` }],
    allowed_idps: idps,
    auto_redirect_to_identity: false,
    app_launcher_visible: false,
    session_duration: PAGE_SESSION,
    path_cookie_attribute: true,
    tags: [TAG],
    policies: [
      {
        name: "guests",
        decision: "allow",
        precedence: 1,
        include: emails.map((email) => ({ email: { email } })),
        exclude: [],
        require: [],
      },
    ],
  };
}

export function linkAppBody({ host }) {
  return {
    name: "share: anyone with the link",
    type: "self_hosted",
    domain: `${host}/_link`,
    destinations: [{ type: "public", uri: `${host}/_link` }],
    app_launcher_visible: false,
    tags: [TAG],
    policies: [
      { name: "anyone with the link", decision: "bypass", precedence: 1, include: [{ everyone: {} }], exclude: [], require: [] },
    ],
  };
}

function destinationsOf(app) {
  if (Array.isArray(app.destinations) && app.destinations.length) {
    return app.destinations.map((d) => (d.type === "public" ? d.uri : `${d.type}:${d.uri ?? ""}`));
  }
  return [...(app.self_hosted_domains || []), ...(app.domain ? [app.domain] : [])];
}

// Does this destination touch the hub at all? Covers the apex, any path on
// it, and any subdomain (deployment hashes and branch aliases).
function touchesHost(uri, host) {
  const bare = String(uri).toLowerCase().replace(/^https?:\/\//, "");
  const hostname = bare.split("/")[0];
  return hostname === host || hostname.endsWith(`.${host}`) || hostname === `*.${host}`;
}

function onlyEmails(rules) {
  const emails = [];
  for (const rule of rules || []) {
    const keys = Object.keys(rule);
    if (keys.length !== 1 || keys[0] !== "email" || typeof rule.email?.email !== "string") return null;
    emails.push(rule.email.email.toLowerCase());
  }
  return emails;
}

// Returns {problems, site, pages: Map(slug → {app, guests}), link}. Every
// application whose destinations touch the host is classified or reported.
export function auditApps(apps, { host, owner, publishedSlugs, guestIdps }) {
  const problems = [];
  const pages = new Map();
  let site = null;
  let link = null;
  const ownerEmail = normalizeEmail(owner);
  const hostLower = host.toLowerCase();

  for (const app of apps) {
    const destinations = destinationsOf(app).map((d) => d.toLowerCase());
    if (!destinations.some((d) => touchesHost(d, hostLower))) continue;
    const label = `Access app "${app.name}" (${app.id})`;
    const policies = app.policies || [];
    // Settings that let requests past the app's policies: a destination's
    // path overrides ({behavior: "public"}) and the OPTIONS bypass. No rule
    // this audit accepts uses them, whatever its shape.
    if ((app.destinations || []).some((d) => d && Array.isArray(d.overrides) && d.overrides.length) || app.options_preflight_bypass) {
      problems.push(`${label}: path overrides or the OPTIONS preflight bypass let requests past Access; remove them`);
      continue;
    }

    const isSite =
      destinations.length === 2 &&
      destinations.includes(hostLower) &&
      destinations.includes(`*.${hostLower}`);
    if (isSite) {
      const emails = policies.length === 1 && policies[0].decision === "allow" ? onlyEmails(policies[0].include) : null;
      if (site) problems.push(`${label}: a second site-wide app`);
      else if (!emails || emails.length !== 1 || emails[0] !== ownerEmail || (policies[0].require || []).length) {
        problems.push(`${label}: the site-wide app must allow exactly ${ownerEmail} and nothing else`);
      } else site = app;
      continue;
    }

    if (destinations.length !== 1) {
      problems.push(`${label}: unexpected destinations ${destinations.join(", ")}`);
      continue;
    }
    const [destination] = destinations;
    const path = destination.slice(hostLower.length);
    if (!destination.startsWith(hostLower + "/") || /[*?#%\\]/.test(path) || path.endsWith("/")) {
      problems.push(`${label}: destination ${destination} is not a plain path on ${host}`);
      continue;
    }
    if (!(app.tags || []).includes(TAG)) {
      problems.push(`${label}: untagged rule on ${destination} — remove it or recreate it with share.mjs`);
      continue;
    }

    if (path === "/_link") {
      const p = policies[0];
      const ok =
        policies.length === 1 &&
        p.decision === "bypass" &&
        p.include?.length === 1 &&
        Object.keys(p.include[0]).length === 1 &&
        "everyone" in p.include[0] &&
        !(p.exclude || []).length &&
        !(p.require || []).length;
      if (link) problems.push(`${label}: a second /_link rule`);
      else if (!ok) problems.push(`${label}: the /_link rule must be a single Bypass for everyone`);
      else link = app;
      continue;
    }

    const slug = path.slice(1);
    if (!SLUG.test(slug)) {
      problems.push(`${label}: ${destination} is not a single page`);
      continue;
    }
    const p = policies[0];
    const emails = policies.length === 1 && p.decision === "allow" && !(p.require || []).length && !(p.exclude || []).length ? onlyEmails(p.include) : null;
    if (!emails || !emails.includes(ownerEmail)) {
      problems.push(`${label}: a page rule must be one allow policy of plain emails including the owner`);
      continue;
    }
    const idps = [...(app.allowed_idps || [])].sort();
    if (guestIdps && JSON.stringify(idps) !== JSON.stringify([...guestIdps].sort())) {
      problems.push(`${label}: unexpected login methods`);
      continue;
    }
    if (app.session_duration !== PAGE_SESSION || app.path_cookie_attribute !== true) {
      problems.push(`${label}: session must be ${PAGE_SESSION} with path cookies on`);
      continue;
    }
    if (pages.has(slug)) {
      problems.push(`${label}: a second rule for /${slug}`);
      continue;
    }
    if (publishedSlugs && !publishedSlugs.has(slug)) {
      problems.push(`${label}: /${slug} is not a published page — a new page with that name would inherit its guests; unshare it`);
      continue;
    }
    pages.set(slug, { app, guests: emails.filter((e) => e !== ownerEmail) });
  }

  if (!site) problems.push(`No conforming site-wide Access app for ${host} (apex + *.${host}, owner only)`);
  return { problems, site, pages, link };
}

// A shared slug must not be a prefix of any other published path: Access path
// matching is not guaranteed to stop at a segment boundary.
export function prefixProblems(sharedSlugs, allPaths) {
  const problems = [];
  for (const slug of sharedSlugs) {
    for (const path of allPaths) {
      const top = path.replace(/^\//, "");
      if (top !== slug && !top.startsWith(`${slug}/`) && top.toLowerCase().startsWith(slug)) {
        problems.push(`/${slug} is shared but is a prefix of /${top}; rename one of them`);
      }
    }
  }
  return problems;
}
