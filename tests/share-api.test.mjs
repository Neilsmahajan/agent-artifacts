// Run: node --test <skill-dir>/tests/
//
// The Share helper changes who can read pages, so these pin down its gate:
// only a correctly signed Access login for the site-wide rule, belonging to
// the owner, from the Share screen itself (same origin, custom header, JSON),
// gets through — and what it then writes to Cloudflare is the audited shape.

import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { afterEach, beforeEach, test } from "node:test";

import { runDueRevokes, AccessClient } from "../assets/pages-worker/access.mjs";
import { checkShareToken, handleShareApi, mintShareToken, resetCertCache, verifyAccessJwt } from "../assets/pages-worker/share-api.js";

const HOST = "hub.example.dev";
const TEAM = "team.cloudflareaccess.com";
const AUD = "site-aud";
const OWNER = "owner@example.com";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
function jwt(claims = {}, { key = privateKey, kid = "k1", alg = "RS256" } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg, kid, typ: "JWT" })}.${b64({ aud: [AUD], iss: `https://${TEAM}`, email: OWNER, exp: now + 600, iat: now, ...claims })}`;
  return `${body}.${sign("sha256", Buffer.from(body), key).toString("base64url")}`;
}

// ---- fake Cloudflare API + KV + assets ---------------------------------------

let apps;
let calls;
let realFetch;
function cfFetch(url, init = {}) {
  const u = String(url);
  if (u === `https://${TEAM}/cdn-cgi/access/certs`) return Response.json({ keys: [jwk] });
  const path = u.replace(/^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/acct\//, "");
  const method = init.method || "GET";
  calls.push(`${method} ${path.split("?")[0]}`);
  const ok = (result) => Response.json({ success: true, result, result_info: { page: 1, per_page: 100, total_count: Array.isArray(result) ? result.length : 1 } });
  if (path.startsWith("access/identity_providers")) return ok([{ id: "g", type: "google" }, { id: "o", type: "onetimepin" }]);
  if (path.startsWith("access/tags")) return ok([{ name: "per-page-sharing" }]);
  if (path.startsWith("access/apps") && method === "GET") return ok(apps);
  if (path === "access/apps" && method === "POST") {
    const app = { id: `app${apps.length}`, aud: "x", ...JSON.parse(init.body) };
    apps.push(app);
    return ok(app);
  }
  const m = path.match(/^access\/apps\/([^/]+)(\/revoke_tokens)?$/);
  if (m && method === "PUT") {
    const i = apps.findIndex((a) => a.id === m[1]);
    apps[i] = { ...apps[i], ...JSON.parse(init.body) };
    return ok(apps[i]);
  }
  if (m && method === "DELETE") {
    apps = apps.filter((a) => a.id !== m[1]);
    return ok({ id: m[1] });
  }
  if (m && m[2] && method === "POST") return ok(null);
  if (path === "access/organizations/revoke_user" && method === "POST") return ok(true);
  return new Response(JSON.stringify({ success: false, errors: [{ code: 0, message: `unmocked ${method} ${path}` }] }), { status: 404 });
}

const siteApp = {
  id: "site",
  aud: AUD,
  destinations: [{ type: "public", uri: `*.${HOST}` }, { type: "public", uri: HOST }],
  policies: [{ decision: "allow", include: [{ email: { email: OWNER } }] }],
};

function makeEnv() {
  const kv = new Map();
  const meta = new Map();
  return {
    kv,
    HOST, OWNER, ACCOUNT_ID: "acct", TEAM_DOMAIN: TEAM, SITE_AUD: AUD, ACCESS_API_TOKEN: "t",
    LINKS: {
      get: async (k) => kv.get(k) ?? null,
      put: async (k, v, opts = {}) => void (kv.set(k, v), opts.metadata && meta.set(k, opts.metadata)),
      delete: async (k) => void (kv.delete(k), meta.delete(k)),
      list: async ({ prefix }) => ({
        keys: [...kv.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name, ...(meta.has(name) ? { metadata: meta.get(name) } : {}) })),
        list_complete: true,
      }),
    },
    ASSETS: {
      fetch: async (req) =>
        new URL(req.url).pathname === "/_share/pages.json"
          ? Response.json({ pages: { "page-a": { kind: "artifact" }, "page-b": { kind: "static" }, "page-ab": { kind: "artifact" } } })
          : new Response("nope", { status: 404 }),
    },
  };
}

beforeEach(() => {
  apps = [structuredClone(siteApp)];
  calls = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = cfFetch;
  resetCertCache();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

// The Share screen's token, minted the way the screen gets it (POST session),
// rides in both the cookie and the header unless a test says otherwise.
async function shareToken(env) {
  const res = await call(env, "session", { body: {}, shareToken: null });
  assert.equal(res.status, 200, await res.clone().text());
  return res.headers.get("set-cookie").match(/^hub_share=([^;]+)/)[1];
}

async function call(env, action, { method = "POST", body, token = jwt(), headers = {}, shareToken: st } = {}) {
  if (st === undefined) st = await shareToken(env);
  const h = new Headers({
    "Cf-Access-Jwt-Assertion": token,
    ...(st ? { Cookie: `other=1; hub_share=${st}`, "X-Share-Token": st } : {}),
    Origin: `https://${HOST}`,
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
    "X-Share-Screen": "1",
    ...(method === "GET" ? {} : { "Content-Type": "application/json" }),
    ...headers,
  });
  for (const [k, v] of Object.entries(headers)) if (v === null) h.delete(k);
  const url = new URL(`https://${HOST}/_share/api/${action}`);
  return handleShareApi(new Request(url, { method, headers: h, body: body ? JSON.stringify(body) : undefined }), env, url);
}

// ---- JWT --------------------------------------------------------------------

test("a valid owner token passes", async () => {
  const env = makeEnv();
  assert.deepEqual(await verifyAccessJwt(jwt(), env), { ok: true, email: OWNER });
  assert.equal((await verifyAccessJwt(jwt({ email: "OWNER@Example.com" }), env)).ok, true);
});

test("bad tokens are refused", async () => {
  const env = makeEnv();
  const cases = {
    missing: undefined,
    garbage: "a.b",
    "wrong key": jwt({}, { key: other }),
    "unknown kid": jwt({}, { kid: "nope" }),
    "alg none": jwt({}, { alg: "none" }),
    "other audience": jwt({ aud: ["page-rule-aud"] }),
    "other issuer": jwt({ iss: "https://evil.cloudflareaccess.com" }),
    expired: jwt({ exp: Math.floor(Date.now() / 1000) - 5 }),
    "a guest": jwt({ email: "guest@example.com" }),
  };
  for (const [name, token] of Object.entries(cases)) {
    assert.equal((await verifyAccessJwt(token, env)).ok, false, name);
  }
  const forged = jwt().split(".");
  forged[1] = b64({ aud: [AUD], iss: `https://${TEAM}`, email: OWNER, exp: 9e9 });
  assert.equal((await verifyAccessJwt(forged.join("."), env)).ok, false, "tampered payload");
});

// ---- request guards ---------------------------------------------------------

test("only the Share screen's own requests are accepted", async () => {
  const env = makeEnv();
  assert.equal((await call(env, "state", { method: "GET" })).status, 200);
  assert.equal((await call(env, "state", { method: "GET", token: jwt({ email: "guest@example.com" }) })).status, 403);
  assert.equal((await call(env, "state", { method: "GET", headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
  // Another hub page opening the API in a popup: a same-origin navigation.
  assert.equal((await call(env, "state", { method: "GET", headers: { "X-Share-Screen": null, "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" } })).status, 403);
  assert.equal((await call(env, "state", { method: "GET", headers: { "X-Share-Screen": null } })).status, 403);
  assert.equal((await call(env, "state", { method: "GET", headers: { "Sec-Fetch-Mode": "navigate" } })).status, 403);
  const res = await call(env, "state", { method: "GET" });
  assert.equal(res.headers.get("cross-origin-opener-policy"), "same-origin");
  const body = { slug: "page-a", emails: ["g@example.com"] };
  assert.equal((await call(env, "share", { body, headers: { Origin: "https://evil.example" } })).status, 403);
  assert.equal((await call(env, "share", { body, headers: { Origin: null } })).status, 403);
  assert.equal((await call(env, "share", { body, headers: { "X-Share-Screen": null } })).status, 403);
  assert.equal((await call(env, "share", { body, headers: { "Sec-Fetch-Site": "same-site" } })).status, 403);
  assert.equal((await call(env, "share", { body, headers: { "Content-Type": "text/plain" } })).status, 415);
  assert.ok(!calls.some((c) => c.startsWith("POST access/apps") || c.startsWith("PUT")), "nothing written");
});

test("a preview hostname can't use the helper", async () => {
  const env = makeEnv();
  const url = new URL(`https://abc123.${HOST}/_share/api/state`);
  const res = await handleShareApi(new Request(url, { headers: { "Cf-Access-Jwt-Assertion": jwt() } }), env, url);
  assert.equal(res.status, 403);
});

test("unconfigured helper refuses", async () => {
  const env = makeEnv();
  delete env.SITE_AUD;
  assert.equal((await call(env, "state", { method: "GET", shareToken: null })).status, 503);
});

// ---- actions ----------------------------------------------------------------

test("share creates an audited page rule; unshare revokes and asks for follow-ups", async () => {
  const env = makeEnv();
  let res = await call(env, "share", { body: { slug: "page-b", emails: ["Pat@Example.net", "pat@example.com"] } });
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual((await res.json()).guests, ["pat@example.net", "pat@example.com"]);
  const rule = apps.find((a) => a.destinations[0].uri === `${HOST}/page-b`);
  assert.equal(rule.policies[0].include.length, 3);

  res = await call(env, "unshare", { body: { slug: "page-b", email: "pat@example.net" } });
  const data = await res.json();
  assert.deepEqual(data.guests, ["pat@example.com"]);
  assert.ok(calls.includes("POST access/organizations/revoke_user"), "global session ended");
  assert.ok(calls.includes(`POST access/apps/${rule.id}/revoke_tokens`));
  const queued = JSON.parse(env.kv.get("revokes"));
  assert.equal(queued[rule.id].length, 3, "follow-up sign-outs queued server-side");

  // Idempotent: removing again still signs them out and succeeds.
  calls.length = 0;
  res = await call(env, "unshare", { body: { slug: "page-b", email: "pat@example.net" } });
  assert.equal(res.status, 200);
  assert.ok(calls.includes("POST access/organizations/revoke_user"));

  // The cron runs due follow-ups and clears them.
  calls.length = 0;
  const client = new AccessClient({ token: "t", accountId: "acct" });
  assert.deepEqual(await runDueRevokes(env.LINKS, client, Date.now()), [], "nothing due yet");
  assert.deepEqual(await runDueRevokes(env.LINKS, client, Date.now() + 61_000), [rule.id]);
  assert.ok(calls.includes(`POST access/apps/${rule.id}/revoke_tokens`));
  await runDueRevokes(env.LINKS, client, Date.now() + 10 * 60_000);
  assert.ok(!env.kv.has("revokes"), "queue gone once all ran");

  res = await call(env, "unshare", { body: { slug: "page-b", email: "pat@example.com" } });
  assert.deepEqual((await res.json()).guests, []);
  assert.ok(!apps.some((a) => a.id === rule.id), "last guest removed deletes the rule");
});

test("share refuses unpublished pages, bad emails, and prefix clashes", async () => {
  const env = makeEnv();
  assert.equal((await call(env, "share", { body: { slug: "not-a-page", emails: ["a@b.com"] } })).status, 404);
  assert.equal((await call(env, "share", { body: { slug: "../x", emails: ["a@b.com"] } })).status, 400);
  assert.equal((await call(env, "share", { body: { slug: "page-a", emails: ["not an email"] } })).status, 400);
  assert.equal((await call(env, "share", { body: { slug: "page-a", emails: ["a@b.com"] } })).status, 409, "page-a prefixes page-ab");
});

test("share refuses while the audit has problems", async () => {
  const env = makeEnv();
  apps.push({ id: "manual", destinations: [{ type: "public", uri: `${HOST}/page-b` }], policies: [{ decision: "allow", include: [{ everyone: {} }] }] });
  const res = await call(env, "share", { body: { slug: "page-b", emails: ["a@b.com"] } });
  assert.equal(res.status, 409);
  assert.match(JSON.stringify(await res.json()), /untagged/);
});

test("links: create, reuse, reset, remove", async () => {
  const env = makeEnv();
  const first = (await (await call(env, "link", { body: { slug: "page-b" } })).json()).code;
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(env.kv.get(`code:${first}`), "page-b");
  assert.equal((await (await call(env, "link", { body: { slug: "page-b" } })).json()).code, first);
  const second = (await (await call(env, "link", { body: { slug: "page-b", reset: true } })).json()).code;
  assert.notEqual(second, first);
  assert.ok(!env.kv.has(`code:${first}`));
  const state = await (await call(env, "state", { method: "GET" })).json();
  assert.equal(state.links["page-b"], second);
  await call(env, "unlink", { body: { slug: "page-b" } });
  assert.equal(env.kv.size, 0);
  // A code the list can't see yet (KV list lag) is still deleted when the
  // screen passes the code it shows.
  env.kv.set(`code:${"q".repeat(43)}`, "page-b");
  const hidden = env.LINKS.list;
  env.LINKS.list = async () => ({ keys: [], list_complete: true });
  await call(env, "unlink", { body: { slug: "page-b", code: "q".repeat(43) } });
  env.LINKS.list = hidden;
  assert.equal(env.kv.size, 0);
  assert.equal((await call(env, "link", { body: { slug: "nope" } })).status, 404);
});

// ---- the Share screen's token -------------------------------------------------

test("session sets a /_share/-scoped token cookie, only for the owner's own screen", async () => {
  const env = makeEnv();
  const res = await call(env, "session", { body: {}, shareToken: null });
  const cookie = res.headers.get("set-cookie");
  assert.match(cookie, /^hub_share=\d+\.[A-Za-z0-9_-]{43}; Path=\/_share\/; Max-Age=43200; Secure; SameSite=Strict$/);
  assert.doesNotMatch(await res.text(), /\d{10}\./, "the token is not in the body");
  assert.equal((await call(env, "session", { method: "GET", shareToken: null })).status, 405);
  assert.equal((await call(env, "session", { body: {}, shareToken: null, token: jwt({ email: "guest@example.com" }) })).status, 403);
  assert.equal((await call(env, "session", { body: {}, shareToken: null, headers: { Origin: "https://evil.example" } })).status, 403);
  assert.equal((await call(env, "session", { body: {}, shareToken: null, headers: { "X-Share-Screen": null } })).status, 403);
});

test("every other action needs the token in both the cookie and the header", async () => {
  const env = makeEnv();
  const st = await shareToken(env);
  const state = (headers) => call(env, "state", { method: "GET", shareToken: null, headers });
  assert.equal((await state({ Cookie: `hub_share=${st}`, "X-Share-Token": st })).status, 200);
  const refused = {
    none: {},
    "cookie only": { Cookie: `hub_share=${st}` },
    "header only (a page that can't read the cookie)": { "X-Share-Token": st },
    mismatch: { Cookie: `hub_share=${st}`, "X-Share-Token": st.replace(/.$/, (c) => (c === "A" ? "B" : "A")) },
    forged: { Cookie: "hub_share=9999999999." + "A".repeat(43), "X-Share-Token": "9999999999." + "A".repeat(43) },
  };
  for (const [name, headers] of Object.entries(refused)) {
    const res = await state(headers);
    assert.equal(res.status, 403, name);
    assert.equal((await res.json()).code, "share-token", name);
  }
  const body = { slug: "page-a", emails: ["g@example.com"] };
  assert.equal((await call(env, "share", { body, shareToken: null, headers: { "X-Share-Token": st } })).status, 403);
  assert.ok(!calls.some((c) => c.startsWith("POST access/apps") || c.startsWith("PUT")), "nothing written");
});

test("tokens expire, and are bound to the email and the helper's secret", async () => {
  const env = makeEnv();
  const now = Date.now();
  const st = await mintShareToken(env, OWNER, now);
  assert.equal(await checkShareToken(env, OWNER, st, now), true);
  assert.equal(await checkShareToken(env, OWNER, st, now + 13 * 3600 * 1000), false, "expired");
  assert.equal(await checkShareToken(env, "someone@example.com", st, now), false, "other email");
  assert.equal(await checkShareToken({ ...env, ACCESS_API_TOKEN: "rotated" }, OWNER, st, now), false, "secret rotated");
  const [exp, mac] = st.split(".");
  assert.equal(await checkShareToken(env, OWNER, `${Number(exp) + 1000}.${mac}`, now), false, "extended expiry");
});

test("percent-encoded helper paths are refused", async () => {
  const env = makeEnv();
  const url = new URL(`https://${HOST}/_share/api/st%61te`);
  const res = await handleShareApi(new Request(url, { headers: { "Cf-Access-Jwt-Assertion": jwt(), "X-Share-Screen": "1" } }), env, url);
  assert.equal(res.status, 400);
});
