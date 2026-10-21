#!/usr/bin/env node

// A compact, offline index of an artifacts root for agents working on this
// machine: they read the files directly, so fetching the published registry
// (behind Access) would cost a login and a network round trip for data that is
// already on disk. Prints the status note to start from, then one line per note
// and per live artifact; superseded/archived artifacts are only counted unless
// --all is passed.

import { readdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { hubSlug } from "./hubs.mjs";
import { discoverNotes, isStaleStatus, NOTE_KINDS, parseNote } from "./notes.mjs";

const args = process.argv.slice(2);
if (!args.length || args.includes("--help") || args.includes("-h")) {
  console.log("Usage: context-index.mjs <artifacts-root> [project] [--all]");
  process.exit(args.length ? 0 : 1);
}
const showAll = args.includes("--all");
const [rootArg, project] = args.filter((arg) => arg !== "--all");
const root = resolve(rootArg);
if (!(await stat(root).catch(() => null))?.isDirectory()) {
  console.error(`ERROR: ${root} is not a directory`);
  process.exit(1);
}

const inProject = (value) => !project || value === project || hubSlug(value) === project;
const newestFirst = (a, b) => String(b.updated || "").localeCompare(String(a.updated || ""));

const { notes: found } = await discoverNotes(root);
const notes = found
  .map((note) => {
    const { fields, errors } = parseNote(note.text ?? "");
    return { path: note.path, id: note.id, fields, broken: note.text === null || errors.length > 0 };
  })
  .filter((note) => inProject(note.fields.project))
  .sort(
    (a, b) =>
      NOTE_KINDS.indexOf(a.fields.kind) - NOTE_KINDS.indexOf(b.fields.kind) ||
      String(a.fields.project).localeCompare(String(b.fields.project)) ||
      newestFirst(a.fields, b.fields),
  );

const artifacts = [];
for (const entry of await readdir(root, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name.startsWith(".") || ["archive", "notes", "projects"].includes(entry.name)) continue;
  let data = null;
  for (const marker of ["artifact.json", "static-artifact.json"]) {
    try {
      data = JSON.parse(await readFile(resolve(root, entry.name, marker), "utf8"));
      break;
    } catch {}
  }
  if (!data || !inProject(data.project)) continue;
  artifacts.push({ slug: entry.name, ...data, lifecycle: data.lifecycle || "active" });
}
const isStale = (a) => a.lifecycle === "superseded" || a.lifecycle === "archived";
const live = artifacts.filter((a) => !isStale(a)).sort(newestFirst);
const stale = artifacts.filter(isStale).sort(newestFirst);

const lines = [`# Context index: ${root}${project ? ` · project ${project}` : ""} (paths relative to the root)`];

const statusPaths = project
  ? [`notes/${project}/status.md`]
  : notes.filter((n) => n.fields.kind === "status").map((n) => n.path);
const starts = [];
for (const path of statusPaths) {
  if (await stat(resolve(root, path)).catch(() => null)) starts.push(path);
}
lines.push(starts.length ? `Start here: ${starts.join(", ")}` : "No status note yet.");

lines.push("", `Notes (${notes.length}):`);
for (const note of notes) {
  const f = note.fields;
  const flags = [
    note.broken && "invalid frontmatter",
    isStaleStatus(f) && "stale",
  ].filter(Boolean);
  lines.push(`- ${note.path} · ${f.kind || "?"} · ${f.updated || "?"} · ${f.title || "(untitled)"}${flags.length ? ` [${flags.join(", ")}]` : ""}`);
}

lines.push("", `Artifacts (${live.length} live${stale.length ? `, ${stale.length} superseded/archived` : ""}):`);
for (const a of showAll ? [...live, ...stale] : live) {
  const replacement = a.lifecycle === "superseded" && a.supersededBy ? ` → ${a.supersededBy}` : "";
  lines.push(`- ${a.slug}/ · ${a.lifecycle}${replacement} · ${a.updated || "?"} · ${a.title || a.slug}`);
}
if (stale.length && !showAll) lines.push(`+ ${stale.length} superseded/archived not listed (--all to include)`);
lines.push("", "Read notes/<path>.md and <slug>/artifact.md directly; verify a note against reality before acting on it.");

console.log(lines.join("\n"));
