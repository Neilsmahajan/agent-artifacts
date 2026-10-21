// Notes: short living Markdown documents under <root>/notes/**/*.md — project
// status, references, people, a glossary. Unlike artifacts they are never
// pre-built into the source tree: publish-pages.mjs renders them straight into
// the staging directory, so nothing generated is ever committed beside them.
//
// A note is frontmatter (simple `key: value` lines between `---` lines) plus a
// Markdown body. Frontmatter is deliberately not YAML: one flat line per field
// is all a note needs, and a ten-line parser has no surprises.

import { existsSync } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { findLocalReferences, findSecrets } from "./content-checks.mjs";
import { renderMarkdownHtml, sanitizeMarkdownLinks } from "./markdown.mjs";
import { esc } from "./render.mjs";

export const NOTE_KINDS = ["status", "reference", "person", "glossary", "decisions"];
const NOTE_FIELDS = ["title", "project", "updated", "kind", "summary"];
export const VISIBILITY_REMOVED =
  "visibility was removed: delete the field; sharing is per page via share.mjs (or the Share screen)";
const REQUIRED_FIELDS = ["title", "project", "updated", "kind"];
// A note is a paragraph-scale document. One that outgrows this is a plan or a
// report, and belongs in an artifact the note links to.
export const NOTE_SIZE_WARN = 4 * 1024;
export const NOTE_SIZE_MAX = 12 * 1024;
export const STATUS_STALE_DAYS = 60;
// Projects become /projects/<project>/ URLs, and note paths become
// /notes/<path>/ URLs, so both are held to URL-safe names.
export const PROJECT_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

const DAY_MS = 24 * 60 * 60 * 1000;

// Splits frontmatter from body. Never throws: structural problems come back as
// errors, alongside whatever fields could be read.
export function parseNote(text) {
  const source = String(text ?? "").replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const lines = source.split("\n");
  const errors = [];
  const entries = new Map();
  if (lines[0].trim() !== "---") {
    return { fields: {}, body: source, errors: ["missing frontmatter — the file must start with a --- line"] };
  }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end < 0) {
    return { fields: {}, body: "", errors: ["frontmatter is not closed with a --- line"] };
  }
  for (let index = 1; index < end; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = /^([A-Za-z][A-Za-z0-9_-]*)[ \t]*:[ \t]*(.*)$/.exec(line);
    if (!match) {
      errors.push(`frontmatter line ${index + 1} is not "key: value" (nested YAML is not supported)`);
      continue;
    }
    const [, key, raw] = match;
    let value = raw.trim();
    if (value.length >= 2 && /^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    if (entries.has(key)) errors.push(`frontmatter repeats "${key}"`);
    else entries.set(key, value);
  }
  return { fields: Object.fromEntries(entries), body: lines.slice(end + 1).join("\n"), errors };
}

// Site-relative locations (no leading slash) for a note id such as
// "acme-app/status" (its path under notes/ without ".md").
export const notePageDir = (id) => `notes/${id}/`;
export const noteRawPath = (id) => `notes/${id}.md`;

// A relative href from a page directory ("notes/a/b/") to a site path
// ("/x/y"). Relative links keep the staged site working from any host,
// including the local preview server.
export function relativeFrom(pageDir, sitePath) {
  const depth = pageDir.split("/").filter(Boolean).length;
  return "../".repeat(depth) + sitePath.replace(/^\//, "") || "./";
}

// The set of site paths a publish will contain, for resolving note links.
export function createSiteIndex({ artifactSlugs = [], noteIds = [], hubSlugs = [] }) {
  const slugs = new Set(artifactSlugs);
  const notes = new Set(noteIds);
  const hubs = new Set(hubSlugs);
  const rootFiles = new Set(["/", "/index.html", "/index.json", "/llms.txt"]);
  return {
    noteIds: notes,
    has(path) {
      if (rootFiles.has(path)) return true;
      let match = /^\/notes\/(.+?)(?:\.md|\/|\/index\.html)?$/.exec(path);
      if (match) return notes.has(match[1]);
      match = /^\/projects\/([^/]+)(?:\/(?:index\.html|index\.md)?)?$/.exec(path);
      if (match) return hubs.has(match[1]);
      match = /^\/([^/]+)(?:\/.*)?$/.exec(path);
      return Boolean(match && slugs.has(match[1]));
    },
  };
}

// Resolves a note's relative links as written against its .md file (the way
// they also work on disk and in any Markdown viewer), then re-expresses them
// relative to the page actually rendering them — the note's own page or a
// project hub. A link to another note's .md goes to that note's page. A target
// the site does not contain returns null, so the link renders as plain text
// instead of a dead link.
export function siteLinkResolver({ id, pageDir, site }) {
  const origin = "https://site.invalid";
  const base = `${origin}/${noteRawPath(id)}`;
  return (href) => {
    let url;
    try {
      url = new URL(href, base);
    } catch {
      return null;
    }
    if (url.origin !== origin) return null;
    let path;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      return null;
    }
    if (!site.has(path)) return null;
    const noteMarkdown = /^\/notes\/(.+)\.md$/.exec(path);
    const target = noteMarkdown ? `/${notePageDir(noteMarkdown[1])}` : url.pathname;
    return relativeFrom(pageDir, target) + url.search + url.hash;
  };
}

// Validates one note. `id` is its path under notes/ without ".md" (omit it to
// skip path checks); `resolveRelative` is passed to the renderer so dropped
// links surface as warnings. Returns the parsed note alongside the findings.
export function validateNote({ id, text, today = new Date(), resolveRelative }) {
  const errors = [];
  const warnings = [];
  const { fields, body, errors: parseErrors } = parseNote(text);
  errors.push(...parseErrors);

  if (id !== undefined) {
    for (const segment of id.split("/")) {
      if (!PATH_SEGMENT.test(segment)) {
        errors.push(`path segment "${segment}" must be letters, digits, "-" or "_" (it becomes part of the URL)`);
      }
    }
  }

  for (const key of REQUIRED_FIELDS) {
    if (!fields[key]) errors.push(`frontmatter requires ${key}`);
  }
  for (const key of Object.keys(fields)) {
    if (!NOTE_FIELDS.includes(key)) warnings.push(`unknown frontmatter field "${key}" (known: ${NOTE_FIELDS.join(", ")})`);
  }
  if (fields.project && !PROJECT_PATTERN.test(fields.project)) {
    errors.push("project must be lowercase letters, digits and hyphens (it becomes /projects/<project>/)");
  }
  if (fields.kind && !NOTE_KINDS.includes(fields.kind)) {
    errors.push(`kind must be one of: ${NOTE_KINDS.join(", ")}`);
  }
  if (fields.visibility !== undefined) {
    errors.push(VISIBILITY_REMOVED);
  }
  if (fields.updated) {
    const time = /^\d{4}-\d{2}-\d{2}$/.test(fields.updated) ? Date.parse(`${fields.updated}T00:00:00Z`) : NaN;
    if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== fields.updated) {
      errors.push("updated must be a real date in YYYY-MM-DD form");
    } else {
      const todayUtc = Date.parse(`${localDate(today)}T00:00:00Z`);
      const age = Math.round((todayUtc - time) / DAY_MS);
      if (age < 0) warnings.push(`updated (${fields.updated}) is in the future`);
      if (fields.kind === "status" && age > STATUS_STALE_DAYS) {
        warnings.push(`status note last updated ${age} days ago — verify and rewrite it, or it will mislead`);
      }
    }
  }

  const size = Buffer.byteLength(String(text ?? ""), "utf8");
  if (size > NOTE_SIZE_MAX) {
    errors.push(`note is ${size} bytes (limit ${NOTE_SIZE_MAX}) — make it an artifact and link to it from a short note`);
  } else if (size > NOTE_SIZE_WARN) {
    warnings.push(`note is ${size} bytes (over ${NOTE_SIZE_WARN}) — keep notes short; a note growing into a plan should become an artifact`);
  }

  for (const label of findSecrets(text)) errors.push(`appears to contain a ${label} — notes hold handles, never secret values`);
  for (const what of findLocalReferences(text)) warnings.push(`contains ${what}`);

  warnings.push(...renderMarkdownHtml(body, { resolveRelative }).warnings);

  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)], fields, body };
}

// Local calendar date, because "60 days old" is judged by the person reading
// the warning, not by UTC.
export function localDate(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function isStaleStatus(fields, today = new Date()) {
  if (fields.kind !== "status" || !/^\d{4}-\d{2}-\d{2}$/.test(fields.updated || "")) return false;
  const age = (Date.parse(`${localDate(today)}T00:00:00Z`) - Date.parse(`${fields.updated}T00:00:00Z`)) / DAY_MS;
  return age > STATUS_STALE_DAYS;
}

// True when the text opens with a frontmatter delimiter line — the mark of a
// note, as opposed to plain Markdown that happens to live under notes/.
export function hasFrontmatter(text) {
  return String(text).replace(/^\uFEFF/, "").split("\n", 1)[0].trim() === "---";
}

// Finds every note under <root>/notes. Each file is read exactly once and the
// same bytes are validated, rendered, and staged, so an edit landing mid-publish
// cannot ship unvalidated content. Symlinks are ignored: a note is a file in
// the repo, and following a link could publish something from outside it.
export async function discoverNotes(root) {
  const notesDir = resolve(root, "notes");
  const notes = [];
  const ignored = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });

  async function walk(dir, prefix) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT" && prefix === "") return;
      throw error;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const rel = prefix + entry.name;
      const full = resolve(dir, entry.name);
      if (entry.isSymbolicLink()) {
        ignored.push({ path: `notes/${rel}`, reason: "symlink" });
      } else if (entry.isDirectory()) {
        await walk(full, `${rel}/`);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        const bytes = await readFile(full);
        let text;
        try {
          text = decoder.decode(bytes);
        } catch {
          text = null;
        }
        // A Markdown file with no frontmatter (a README, scratch text) is not
        // a note: it is skipped rather than failing the publish, so roots
        // that kept plain Markdown under notes/ before notes existed still
        // publish. Frontmatter with bad fields is still an error.
        if (text !== null && !hasFrontmatter(text)) {
          ignored.push({ path: `notes/${rel}`, reason: "no --- frontmatter, so not a note" });
          continue;
        }
        notes.push({ id: rel.slice(0, -3), path: `notes/${rel}`, file: full, bytes, text });
      } else {
        ignored.push({ path: `notes/${rel}`, reason: "not a .md file" });
      }
    }
  }

  const info = await lstat(notesDir).catch(() => null);
  if (info && info.isSymbolicLink()) ignored.push({ path: "notes", reason: "symlink" });
  else if (info && info.isDirectory()) await walk(notesDir, "");
  return { notes, ignored };
}

// Disk-based link check for standalone validation: a relative link should
// point at something that exists next to the note in the repo.
export function diskLinkResolver(file) {
  return (href) => {
    const path = href.replace(/[?#].*$/, "");
    if (!path) return href;
    let decoded;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      return null;
    }
    return existsSync(resolve(dirname(file), decoded)) ? href : null;
  };
}

export const PAGE_STYLES = `
      :root {
        color-scheme: light dark;
        --bg: #fbfaf7; --fg: #1f2328; --muted: #5d636b; --line: rgba(31, 35, 40, 0.14);
        --accent: #2459c9; --tint: rgba(31, 35, 40, 0.055); --warn: #9a5b00;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --bg: #131417; --fg: #e6e7ea; --muted: #a3a9b2; --line: rgba(230, 231, 234, 0.15);
          --accent: #8fb2ff; --tint: rgba(230, 231, 234, 0.07); --warn: #f0b35a;
        }
      }
      * { box-sizing: border-box; }
      body {
        margin: 0; background: var(--bg); color: var(--fg);
        font: 16.5px/1.65 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        -webkit-text-size-adjust: 100%;
      }
      .page { max-width: 44rem; margin: 0 auto; padding: 28px 22px 72px; }
      a { color: var(--accent); text-underline-offset: 2px; }
      a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 2px; }
      .crumbs { font-size: 0.85rem; color: var(--muted); }
      .crumbs a { color: inherit; }
      .eyebrow {
        margin: 28px 0 6px; font-size: 0.74rem; font-weight: 650; letter-spacing: 0.08em;
        text-transform: uppercase; color: var(--muted);
      }
      h1 { margin: 0 0 10px; font-size: 1.9rem; line-height: 1.2; letter-spacing: -0.01em; }
      .lede { margin: 0 0 12px; font-size: 1.07rem; color: var(--muted); }
      .meta {
        display: flex; flex-wrap: wrap; gap: 4px 16px; margin: 0; padding-bottom: 18px;
        border-bottom: 1px solid var(--line); font-size: 0.85rem; color: var(--muted);
      }
      .stale { color: var(--warn); font-weight: 600; }
      .prose { overflow-wrap: break-word; }
      .prose h1, .prose h2, .prose h3, .prose h4, .prose h5, .prose h6 { line-height: 1.3; margin: 1.8em 0 0.5em; }
      .prose h2 { font-size: 1.3rem; }
      .prose h3 { font-size: 1.12rem; }
      .prose h4, .prose h5, .prose h6 { font-size: 1rem; }
      .prose p, .prose ul, .prose ol, .prose blockquote, .prose pre, .prose .table-wrap { margin: 0 0 1em; }
      .prose ul, .prose ol { padding-left: 1.4em; }
      .prose li { margin: 0.3em 0; }
      .prose li > ul, .prose li > ol, .prose li > p { margin: 0.3em 0; }
      .prose li.task { list-style: none; }
      .prose li.task > input { margin: 0 0.45em 0 -1.35em; }
      code {
        font: 0.87em/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        background: var(--tint); padding: 0.1em 0.35em; border-radius: 4px; overflow-wrap: anywhere;
      }
      pre { background: var(--tint); padding: 14px 16px; border-radius: 8px; overflow-x: auto; }
      pre code { background: none; padding: 0; overflow-wrap: normal; }
      blockquote { margin-left: 0; padding: 2px 0 2px 16px; border-left: 3px solid var(--line); color: var(--muted); }
      hr { border: 0; border-top: 1px solid var(--line); margin: 2em 0; }
      .table-wrap { overflow-x: auto; }
      table { border-collapse: collapse; font-size: 0.92rem; }
      th, td { border: 1px solid var(--line); padding: 6px 10px; text-align: left; vertical-align: top; }
      th { background: var(--tint); }
      .align-right { text-align: right; }
      .align-center { text-align: center; }
      footer {
        display: flex; flex-wrap: wrap; gap: 6px 18px; margin-top: 48px; padding-top: 16px;
        border-top: 1px solid var(--line); font-size: 0.85rem; color: var(--muted);
      }
      @media print { .crumbs, footer { display: none; } a { color: inherit; } }`;

// One self-contained page per note: inline CSS, no script, no subresources, so
// it satisfies the root CSP (default-src 'none') unchanged.
export function renderNotePage({ id, fields, body, resolveRelative, today = new Date() }) {
  const pageDir = notePageDir(id);
  const toRoot = relativeFrom(pageDir, "/");
  const hub = relativeFrom(pageDir, `/projects/${fields.project}/`);
  const raw = `../${id.split("/").at(-1)}.md`;
  const { html } = renderMarkdownHtml(body, { resolveRelative, headingBase: 2 });
  const stale = isStaleStatus(fields, today)
    ? `\n        <span class="stale">Over ${STATUS_STALE_DAYS} days old — verify before relying on it</span>`
    : "";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow" />
    <meta name="description" content="${esc(fields.summary || fields.title)}" />
    <link rel="alternate" type="text/markdown" href="${esc(raw)}" title="Markdown for agents" />
    <title>${esc(fields.title)}</title>
    <style>${PAGE_STYLES}
    </style>
  </head>
  <body>
    <div class="page">
      <nav class="crumbs" aria-label="Breadcrumb"><a href="${esc(toRoot)}">All</a> / <a href="${esc(hub)}">${esc(fields.project)}</a></nav>
      <header>
        <p class="eyebrow">Note · ${esc(fields.kind)}</p>
        <h1>${esc(fields.title)}</h1>${fields.summary ? `\n        <p class="lede">${esc(fields.summary)}</p>` : ""}
        <p class="meta">
          <span>Project <a href="${esc(hub)}">${esc(fields.project)}</a></span>
          <span>Updated <time datetime="${esc(fields.updated)}">${esc(fields.updated)}</time></span>${stale}
        </p>
      </header>
      <main class="prose">
${html}
      </main>
      <footer>
        <a href="${esc(raw)}">Markdown for agents</a>
        <a href="${esc(hub)}">${esc(fields.project)} hub</a>
        <a href="${esc(toRoot)}">All entries</a>
      </footer>
    </div>
  </body>
</html>
`;
}

// The note as it should ship: frontmatter bytes untouched, body links to
// anything this site does not publish reduced to their text (see
// sanitizeMarkdownLinks). `body` is the sanitized body in parseNote()'s form,
// for rendering, so the page and the raw file drop the same links.
export function sanitizeNote(text, resolveRelative) {
  const lines = String(text).split("\n");
  const end = lines[0].replace(/^\uFEFF/, "").trim() === "---"
    ? lines.findIndex((line, index) => index > 0 && line.trim() === "---")
    : -1;
  const head = end < 0 ? "" : `${lines.slice(0, end + 1).join("\n")}\n`;
  const rawBody = end < 0 ? String(text) : lines.slice(end + 1).join("\n");
  const { text: body, dropped } = sanitizeMarkdownLinks(rawBody, { resolveRelative });
  const shipped = dropped.length ? head + body : String(text);
  return { text: shipped, body: parseNote(shipped).body, dropped };
}
