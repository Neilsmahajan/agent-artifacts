// Pages "advanced mode" worker for a hub site. publish-pages.mjs ships this
// directory as _worker.js/ in the upload root, together with a _routes.json
// that sends only /_link, /_link/*, /_share/api/* and /*/_comments/* here;
// every other path is served straight from static assets and never runs this
// code.
//
// /_link/<code>/<rest> is "anyone with the link" sharing. An Access application
// with a Bypass policy covers exactly /_link on the apex, so these requests
// arrive without a login. Everything else on the site stays behind Access, and
// env.ASSETS.fetch below reads files without going back through it — so this
// file is the whole boundary. It fails closed: anything it does not recognise
// is a 404 (or, for a malformed code, a redirect to the normal, login-protected
// address).
//
// KV binding LINKS holds "code:<code>" → slug. The publish step writes the
// list of link-shareable pages to /_share/pages.json ({pages: {slug: {kind}}});
// a code whose slug is not in it serves nothing.

import { handleCommentsApi } from "./comments-api.js";
import { handleShareApi } from "./share-api.js";

const CODE = /^[A-Za-z0-9_-]{43}$/;
const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

// Mirrors assets/pages-root/_headers and the static-artifact override in
// publish-pages.mjs. _headers is not guaranteed to apply to a Function's
// response, so every response from here carries the full set itself.
const CSP = {
  artifact:
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  static:
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-src 'self'; frame-ancestors 'self'; form-action 'none'",
};

const BASE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/_link" || url.pathname.startsWith("/_link/")) {
      return serveLink(request, env, url);
    }
    if (url.pathname.startsWith("/_share/api/")) {
      return handleShareApi(request, env, url);
    }
    // /<slug>/_comments/*. The route also matches deeper paths and the bare
    // /<slug>/_comments; the handler refuses anything that isn't a page's
    // comments, and answers in JSON rather than falling through to a
    // redirecting asset lookup.
    if (/\/_comments(\/|$)/.test(url.pathname)) {
      return handleCommentsApi(request, env, url);
    }
    // _routes.json should keep every other path away from this worker; if one
    // arrives anyway it already passed Access, so serve it as Pages would.
    return env.ASSETS.fetch(request);
  },
};

export async function serveLink(request, env, url) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return plain(405, "Method not allowed", { Allow: "GET, HEAD" });
  }
  // Percent-encoding and backslashes are never needed in a link address and
  // are how path tricks get past string checks, so refuse them outright. The
  // raw request URL is checked too, before WHATWG parsing normalised it.
  if (/%|\\/.test(url.pathname) || /%|\\/.test(rawPath(request.url))) return notFound();

  const [, , code = "", ...rest] = url.pathname.split("/");
  if (!rest.every((segment, i) => (segment === "" ? i === rest.length - 1 : SEGMENT.test(segment)))) {
    return notFound();
  }

  // Not a code: a relative link inside a shared page (../other-page/ resolves
  // to /_link/other-page/) or a bare /_link/. Send it to the same address
  // without /_link/, where the normal Access login applies.
  if (!CODE.test(code)) {
    if (code !== "" && !SEGMENT.test(code)) return notFound();
    const target = "/" + [code, ...rest].filter((s, i, all) => s !== "" || i === all.length - 1).join("/");
    return redirect(target === "//" ? "/" : target);
  }

  const slug = await env.LINKS.get(`code:${code}`);
  if (!slug || !SLUG.test(slug)) return notFound();
  const page = (await manifest(env, url))[slug];
  if (!page) return notFound();

  if (rest.length === 0) return redirect(`/_link/${code}/`);

  const assetUrl = new URL(`/${slug}/${rest.join("/")}`, url);
  const asset = await env.ASSETS.fetch(new Request(assetUrl, { method: request.method, redirect: "manual" }));

  if (asset.status >= 300 && asset.status < 400) {
    // Pages canonicalises (/x/index.html → /x/, /x → /x/). Follow that only
    // when it stays inside the page, and re-point it under /_link/<code>/.
    const location = asset.headers.get("location");
    if (!location) return notFound();
    const next = new URL(location, assetUrl);
    if (next.origin !== url.origin || !next.pathname.startsWith(`/${slug}/`)) return notFound();
    return redirect(`/_link/${code}/${next.pathname.slice(slug.length + 2)}`);
  }
  if (asset.status !== 200) return notFound();

  const headers = new Headers(BASE_HEADERS);
  headers.set("Content-Security-Policy", CSP[page.kind === "static" ? "static" : "artifact"]);
  const type = asset.headers.get("content-type");
  if (type) headers.set("Content-Type", type);
  return new Response(request.method === "HEAD" ? null : asset.body, { status: 200, headers });
}

let cachedManifest;
async function manifest(env, url) {
  if (cachedManifest) return cachedManifest;
  const response = await env.ASSETS.fetch(new Request(new URL("/_share/pages.json", url), { redirect: "manual" }));
  if (response.status !== 200) return {};
  const data = await response.json().catch(() => null);
  const pages = data && typeof data.pages === "object" && data.pages ? data.pages : {};
  cachedManifest = pages;
  return pages;
}

// Test hook: each deployment is a fresh isolate, but tests reuse one module.
export function resetManifestCache() {
  cachedManifest = undefined;
}

function rawPath(href) {
  const afterScheme = href.replace(/^[a-z]+:\/\/[^/]*/i, "");
  return afterScheme.split(/[?#]/)[0];
}

function redirect(location) {
  return new Response(null, { status: 302, headers: { ...BASE_HEADERS, Location: location } });
}

function notFound() {
  return plain(404, "Not found. This link may have been revoked.");
}

function plain(status, text, extra = {}) {
  return new Response(text, {
    status,
    headers: {
      ...BASE_HEADERS,
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'",
      ...extra,
    },
  });
}
