#!/usr/bin/env node

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

const root = resolve(process.argv[2] || ".");
const requestedPort = Number(process.env.ARTIFACT_PORT || process.argv[3] || 4173);
const mime = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};
// Mirrors assets/pages-root/_headers. Built artifacts inline their CSS and JS,
// which rules out script-src 'self'; everything unused is denied instead.
const securityHeaders = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow",
};

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost");
    const pathname = decodeURIComponent(url.pathname);
    const candidate = resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    const info = await stat(candidate);
    const path = info.isDirectory() ? resolve(candidate, "index.html") : candidate;
    const body = await readFile(path);
    response.writeHead(200, {
      ...securityHeaders,
      "Content-Type": mime[extname(path)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    response.end(body);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
  }
});

server.listen(requestedPort, "127.0.0.1", () => {
  const address = server.address();
  console.log(`Previewing ${root}`);
  console.log(`http://127.0.0.1:${address.port}`);
  console.log("Press Ctrl+C to stop.");
});
