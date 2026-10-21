// /<slug>/_comments/* — page comment threads, stored in D1 (binding COMMENTS).
//
// The path sits under the page, so the page's own Access rule covers it: the
// site-wide rule (owner only) for most pages, the page rule for a shared one.
// The owner comments on every page; a guest only on a page shared with them.
// Every request must:
//
//   1. come to the main hostname (deployment hash URLs get 403);
//   2. carry an Access JWT signed by the team, for the site-wide rule or this
//      page's own rule. The owner's email makes the owner. Any other email is
//      a guest, accepted only with this page's rule's audience and only while
//      that rule, as Access holds it now, lists them (looked up live, cached
//      for a minute) — so a guest token for page A never opens page B, and an
//      unshared guest is out even before their session ends;
//   3. come from the page's own script: the X-Hub-Comments header (a
//      cross-site page can't send it without a CORS preflight, and this
//      refuses preflights), same-origin Fetch-Metadata that isn't a
//      navigation, and for writes the site's Origin and a JSON body of at
//      most 16 KB.
//
// Answers are always JSON from here, never a redirect: CSP stops checking
// paths after a redirect, and the page's connect-src is scoped to
// /<slug>/_comments/. Comment text is stored and returned as plain text; the
// page only ever puts it in the DOM through textContent.
//
// What a guest sees and does: threads the owner or an agent started (read
// only) plus their own, never another guest's. They reply in, resolve and
// reopen only their own threads and delete only their own comments, within
// per-person limits counted in the same SQL statement as the write. Every
// limit a guest meets counts only their own rows (so it reveals nothing about
// anyone else's), and the owner's limits count only the owner's and agents'
// rows (so guests can't use up the owner's room).
//
// Which pages take comments, and their anchors, come from
// /_share/comments/<slug>.json, written by publish-pages.mjs ({anchors, aud}).

import { verifyAccessToken } from "./access-jwt.js";
import { AccessClient, auditApps } from "./access.mjs";

const PATH = /^\/([a-z0-9][a-z0-9-]*)\/_comments\/(.+)$/;
const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const ANCHOR = /^[a-z0-9][a-z0-9:./-]{0,199}$/;
const FP = /^[0-9a-f]{8}$/;
const VERSION = /^[A-Za-z0-9.+_-]{1,64}$/;
const THREAD_ID = /^t_[a-z0-9]{8,40}$/;
const COMMENT_ID = /^c_[a-z0-9]{8,40}$/;
// A guest's email as a page rule can hold it; never one that could pass for
// an agent ("agent:...") in created_by.
const GUEST_EMAIL = /^[^\s@,;<>"':]+@[^\s@,;<>"':]+\.[^\s@,;<>"':]+$/;

export const MAX_REQUEST_BYTES = 16 * 1024;
export const BODY_LIMIT = 4000;
export const QUOTE_LIMIT = 300;
export const CONTEXT_LIMIT = 64;
export const RESOLUTION_LIMIT = 1000;
// The owner isn't rate limited as such, but a runaway script on a page can't
// fill the database or make the page heavy: caps per page and per thread, and
// a page load returns every open thread but only the latest resolved ones.
export const OPEN_THREADS_PER_PAGE = 500;
export const COMMENTS_PER_THREAD = 200;
export const BODY_READ_MS = 10_000;
export const PAGE_WRITES_PER_DAY = 500;
export const RESOLVED_SHOWN = 100;
// Guests, per person: comments across the site, open threads per page, and
// their own comments per thread.
export const GUEST_PER_HOUR = 30;
export const GUEST_PER_DAY = 200;
export const GUEST_OPEN_THREADS_PER_PAGE = 100;
export const GUEST_COMMENTS_PER_THREAD = 100;

const HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Cross-Origin-Resource-Policy": "same-origin",
};

function reply(status, body, extra = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...HEADERS, ...extra } });
}

export async function handleCommentsApi(request, env, url, { now = Date.now(), fetchImpl = fetch, bodyReadMs = BODY_READ_MS } = {}) {
  // now can be pinned (tests); time still moves on from it while a body arrives.
  const started = Date.now();
  const clock = () => now + (Date.now() - started);
  for (const name of ["HOST", "OWNER", "TEAM_DOMAIN", "SITE_AUD"]) {
    if (!env[name]) return reply(503, { error: `Comments are not configured (${name})` });
  }
  if (!env.COMMENTS) return reply(503, { error: "Comments are not configured (COMMENTS)" });
  if (url.hostname !== env.HOST) return reply(403, { error: "Use the main site address" });
  // Percent-encoding and backslashes are never needed here and are how path
  // tricks get past string checks; the raw URL is checked before WHATWG
  // parsing normalised it.
  if (/%|\\/.test(url.pathname) || /%|\\/.test(rawPath(request.url))) return reply(400, { error: "Bad address" });
  if (url.search) return reply(400, { error: "Bad address" });

  const match = url.pathname.match(PATH);
  if (!match) return reply(404, { error: "Not found" });
  const [, slug, action] = match;

  if (request.method !== "GET" && request.method !== "POST") {
    // Includes OPTIONS: no preflight is ever answered, so no cross-site page
    // can send the custom header.
    return reply(405, { error: "Method not allowed" }, { Allow: "GET, POST" });
  }

  // Fetch-Metadata: browsers that send it must say this is the page's own fetch.
  const site = request.headers.get("Sec-Fetch-Site");
  const mode = request.headers.get("Sec-Fetch-Mode");
  const dest = request.headers.get("Sec-Fetch-Dest");
  if (request.headers.get("X-Hub-Comments") !== "1") return reply(403, { error: "Missing comments header" });
  if ((site && site !== "same-origin") || mode === "navigate" || mode === "nested-navigate" || (dest && dest !== "empty")) {
    return reply(403, { error: "Cross-site or navigation request refused" });
  }
  if (request.method === "POST") {
    if (request.headers.get("Origin") !== `https://${env.HOST}`) return reply(403, { error: "Cross-site request refused" });
    if (!/^application\/json(;|$)/i.test(request.headers.get("Content-Type") || "")) return reply(415, { error: "JSON only" });
  }

  const page = await pageConfig(env, url, slug);
  if (!page) return reply(404, { error: "Comments are off for this page" });

  const identity = await verifyAccessToken(
    request.headers.get("Cf-Access-Jwt-Assertion"),
    {
      teamDomain: env.TEAM_DOMAIN,
      audiences: async (aud) => aud === env.SITE_AUD || aud === page.aud || (await pageRule(env, slug, fetchImpl, now))?.aud === aud,
    },
    now,
    fetchImpl,
  ).catch((error) => ({ ok: false, error: `Login check failed: ${error.message}` }));
  if (!identity.ok) return reply(401, { error: identity.error });
  const owner = env.OWNER.toLowerCase();
  let viewer;
  if (identity.email === owner) {
    viewer = { email: identity.email, role: "owner" };
  } else {
    if (!GUEST_EMAIL.test(identity.email)) return reply(403, { error: "This page isn't shared with you" });
    const refused = await guestRefusal(env, slug, identity, fetchImpl, now);
    if (refused) return refused;
    viewer = { email: identity.email, role: "guest" };
  }
  viewer.ownerName = typeof env.OWNER_NAME === "string" && env.OWNER_NAME ? env.OWNER_NAME.slice(0, 40) : "The owner";
  const ctx = { env, slug, owner, fetchImpl, now };

  let body = null;
  if (request.method === "POST") {
    const declared = Number(request.headers.get("Content-Length") || 0);
    if (declared > MAX_REQUEST_BYTES) return reply(413, { error: "Too large" });
    const text = await readLimited(request, MAX_REQUEST_BYTES, bodyReadMs);
    if (text === null) return reply(413, { error: "Too large" });
    if (text === TIMED_OUT) return reply(408, { error: "The request took too long; try again" });
    try {
      body = JSON.parse(text || "{}");
    } catch {
      return reply(400, { error: "Bad JSON" });
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return reply(400, { error: "Bad request" });
    // The write happens now, not when the request began: its time, and for a
    // guest the check that the page is still shared with them.
    now = clock();
    ctx.now = now;
    if (viewer.role === "guest") {
      const refused = await guestRefusal(env, slug, identity, fetchImpl, now);
      if (refused) return refused;
    }
  }

  const db = env.COMMENTS;
  try {
    if (action === "threads") {
      if (request.method === "GET") return reply(200, { viewer, threads: await listThreads(db, ctx, viewer) });
      return await createThread(db, ctx, page, viewer, body);
    }
    const postOnly = () => reply(405, { error: "Method not allowed" }, { Allow: "POST" });

    const threadAction = action.match(/^threads\/([^/]+)\/(replies|resolve|reopen)$/);
    if (threadAction) {
      const [, id, verb] = threadAction;
      if (request.method !== "POST") return postOnly();
      if (!THREAD_ID.test(id)) return reply(404, { error: "No such thread" });
      const guest = viewer.role === "guest";
      // A guest acts only in a thread they started; the owner in any.
      const mine = guest ? " AND created_by = ?" : "";
      const mineParams = guest ? [viewer.email] : [];
      // Each write checks its own conditions (thread live, whose it is, caps)
      // in the same statement, so overlapping requests can't slip past a cap.
      let changed;
      if (verb === "replies") {
        const text = cleanBody(body.body);
        if (!text) return reply(400, { error: `Write 1 to ${BODY_LIMIT} characters` });
        const limits = underLimits(ctx, viewer);
        changed = await db
          .prepare(
            `INSERT INTO comments (id, thread_id, author, author_kind, body, created_at)
             SELECT ?, ?, ?, ?, ?, ?
             WHERE EXISTS (SELECT 1 FROM threads WHERE id = ? AND slug = ? AND status != 'archived'${mine})
               AND ${guest
                 ? `(SELECT COUNT(*) FROM comments WHERE thread_id = ? AND author_kind = 'guest') < ${GUEST_COMMENTS_PER_THREAD}`
                 : `(SELECT COUNT(*) FROM comments WHERE thread_id = ? AND author_kind != 'guest') < ${COMMENTS_PER_THREAD}`}
               AND ${limits.sql}`,
          )
          .bind(newId("c"), id, viewer.email, viewer.role, text, now, id, slug, ...mineParams, id, ...limits.params)
          .run();
      } else if (verb === "resolve") {
        // A resolve note is the owner's (agents write theirs from the Mac); a
        // guest's would be guest text outside their comments.
        const note = guest || body.note === undefined || body.note === "" ? null : cleanBody(body.note, RESOLUTION_LIMIT);
        if (!guest && body.note !== undefined && body.note !== "" && !note) return reply(400, { error: "Bad resolve note" });
        const version = body.pageVersion === undefined ? null : String(body.pageVersion);
        if (version !== null && !VERSION.test(version)) return reply(400, { error: "Bad page version" });
        changed = await db
          .prepare(`UPDATE threads SET status = 'resolved', resolved_by = ?, resolved_at = ?, resolution = ?, resolved_in = ? WHERE id = ? AND slug = ? AND status != 'archived'${mine}`)
          .bind(viewer.email, now, note, version, id, slug, ...mineParams)
          .run();
      } else {
        const cap = openCap(ctx, viewer);
        changed = await db
          .prepare(
            `UPDATE threads SET status = 'open', resolved_by = NULL, resolved_at = NULL, resolution = NULL, resolved_in = NULL
             WHERE id = ? AND slug = ? AND status = 'resolved'${mine}
               AND ${cap.sql}`,
          )
          .bind(id, slug, ...mineParams, ...cap.params)
          .run();
      }
      if (!changes(changed)) {
        const current = await db.prepare("SELECT status, created_by FROM threads WHERE id = ? AND slug = ?").bind(id, slug).first();
        if (!current || current.status === "archived" || !canSee(ctx, viewer, current.created_by)) return reply(404, { error: "No such thread" });
        if (guest && current.created_by !== viewer.email) {
          return reply(403, {
            error: verb === "replies"
              ? `Only ${viewer.ownerName} and agents reply in this thread. To add something, start a new comment on this block.`
              : `Only ${viewer.ownerName} can ${verb} this thread.`,
          });
        }
        if (!(verb === "reopen" && current.status === "open")) return reply(429, { error: limitMessage(viewer) });
      }
      return reply(200, { thread: await loadThread(db, ctx, viewer, id) });
    }

    const deleteAction = action.match(/^comments\/([^/]+)\/delete$/);
    if (deleteAction) {
      const [, id] = deleteAction;
      if (request.method !== "POST") return postOnly();
      if (!COMMENT_ID.test(id)) return reply(404, { error: "No such comment" });
      const row = await db
        .prepare("SELECT c.id, c.author, c.thread_id FROM comments c JOIN threads t ON t.id = c.thread_id WHERE c.id = ? AND t.slug = ? AND t.status != 'archived' AND c.deleted_at IS NULL")
        .bind(id, slug)
        .first();
      // A guest learns nothing about comments that aren't theirs.
      if (!row || (viewer.role === "guest" && row.author !== viewer.email)) return reply(404, { error: "No such comment" });
      if (row.author !== viewer.email && viewer.role !== "owner") return reply(403, { error: "Not your comment" });
      // The last live comment going takes its thread with it, so an empty
      // thread never counts against the page's open threads.
      await db.batch([
        db.prepare("UPDATE comments SET body = '', deleted_at = ? WHERE id = ? AND deleted_at IS NULL").bind(now, id),
        db
          .prepare("UPDATE threads SET status = 'archived' WHERE id = ? AND NOT EXISTS (SELECT 1 FROM comments WHERE thread_id = ? AND deleted_at IS NULL)")
          .bind(row.thread_id, row.thread_id),
      ]);
      return reply(200, { thread: await loadThread(db, ctx, viewer, row.thread_id) });
    }

    return reply(404, { error: "Not found" });
  } catch (error) {
    console.error("comments:", error && error.message);
    return reply(500, { error: "Comments are unavailable right now" });
  }
}

async function createThread(db, ctx, page, viewer, body) {
  const { slug, now } = ctx;
  const anchor = typeof body.anchor === "string" ? body.anchor : "";
  if (!ANCHOR.test(anchor) || (anchor !== "page" && !page.anchors.has(anchor))) return reply(400, { error: "That block isn't on this page" });
  const text = cleanBody(body.body);
  if (!text) return reply(400, { error: `Write 1 to ${BODY_LIMIT} characters` });
  const version = String(body.pageVersion ?? "");
  if (!VERSION.test(version)) return reply(400, { error: "Bad page version" });
  const fp = body.fp === undefined || body.fp === null || body.fp === "" ? null : String(body.fp);
  if (fp !== null && !FP.test(fp)) return reply(400, { error: "Bad fingerprint" });
  const quote = cleanQuote(body.quote, QUOTE_LIMIT);
  const prefix = cleanQuote(body.prefix, CONTEXT_LIMIT);
  const suffix = cleanQuote(body.suffix, CONTEXT_LIMIT);
  if (quote === false || prefix === false || suffix === false) return reply(400, { error: "Bad quote" });

  // Both inserts carry the caps (open threads, the writer's rate), so
  // overlapping requests can't pass them; the comment needs the thread.
  const id = newId("t");
  const limits = underLimits(ctx, viewer);
  const cap = openCap(ctx, viewer);
  await db.batch([
    db
      .prepare(
        `INSERT INTO threads (id, slug, anchor_id, anchor_kind, anchor_fp, quote, quote_prefix, quote_suffix, page_version, status, created_by, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?
         WHERE ${cap.sql}
           AND ${limits.sql}`,
      )
      .bind(id, slug, anchor, anchorKind(anchor), fp, quote || null, prefix || null, suffix || null, version, viewer.email, now, ...cap.params, ...limits.params),
    db
      .prepare("INSERT INTO comments (id, thread_id, author, author_kind, body, created_at) SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM threads WHERE id = ?)")
      .bind(newId("c"), id, viewer.email, viewer.role, text, now, id),
  ]);
  const thread = await loadThread(db, ctx, viewer, id);
  if (!thread) return reply(429, { error: limitMessage(viewer) });
  return reply(201, { thread });
}

const HOUR = 3_600_000;
const DAY = 86_400_000;

// The rate check that rides in a write's WHERE clause. The owner: fewer than
// PAGE_WRITES_PER_DAY of their own comments on this page in the last day (a
// runaway script, not a person, would hit it). A guest: their own comments
// anywhere on the site, deleted ones included, under the hourly and daily
// limits.
function underLimits({ slug, now }, viewer) {
  if (viewer.role === "owner") {
    return {
      sql: `(SELECT COUNT(*) FROM comments c JOIN threads t ON t.id = c.thread_id WHERE t.slug = ? AND c.author_kind = 'owner' AND c.created_at > ?) < ${PAGE_WRITES_PER_DAY}`,
      params: [slug, now - DAY],
    };
  }
  return {
    sql: `(SELECT COUNT(*) FROM comments WHERE author = ? AND created_at > ?) < ${GUEST_PER_HOUR}
           AND (SELECT COUNT(*) FROM comments WHERE author = ? AND created_at > ?) < ${GUEST_PER_DAY}`,
    params: [viewer.email, now - HOUR, viewer.email, now - DAY],
  };
}

// Room for one more open thread on the page: the owner's and agents' threads
// for the owner, the guest's own for a guest.
function openCap({ slug, owner }, viewer) {
  if (viewer.role === "owner") {
    return {
      sql: `(SELECT COUNT(*) FROM threads WHERE slug = ? AND status = 'open' AND (created_by = ? OR created_by LIKE 'agent:%')) < ${OPEN_THREADS_PER_PAGE}`,
      params: [slug, owner],
    };
  }
  return {
    sql: `(SELECT COUNT(*) FROM threads WHERE slug = ? AND status = 'open' AND created_by = ?) < ${GUEST_OPEN_THREADS_PER_PAGE}`,
    params: [slug, viewer.email],
  };
}

function limitMessage(viewer) {
  return viewer.role === "guest"
    ? `You've reached the comment limit for now (${GUEST_PER_HOUR} an hour, ${GUEST_PER_DAY} a day, ${GUEST_OPEN_THREADS_PER_PAGE} open threads per page, ${GUEST_COMMENTS_PER_THREAD} comments per thread). Try again later.`
    : `This page is at its limit (${OPEN_THREADS_PER_PAGE} open threads, ${PAGE_WRITES_PER_DAY} of your comments a day)`;
}

function changes(result) {
  return Number(result?.meta?.changes ?? 0);
}

// ---- reading ------------------------------------------------------------------

// What a viewer may see. The owner: every thread. A guest: threads the owner
// or an agent started, and their own; within them, the owner's, agents' and
// their own comments. ?1 is the slug, ?2 the owner, ?3 the guest.
const GUEST_THREADS = "(created_by = ?2 OR created_by LIKE 'agent:%' OR created_by = ?3)";
const GUEST_COMMENTS = "(author_kind IN ('owner', 'agent') OR author = ?3)";

function canSee({ owner }, viewer, createdBy) {
  return viewer.role === "owner" || createdBy === owner || createdBy.startsWith("agent:") || createdBy === viewer.email;
}

// Every open thread on the page, plus the most recently resolved ones.
function shownIds(guest) {
  const only = guest ? ` AND ${GUEST_THREADS}` : "";
  return `SELECT id FROM threads WHERE slug = ?1 AND status = 'open'${only}
    UNION ALL SELECT id FROM (SELECT id FROM threads WHERE slug = ?1 AND status = 'resolved'${only} ORDER BY resolved_at DESC LIMIT ${RESOLVED_SHOWN})`;
}

async function listThreads(db, ctx, viewer) {
  const guest = viewer.role === "guest";
  const params = guest ? [ctx.slug, ctx.owner, viewer.email] : [ctx.slug];
  const threads = (await db.prepare(`SELECT * FROM threads WHERE id IN (${shownIds(guest)}) ORDER BY created_at`).bind(...params).all()).results || [];
  const comments =
    (await db
      .prepare(`SELECT * FROM comments WHERE thread_id IN (${shownIds(guest)})${guest ? ` AND ${GUEST_COMMENTS}` : ""} ORDER BY created_at, id`)
      .bind(...params)
      .all()).results || [];
  return markAccess(ctx, viewer, shapeThreads(threads, comments, ctx.owner));
}

async function loadThread(db, ctx, viewer, id) {
  const thread = await db.prepare("SELECT * FROM threads WHERE id = ? AND slug = ?").bind(id, ctx.slug).first();
  if (!thread || !canSee(ctx, viewer, thread.created_by)) return null;
  const guest = viewer.role === "guest";
  const comments =
    (await db
      .prepare(`SELECT * FROM comments WHERE thread_id = ?1${guest ? ` AND ${GUEST_COMMENTS}` : ""} ORDER BY created_at, id`)
      .bind(...(guest ? [id, ctx.owner, viewer.email] : [id]))
      .all()).results || [];
  return (await markAccess(ctx, viewer, shapeThreads([thread], comments, ctx.owner)))[0] || null;
}

// For the owner: flag guests the page is no longer shared with. Best effort;
// if Access can't be asked, nothing is flagged.
async function markAccess(ctx, viewer, threads) {
  if (viewer.role !== "owner" || !threads.some((t) => t.comments.some((c) => c.authorKind === "guest"))) return threads;
  let rule;
  try {
    rule = await pageRule(ctx.env, ctx.slug, ctx.fetchImpl, ctx.now);
  } catch {
    return threads;
  }
  const guests = new Set(rule?.guests || []);
  for (const thread of threads) {
    for (const comment of thread.comments) if (comment.authorKind === "guest" && !guests.has(comment.author)) comment.noAccess = true;
  }
  return threads;
}

// A thread whose every comment was deleted is gone from the page.
export function shapeThreads(threads, comments, owner) {
  const byThread = new Map(threads.map((t) => [t.id, []]));
  for (const c of comments) {
    byThread.get(c.thread_id)?.push({
      id: c.id,
      author: c.author,
      authorKind: c.author_kind,
      body: c.deleted_at ? "" : c.body,
      deleted: Boolean(c.deleted_at),
      createdAt: c.created_at,
    });
  }
  return threads
    .map((t) => ({
      id: t.id,
      anchor: t.anchor_id,
      anchorKind: t.anchor_kind,
      fp: t.anchor_fp || "",
      quote: t.quote || "",
      prefix: t.quote_prefix || "",
      suffix: t.quote_suffix || "",
      pageVersion: t.page_version,
      status: t.status,
      createdBy: t.created_by,
      createdAt: t.created_at,
      resolvedBy: t.resolved_by || null,
      createdByKind: t.created_by === owner ? "owner" : t.created_by.startsWith("agent:") ? "agent" : "guest",
      resolvedByKind: !t.resolved_by ? null : t.resolved_by === owner ? "owner" : t.resolved_by.startsWith("agent:") ? "agent" : "guest",
      resolvedAt: t.resolved_at || null,
      resolution: t.resolution || null,
      resolvedIn: t.resolved_in || null,
      comments: byThread.get(t.id),
    }))
    .filter((t) => t.comments.some((c) => !c.deleted));
}

// ---- page config ----------------------------------------------------------------

const pageCache = new Map();

async function pageConfig(env, url, slug) {
  if (!SLUG.test(slug)) return null;
  if (pageCache.has(slug)) return pageCache.get(slug);
  const response = await env.ASSETS.fetch(new Request(new URL(`/_share/comments/${slug}.json`, url), { redirect: "manual" }));
  let page = null;
  if (response.status === 200) {
    const data = await response.json().catch(() => null);
    if (data && Array.isArray(data.anchors)) {
      page = {
        anchors: new Set(data.anchors.filter((a) => typeof a === "string")),
        aud: typeof data.aud === "string" ? data.aud : null,
      };
    }
  }
  pageCache.set(slug, page);
  return page;
}

// null when the guest may use this page now, else the response refusing them.
// The page's own rule, by audience and by its list right now: not the
// site-wide rule, a manifest's memory of a rule, or another page's rule.
async function guestRefusal(env, slug, identity, fetchImpl, now) {
  let rule;
  try {
    rule = await pageRule(env, slug, fetchImpl, now);
  } catch (error) {
    console.error("comments: page rule lookup:", error && error.message);
    return reply(503, { error: "Couldn't check who this page is shared with; try again in a minute" });
  }
  if (!rule || identity.aud !== rule.aud || !rule.guests.includes(identity.email)) {
    return reply(403, { error: "This page isn't shared with you" });
  }
  return null;
}

// The page's own Access rule as Access holds it now: {aud, guests}, or null
// when the page isn't shared. Only a rule of the shape share.mjs makes counts
// (access.mjs's audit: tagged, one destination, one allow policy of plain
// emails). Used for a page shared after the last publish, for every guest
// request, and to flag guests who lost access. Remembered for a minute; a
// failed lookup throws and isn't remembered.
const ruleCache = new Map();

async function pageRule(env, slug, fetchImpl, now) {
  if (!env.ACCESS_API_TOKEN || !env.ACCOUNT_ID) return null;
  const cached = ruleCache.get(slug);
  if (cached && now - cached.at < 60_000) return cached.rule;
  const client = new AccessClient({ token: env.ACCESS_API_TOKEN, accountId: env.ACCOUNT_ID, fetchImpl });
  const { pages } = auditApps(await client.listApps(), { host: env.HOST, owner: env.OWNER, publishedSlugs: null, guestIdps: null });
  const found = pages.get(slug);
  const rule = found && found.app.aud ? { aud: found.app.aud, guests: found.guests } : null;
  ruleCache.set(slug, { at: now, rule });
  return rule;
}

// Test hook: each deployment is a fresh isolate, but tests reuse one module.
export function resetCommentsCaches() {
  pageCache.clear();
  ruleCache.clear();
}

// ---- input -------------------------------------------------------------------

const TIMED_OUT = Symbol("timed out");

// The body as text; null if it's over the limit, TIMED_OUT if it doesn't
// arrive within ms (a stalled upload mustn't hold a write past a revocation).
async function readLimited(request, limit, ms) {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  const deadline = Date.now() + ms;
  for (;;) {
    let timer;
    const late = new Promise((done) => (timer = setTimeout(() => done(TIMED_OUT), Math.max(0, deadline - Date.now()))));
    const next = await Promise.race([reader.read(), late]);
    clearTimeout(timer);
    if (next === TIMED_OUT) {
      // Not awaited: a cancel that never settles mustn't hold the answer.
      reader.cancel().catch(() => {});
      return TIMED_OUT;
    }
    const { done, value } = next;
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

// Plain text: Unicode-normalised, newlines kept, every other control
// character dropped (tabs become spaces), trimmed. Returns "" when the result
// is empty or longer than the limit.
export function cleanBody(value, limit = BODY_LIMIT) {
  if (typeof value !== "string") return "";
  const text = value
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u2028\u2029]/g, "")
    .trim();
  return text.length >= 1 && text.length <= limit ? text : "";
}

// Optional quote text on one line. undefined/null/"" → "", too long or not a
// string → false.
function cleanQuote(value, limit) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") return false;
  const text = value.normalize("NFC").replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]+/g, " ").replace(/ {2,}/g, " ");
  return text.length <= limit ? text : false;
}

export function anchorKind(anchor) {
  if (anchor === "page") return "page";
  if (/^chart:[^/]+\/(row:.+|total)$/.test(anchor)) return "chart-mark";
  if (anchor.startsWith("chart:")) return "chart";
  if (/\.p\d+$/.test(anchor)) return "paragraph";
  if (/\.b\d+$/.test(anchor)) return "bullet";
  if (anchor === "title" || anchor === "summary") return "heading";
  if (anchor.startsWith("task-")) return "task";
  return "block";
}

export function newId(prefix) {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let random = "";
  for (const b of bytes) random += alphabet[b & 31];
  return `${prefix}_${Date.now().toString(36)}${random}`;
}

function rawPath(href) {
  const afterScheme = href.replace(/^[a-z]+:\/\/[^/]*/i, "");
  return afterScheme.split(/[?#]/)[0];
}
