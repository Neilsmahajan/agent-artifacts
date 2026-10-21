// /_share/api/* — the Share screen's helper. Only the owner gets in:
//
//   1. The site-wide Access rule (owner only) covers /_share/, so nobody else
//      reaches this code at all.
//   2. Every request must carry a valid Access JWT (Cf-Access-Jwt-Assertion,
//      signed by the team's certs) for the site-wide app's audience, whose
//      email is the owner.
//   3. Requests must come from the Share screen's own script: a custom header
//      on every request (so a navigation or form can't reach it), same-origin
//      Fetch-Metadata that isn't a navigation, and for writes the right Origin
//      and a JSON body. Other hub pages can't make requests (connect-src
//      'none'), can't frame /_share/ (frame-ancestors 'none'), and can't script
//      a /_share/ window or an API response they open in a popup
//      (Cross-Origin-Opener-Policy: same-origin on both severs the opener).
//   4. Every action but "session" must carry the Share screen's token twice:
//      in the hub_share cookie (Path=/_share/, Secure, SameSite=Strict) and
//      echoed in the X-Share-Token header. The helper mints it (an HMAC over
//      the owner's email and an expiry, keyed by SHARE_COOKIE_KEY) on POST
//      session. It makes every action depend on a value minted for the
//      owner within the last 12 hours, which nothing but a script on the
//      site can read or echo. It is not a wall between hub pages: the cookie
//      path isn't a security boundary inside one origin (a script elsewhere
//      on the site can history.replaceState to /_share/ and read it, or call
//      session itself). What keeps other pages' scripts away from this
//      helper is their CSP: connect-src never names /_share/.
//
// It enforces the same rule shapes as share.mjs (same access.mjs), and the
// API token it uses (secret ACCESS_API_TOKEN) is its own, separately revocable.

import { verifyAccessToken, resetCertCache } from "./access-jwt.js";
import { AccessClient, auditApps, normalizeEmail, pageAppBody, queueFollowUpRevokes } from "./access.mjs";

const SLUG = /^[a-z0-9][a-z0-9-]*$/;

export async function handleShareApi(request, env, url) {
  const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'", "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Resource-Policy": "same-origin" };
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers });

  for (const name of ["HOST", "OWNER", "ACCOUNT_ID", "TEAM_DOMAIN", "SITE_AUD", "ACCESS_API_TOKEN"]) {
    if (!env[name]) return reply(503, { error: `Share helper is not configured (${name})` });
  }
  if (env.SHARE_COOKIE_KEY !== undefined && String(env.SHARE_COOKIE_KEY).length < COOKIE_KEY_MIN) {
    return reply(503, { error: `Share helper is not configured (SHARE_COOKIE_KEY is shorter than ${COOKIE_KEY_MIN} characters)` });
  }
  if (url.hostname !== env.HOST) return reply(403, { error: "Use the main site address" });

  const identity = await verifyAccessJwt(request.headers.get("Cf-Access-Jwt-Assertion"), env).catch((error) => ({ ok: false, error: `Login check failed: ${error.message}` }));
  if (!identity.ok) return reply(403, { error: identity.error });

  const origin = request.headers.get("Origin");
  const site = request.headers.get("Sec-Fetch-Site");
  const mode = request.headers.get("Sec-Fetch-Mode");
  const dest = request.headers.get("Sec-Fetch-Dest");
  if (request.headers.get("X-Share-Screen") !== "1") return reply(403, { error: "Missing Share screen header" });
  if ((site && site !== "same-origin") || mode === "navigate" || (dest && dest !== "empty")) {
    return reply(403, { error: "Cross-site or navigation request refused" });
  }
  if (request.method !== "GET") {
    if (origin !== `https://${env.HOST}`) return reply(403, { error: "Cross-site request refused" });
    if (!(request.headers.get("Content-Type") || "").startsWith("application/json")) return reply(415, { error: "JSON only" });
  }

  const action = url.pathname.slice("/_share/api/".length);
  if (/%|\\/.test(url.pathname) || /%|\\/.test(rawPath(request.url))) return reply(400, { error: "Bad address" });

  if (action === "session") {
    if (request.method !== "POST") return reply(405, { error: "Method not allowed" });
    const token = await mintShareToken(env, identity.email);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { ...headers, "Set-Cookie": `${TOKEN_COOKIE}=${token}; Path=/_share/; Max-Age=${TOKEN_TTL}; Secure; SameSite=Strict` },
    });
  }
  const presented = request.headers.get("X-Share-Token") || "";
  if (!presented || presented !== readCookie(request, TOKEN_COOKIE) || !(await checkShareToken(env, identity.email, presented))) {
    return reply(403, { error: "The Share screen's session ended; reload the page", code: "share-token" });
  }

  try {
    const client = new AccessClient({ token: env.ACCESS_API_TOKEN, accountId: env.ACCOUNT_ID });
    const manifest = await loadManifest(env, url);
    const published = new Set(Object.keys(manifest));
    const guestIdps = await client.guestIdps();
    const audit = async () => auditApps(await client.listApps(), { host: env.HOST, owner: env.OWNER, publishedSlugs: published, guestIdps });

    if (request.method === "GET" && action === "state") {
      const { problems, pages, link } = await audit();
      const links = await listLinks(env);
      for (const l of links) if (!published.has(l.slug)) problems.push(`link code for /${l.slug}, which is not a published page`);
      return reply(200, {
        host: env.HOST,
        owner: env.OWNER,
        pages: manifest,
        shares: Object.fromEntries([...pages].map(([slug, p]) => [slug, p.guests])),
        links: Object.fromEntries(links.filter((l) => published.has(l.slug)).map((l) => [l.slug, l.code])),
        linkRule: Boolean(link),
        problems,
      });
    }
    if (request.method !== "POST") return reply(405, { error: "Method not allowed" });

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") return reply(400, { error: "Bad request" });
    const slug = String(body.slug || "");
    if (!SLUG.test(slug)) return reply(400, { error: "Bad page" });

    if (action === "share") {
      if (!published.has(slug)) return reply(404, { error: `/${slug}/ is not a published page` });
      const emails = (Array.isArray(body.emails) ? body.emails : []).map(normalizeEmail);
      if (!emails.length) return reply(400, { error: "Give at least one email" });
      const { problems, pages } = await audit();
      if (problems.length) return reply(409, { error: "Fix these first", problems });
      if (prefixClash(slug, published)) return reply(409, { error: `/${slug} is a prefix of another page's address; rename one of them` });
      const existing = pages.get(slug);
      const guests = [...new Set([...(existing?.guests || []), ...emails])];
      const appBody = pageAppBody({ host: env.HOST, slug, owner: env.OWNER, guests, idps: guestIdps });
      if (existing) await client.updateApp(existing.app.id, appBody);
      else await client.createApp(appBody);
      // Read back: what Cloudflare stored is what counts. A concurrent edit
      // (share.mjs at the same moment) shows up here as a different list.
      const after = await audit();
      const stored = after.pages.get(slug);
      if (!stored || after.problems.length) return reply(500, { error: "The stored rule didn't pass the audit", problems: after.problems });
      if (!emails.every((e) => stored.guests.includes(e))) return reply(409, { error: "Someone else changed this page's list at the same time; reload and try again" });
      return reply(200, { guests: stored.guests });
    }

    if (action === "unshare") {
      // Idempotent: removing someone who's already off the list still runs the
      // sign-outs, so a retry after a failure finishes the job.
      const email = normalizeEmail(body.email);
      const { pages } = await auditApps(await client.listApps(), { host: env.HOST, owner: env.OWNER, publishedSlugs: null, guestIdps });
      const existing = pages.get(slug);
      if (!existing) {
        await client.revokeUser(email);
        return reply(200, { guests: [] });
      }
      const remaining = existing.guests.filter((g) => g !== email);
      if (remaining.length) {
        if (remaining.length !== existing.guests.length) {
          await client.updateApp(existing.app.id, pageAppBody({ host: env.HOST, slug, owner: env.OWNER, guests: remaining, idps: guestIdps }));
        }
        // An immediate revoke can race the list change across the edge (proven
        // Oct 1): end the person's global session so nothing re-issues
        // silently, sign the page out now, and queue more page sign-outs for
        // the revoker Worker's cron, which runs whether or not this tab stays open.
        await client.revokeUser(email);
        await client.revokeTokens(existing.app.id);
        await queueFollowUpRevokes(env.LINKS, existing.app.id);
        const after = (await auditApps(await client.listApps(), { host: env.HOST, owner: env.OWNER, publishedSlugs: null, guestIdps })).pages.get(slug);
        if (after?.guests.includes(email)) return reply(409, { error: "Someone else changed this page's list at the same time; remove them again" });
        return reply(200, { guests: after?.guests || remaining });
      }
      // Last guest: deleting the rule hands the page back to the you-only rule.
      await client.revokeUser(email);
      await client.revokeTokens(existing.app.id);
      await client.deleteApp(existing.app.id);
      return reply(200, { guests: [] });
    }

    if (action === "link") {
      if (!published.has(slug)) return reply(404, { error: `/${slug}/ is not a published page` });
      const { problems } = await audit();
      if (problems.length) return reply(409, { error: "Fix these first", problems });
      const links = (await listLinks(env)).filter((l) => l.slug === slug);
      if (links.length && !body.reset) return reply(200, { code: links[0].code });
      await deleteLinks(env, slug, links, body.code);
      const code = randomCode();
      // The slug rides in the key's metadata too, so listing never depends on
      // an eventually consistent get to know which page a code belongs to.
      await env.LINKS.put(`code:${code}`, slug, { metadata: { slug } });
      return reply(200, { code });
    }

    if (action === "unlink") {
      const links = (await listLinks(env)).filter((l) => l.slug === slug);
      const removed = await deleteLinks(env, slug, links, body.code);
      return reply(200, { removed });
    }

    return reply(404, { error: "Unknown action" });
  } catch (error) {
    return reply(/^Not an email address/.test(error.message) ? 400 : 502, { error: error.message });
  }
}

function prefixClash(slug, published) {
  return [...published].some((other) => other !== slug && other.startsWith(slug));
}

function randomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function listLinks(env) {
  const links = [];
  let cursor;
  do {
    const page = await env.LINKS.list({ prefix: "code:", cursor });
    for (const key of page.keys) {
      const slug = key.metadata?.slug || (await env.LINKS.get(key.name));
      links.push({ code: key.name.slice(5), slug: slug || null });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return links;
}

// Deletes every listed code for the page plus the code the screen is showing
// (a just-created key can be missing from a list for up to a minute).
async function deleteLinks(env, slug, links, shownCode) {
  const codes = new Set(links.map((l) => l.code));
  if (typeof shownCode === "string" && /^[A-Za-z0-9_-]{43}$/.test(shownCode)) codes.add(shownCode);
  for (const code of codes) await env.LINKS.delete(`code:${code}`);
  return codes.size;
}

async function loadManifest(env, url) {
  const response = await env.ASSETS.fetch(new Request(new URL("/_share/pages.json", url), { redirect: "manual" }));
  if (response.status !== 200) return {};
  const data = await response.json().catch(() => null);
  return data && typeof data.pages === "object" && data.pages ? data.pages : {};
}

// ---- the Share screen's token ---------------------------------------------------

export const TOKEN_COOKIE = "hub_share";
export const TOKEN_TTL = 12 * 60 * 60;

// The HMAC key is its own Pages secret, SHARE_COOKIE_KEY (setup.mjs makes
// one), so the cookie's key and the Access API token are separate secrets.
// An install from before it existed has no SHARE_COOKIE_KEY and derives the
// key from ACCESS_API_TOKEN, as it always did. Changing whichever is in use
// ends the owner's Share screen sessions (12 hours at most); guests never
// hold this cookie.
export const COOKIE_KEY_MIN = 32;
async function tokenKey(env) {
  const seed = env.SHARE_COOKIE_KEY ? `hub-share-cookie|${env.SHARE_COOKIE_KEY}` : `hub-share-token|${env.ACCESS_API_TOKEN}`;
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed));
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function mintShareToken(env, email, now = Date.now()) {
  const exp = Math.floor(now / 1000) + TOKEN_TTL;
  const mac = await crypto.subtle.sign("HMAC", await tokenKey(env), new TextEncoder().encode(`${email}|${exp}`));
  return `${exp}.${b64url(new Uint8Array(mac))}`;
}

export async function checkShareToken(env, email, token, now = Date.now()) {
  const match = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match || Number(match[1]) < Math.floor(now / 1000)) return false;
  const mac = Uint8Array.from(atob(match[2].replace(/-/g, "+").replace(/_/g, "/") + "="), (c) => c.charCodeAt(0));
  return crypto.subtle.verify("HMAC", await tokenKey(env), mac, new TextEncoder().encode(`${email}|${match[1]}`));
}

function readCookie(request, name) {
  for (const part of (request.headers.get("Cookie") || "").split(/;\s*/)) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at) === name) return part.slice(at + 1);
  }
  return null;
}

function b64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function rawPath(href) {
  const afterScheme = href.replace(/^[a-z]+:\/\/[^/]*/i, "");
  return afterScheme.split(/[?#]/)[0];
}

// ---- Access JWT -------------------------------------------------------------

// The site-wide rule's audience only, and only the owner.
export async function verifyAccessJwt(token, env, now = Date.now(), fetchImpl = fetch) {
  const identity = await verifyAccessToken(token, { teamDomain: env.TEAM_DOMAIN, audiences: [env.SITE_AUD] }, now, fetchImpl);
  if (!identity.ok) return identity;
  if (identity.email !== env.OWNER.toLowerCase()) return { ok: false, error: "Only the owner can share" };
  return { ok: true, email: identity.email };
}

export { resetCertCache };
