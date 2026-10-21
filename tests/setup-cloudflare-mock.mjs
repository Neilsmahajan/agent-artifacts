// Preloaded into scripts/setup.mjs by setup.test.mjs (node --import): a
// stand-in for the Cloudflare API whose state lives in the JSON file
// MOCK_STATE, so a test can look at it between runs and every call is logged
// in state.calls. D1 runs against the SQLite file MOCK_D1. Anything else
// fails, so setup.mjs can't reach the network.

import { readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const load = () => JSON.parse(readFileSync(process.env.MOCK_STATE, "utf8"));
const save = (state) => writeFileSync(process.env.MOCK_STATE, JSON.stringify(state, null, 2));
const ok = (result) => Response.json({ success: true, result, result_info: { page: 1, per_page: 100, total_count: Array.isArray(result) ? result.length : 1 } });
const missing = () => Response.json({ success: false, errors: [{ code: 7003, message: "not found" }] }, { status: 404 });

globalThis.fetch = async (url, init = {}) => {
  const state = load();
  const method = init.method || "GET";
  const path = String(url).replace("https://api.cloudflare.com/client/v4/", "");
  const body = init.body ? JSON.parse(init.body) : undefined;
  const auth = (init.headers?.Authorization || "").replace("Bearer ", "");
  state.calls.push({ method, path, auth: auth === state.accessToken ? "access" : "account" });
  save(state);
  const route = path.replace(/^accounts\/[^/]+\//, "");
  const access = route.startsWith("access/");
  if (access && auth !== state.accessToken) return Response.json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, { status: 403 });
  if (access && state.denied?.includes(route.split("?")[0])) return Response.json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, { status: 403 });

  const done = (result) => {
    save(state);
    return ok(result);
  };
  if (path.startsWith("accounts?")) return ok(state.accounts);
  let m;
  if ((m = /^pages\/projects\/([^/]+)$/.exec(route))) {
    const project = state.projects[m[1]];
    return project ? ok({ name: m[1], subdomain: project.subdomain, domains: [project.subdomain, ...(project.custom || [])], deployment_configs: { production: { env_vars: Object.fromEntries(project.secrets.map((n) => [n, { type: "secret_text", value: "" }])) } } }) : missing();
  }
  if (route.startsWith("storage/kv/namespaces")) {
    if (method === "POST") {
      const ns = { id: String(state.kv.length + 1).padStart(32, "a"), title: body.title };
      state.kv.push(ns);
      return done(ns);
    }
    const id = route.split("?")[0].split("/")[3];
    if (id) return state.kv.some((ns) => ns.id === id) ? ok({ id }) : missing();
    return ok(state.kv);
  }
  if ((m = /^d1\/database\/([^/?]+)\/query$/.exec(route))) {
    const db = new DatabaseSync(process.env.MOCK_D1);
    const { sql, params } = body;
    if (!params?.length && /CREATE TABLE/.test(sql)) {
      db.exec(sql);
      return ok([{ success: true, results: [] }]);
    }
    return ok([{ success: true, results: db.prepare(sql).all(...(params || [])) }]);
  }
  if (route.startsWith("d1/database")) {
    if (method === "POST") {
      const db = { uuid: `0000000${state.d1.length + 1}-0000-0000-0000-000000000000`, name: body.name };
      state.d1.push(db);
      return done(db);
    }
    const id = route.split("?")[0].split("/")[2];
    if (id) return state.d1.some((db) => db.uuid === id) ? ok({ uuid: id }) : missing();
    const name = new URL(`https://x/${route}`).searchParams.get("name");
    return ok(state.d1.filter((db) => db.name === name));
  }
  if ((m = /^workers\/scripts\/([^/]+)\/secrets$/.exec(route))) {
    const worker = state.workers[m[1]];
    return worker ? ok(worker.secrets.map((name) => ({ name, type: "secret_text" }))) : missing();
  }
  if (route === "access/organizations") return state.org ? ok(state.org) : missing();
  if (route === "access/identity_providers") return ok(state.idps);
  if (route === "access/tags") {
    if (method === "POST") state.tags.push({ name: body.name });
    return done(state.tags);
  }
  if (route.startsWith("access/apps")) {
    if (method === "POST") {
      const app = { id: `app-${state.apps.length + 1}`, aud: "aud", ...body };
      state.apps.push(app);
      return done(app);
    }
    return ok(state.apps);
  }
  if (route === "access/organizations/revoke_user") {
    state.revoked.push(body.email);
    return done(null);
  }
  return new Response(`unmocked ${path}`, { status: 599 });
};
