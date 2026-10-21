#!/usr/bin/env node

// Validates notes: an artifacts root (every notes/**/*.md), a notes/ directory,
// or individual note files. publish-pages.mjs runs the same validateNote() on
// every note it is about to ship, so a note that passes here publishes.

import { stat } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { readFile } from "node:fs/promises";

import { diskLinkResolver, discoverNotes, hasFrontmatter, validateNote } from "./notes.mjs";

const targets = process.argv.slice(2);
if (!targets.length || targets.includes("--help") || targets.includes("-h")) {
  console.log("Usage: validate-notes.mjs <artifacts-root | notes-dir | note.md>...");
  process.exit(targets.length ? 0 : 1);
}

// The id (path under notes/ without .md) matters for URL-safety checks, so a
// single file is placed relative to its nearest enclosing notes/ directory.
function idFor(file) {
  const parts = file.split(sep);
  const at = parts.lastIndexOf("notes");
  const rel = at >= 0 && at < parts.length - 1 ? parts.slice(at + 1).join("/") : basename(file);
  return rel.replace(/\.md$/, "");
}

const notes = [];
let ignoredCount = 0;
for (const target of targets.map((t) => resolve(t))) {
  const info = await stat(target).catch(() => null);
  if (!info) {
    console.error(`ERROR: ${target} does not exist`);
    process.exitCode = 1;
    continue;
  }
  if (info.isFile()) {
    const bytes = await readFile(target);
    let text = null;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {}
    const path = relative(process.cwd(), target) || target;
    if (text !== null && !hasFrontmatter(text)) {
      console.warn(`WARN: ${path}: ignored (no --- frontmatter, so not a note) — it will not be published`);
      ignoredCount += 1;
      continue;
    }
    notes.push({ id: idFor(target), path, file: target, text });
    continue;
  }
  const root = basename(target) === "notes" ? dirname(target) : target;
  const found = await discoverNotes(root);
  if (!found.notes.length && !found.ignored.length) console.warn(`WARN: no notes under ${resolve(root, "notes")}`);
  for (const { path, reason } of found.ignored) {
    console.warn(`WARN: ${path}: ignored (${reason}) — it will not be published`);
    ignoredCount += 1;
  }
  notes.push(...found.notes);
}

let failed = 0;
for (const note of notes) {
  if (note.text === null) {
    console.error(`ERROR: ${note.path}: not valid UTF-8`);
    failed += 1;
    continue;
  }
  const { errors, warnings } = validateNote({ id: note.id, text: note.text, resolveRelative: diskLinkResolver(note.file) });
  for (const warning of warnings) console.warn(`WARN: ${note.path}: ${warning}`);
  for (const error of errors) console.error(`ERROR: ${note.path}: ${error}`);
  if (errors.length) failed += 1;
}

if (failed || process.exitCode) {
  console.error(`Note validation failed: ${failed} of ${notes.length} note(s) have errors`);
  process.exit(1);
}
console.log(`Note validation passed: ${notes.length} note(s)${ignoredCount ? `, ${ignoredCount} non-note file(s) ignored` : ""}`);
