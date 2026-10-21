// Cloudflare Access login tokens (the Cf-Access-Jwt-Assertion header Access
// adds to every request it lets through). Shared by the Share helper and the
// comments API: an RS256 signature against the team's published certs, then
// issuer, audience and expiry. The browser never gets to state who it is.

let certCache = { at: 0, keys: [] };

// `audiences` is a list of accepted Access application audiences, or an async
// predicate for ones only known at request time (a page rule created after the
// last publish). The predicate runs only once the signature and issuer check out.
export async function verifyAccessToken(token, { teamDomain, audiences }, now = Date.now(), fetchImpl = fetch) {
  if (!token) return { ok: false, error: "No Access login" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, error: "Malformed login token" };
  let header;
  let payload;
  try {
    header = JSON.parse(b64urlText(parts[0]));
    payload = JSON.parse(b64urlText(parts[1]));
  } catch {
    return { ok: false, error: "Malformed login token" };
  }
  if (!header || !payload || typeof payload !== "object") return { ok: false, error: "Malformed login token" };
  if (header.alg !== "RS256" || !header.kid) return { ok: false, error: "Unexpected token algorithm" };

  if (now - certCache.at > 10 * 60 * 1000 || !certCache.keys.some((k) => k.kid === header.kid)) {
    const res = await fetchImpl(`https://${teamDomain}/cdn-cgi/access/certs`);
    if (!res.ok) return { ok: false, error: "Couldn't fetch Access certs" };
    certCache = { at: now, keys: (await res.json()).keys || [] };
  }
  const jwk = certCache.keys.find((k) => k.kid === header.kid);
  if (!jwk) return { ok: false, error: "Unknown signing key" };
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!valid) return { ok: false, error: "Bad token signature" };

  const seconds = Math.floor(now / 1000);
  const aud = (Array.isArray(payload.aud) ? payload.aud : [payload.aud]).filter((a) => typeof a === "string" && a);
  if (payload.iss !== `https://${teamDomain}`) return { ok: false, error: "Wrong token issuer" };
  if (typeof payload.exp !== "number" || payload.exp < seconds) return { ok: false, error: "Login expired; reload" };
  if (typeof payload.nbf === "number" && payload.nbf > seconds + 60) return { ok: false, error: "Token not yet valid" };
  const accepted = Array.isArray(audiences)
    ? aud.find((a) => audiences.includes(a))
    : await firstAccepted(aud, audiences);
  if (!accepted) return { ok: false, error: "Token is for a different Access rule" };
  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  if (!email) return { ok: false, error: "Token has no email" };
  return { ok: true, email, aud: accepted };
}

async function firstAccepted(list, predicate) {
  for (const a of list) if (await predicate(a)) return a;
  return null;
}

export function resetCertCache() {
  certCache = { at: 0, keys: [] };
}

function b64urlBytes(text) {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function b64urlText(text) {
  return new TextDecoder().decode(b64urlBytes(text));
}
