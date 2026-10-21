// A D1-shaped wrapper over node:sqlite, loaded with assets/comments/schema.sql,
// so tests run the comments SQL for real. Only what the worker uses:
// prepare().bind().first()/all()/run() and batch().

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const schema = resolve(dirname(fileURLToPath(import.meta.url)), "../assets/comments/schema.sql");

export function d1() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(schema, "utf8"));
  const statement = (sql, params = []) => ({
    bind: (...values) => statement(sql, values),
    first: async () => db.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params) }),
    run: async () => ({ success: true, meta: { changes: Number(db.prepare(sql).run(...params).changes) } }),
    exec: () => ({ success: true, meta: { changes: Number(db.prepare(sql).run(...params).changes) } }),
  });
  return {
    raw: db,
    prepare: (sql) => statement(sql),
    batch: async (list) => {
      db.exec("BEGIN");
      try {
        const results = list.map((s) => s.exec());
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
