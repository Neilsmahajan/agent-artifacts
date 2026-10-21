// Preloaded into scripts/comments.mjs by comments-cli.test.mjs (node --import):
// stands in for the Cloudflare API. D1 queries run against the SQLite file in
// MOCK_D1 (loaded with the real schema by the test); the Access app list is
// MOCK_APPS (JSON). Anything else fails, so the CLI can't reach the network.

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(process.env.MOCK_D1);

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (/\/d1\/database\/[^/]+\/query$/.test(u)) {
    const { sql, params } = JSON.parse(init.body);
    try {
      const results = db.prepare(sql).all(...params);
      return Response.json({ success: true, result: [{ success: true, results }] });
    } catch (error) {
      return Response.json({ success: false, errors: [{ code: 7500, message: error.message }] }, { status: 400 });
    }
  }
  if (/\/access\/apps\?/.test(u)) {
    const apps = JSON.parse(process.env.MOCK_APPS || readFileSync(process.env.MOCK_APPS_FILE, "utf8"));
    return Response.json({ success: true, result: apps, result_info: { page: 1, per_page: 100, total_count: apps.length } });
  }
  return new Response(`unmocked ${u}`, { status: 599 });
};
