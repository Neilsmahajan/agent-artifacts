// Project hubs: one page per project answering "what's going on with X?" —
// the status note first, then the other notes, then live artifacts, with
// history collapsed. Each hub also gets an index.md, a few lines an agent can
// read instead of the whole registry.
//
// Hubs are built from the entries being published and nothing else, so a hub
// only ever mentions pages the site actually serves.

import { isStaleStatus, PAGE_STYLES, PROJECT_PATTERN, STATUS_STALE_DAYS } from "./notes.mjs";
import { esc } from "./render.mjs";

const NOTE_KIND_ORDER = ["status", "decisions", "reference", "person", "glossary"];
const NOTE_KIND_LABELS = {
  status: "Status",
  decisions: "Decisions",
  reference: "Reference",
  person: "People",
  glossary: "Glossary",
};
const isStale = (entry) => entry.lifecycle === "superseded" || entry.lifecycle === "archived";
const newestFirst = (a, b) => String(b.updated || "").localeCompare(String(a.updated || "")) || a.title.localeCompare(b.title);

// Notes are held to URL-safe project names; artifacts predate that rule, so
// their project is slugified for the hub URL instead of rejected.
export function hubSlug(project) {
  if (typeof project !== "string" || !project.trim()) return null;
  if (PROJECT_PATTERN.test(project)) return project;
  return (
    project
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || null
  );
}

// Groups entries into hubs. Entries without a project have no hub (the root
// index still lists them under "other"). Slugifying is lossy, so two distinct
// project names can land on one hub URL ("AI Tooling" and "ai-tooling");
// merging them silently would mix two projects' status, so that fails loudly.
export function groupByHub(entries) {
  const hubs = new Map();
  const names = new Map();
  for (const entry of entries) {
    const slug = hubSlug(entry.project);
    if (!slug) continue;
    if (!hubs.has(slug)) hubs.set(slug, { slug, project: entry.project, entries: [] });
    hubs.get(slug).entries.push(entry);
    if (!names.has(slug)) names.set(slug, new Map());
    const byName = names.get(slug);
    if (!byName.has(entry.project)) byName.set(entry.project, []);
    byName.get(entry.project).push(entry.slug);
  }
  const collisions = [...names.entries()].filter(([, byName]) => byName.size > 1);
  if (collisions.length) {
    throw new Error(
      "Distinct project names map to the same hub URL — use one spelling:\n" +
        collisions
          .map(
            ([slug, byName]) =>
              `  /projects/${slug}/: ${[...byName.entries()]
                .map(([name, slugs]) => `"${name}" (${slugs.join(", ")})`)
                .join(" vs ")}`,
          )
          .join("\n"),
    );
  }
  return [...hubs.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

function statusNoteOf(hub) {
  const statuses = hub.entries.filter((e) => e.kind === "note" && e.noteKind === "status").sort(newestFirst);
  return statuses.find((e) => e.id === `${hub.slug}/status`) || statuses[0] || null;
}

// Orders a hub's entries the way the page presents them; index.md uses the
// same order so both answer the same question the same way.
export function orderHubEntries(hub) {
  const status = statusNoteOf(hub);
  const notes = hub.entries
    .filter((e) => e.kind === "note" && e !== status)
    .sort((a, b) => NOTE_KIND_ORDER.indexOf(a.noteKind) - NOTE_KIND_ORDER.indexOf(b.noteKind) || newestFirst(a, b));
  const documents = hub.entries.filter((e) => e.kind !== "note");
  return {
    status,
    notes,
    live: documents.filter((e) => !isStale(e)).sort(newestFirst),
    stale: documents.filter(isStale).sort(newestFirst),
  };
}

function entryItem(entry, { published }) {
  const href = `../../${entry.path}`;
  const badges = [];
  if (entry.kind === "note") badges.push(entry.noteKind);
  else if (entry.lifecycle !== "active") badges.push(entry.lifecycle);
  if (entry.kind === "static") badges.push("site");
  const replacement =
    entry.lifecycle === "superseded" && entry.supersededBy && published.has(entry.supersededBy)
      ? ` <span class="when">→ <a href="../../${esc(entry.supersededBy)}/">${esc(entry.supersededBy)}</a></span>`
      : "";
  return `<li>
            <div class="entry-head"><a href="${esc(href)}">${esc(entry.title)}</a>${badges
              .map((badge) => ` <span class="badge">${esc(badge)}</span>`)
              .join("")}${replacement}</div>
            ${entry.summary ? `<p>${esc(entry.summary)}</p>\n            ` : ""}<span class="when">Updated ${esc(entry.updated || "—")}</span>
          </li>`;
}

const HUB_STYLES = `
      .status-card {
        margin: 28px 0 8px; padding: 2px 22px 10px; border: 1px solid var(--line);
        border-radius: 12px; background: var(--tint);
      }
      .status-card > .eyebrow { margin-top: 18px; }
      .status-card h2 { margin: 0 0 4px; font-size: 1.35rem; }
      .status-card h2 a { color: inherit; text-decoration: none; }
      .status-card h2 a:hover { text-decoration: underline; }
      section > h2 { margin: 40px 0 4px; font-size: 1.3rem; }
      section > h3 { margin: 22px 0 0; font-size: 0.8rem; letter-spacing: 0.07em; text-transform: uppercase; color: var(--muted); }
      .entries { list-style: none; margin: 8px 0 0; padding: 0; }
      .entries li { padding: 12px 0; border-top: 1px solid var(--line); }
      .entry-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; }
      .entry-head > a { font-weight: 600; }
      .entries p {
        margin: 4px 0; color: var(--muted);
        display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; line-clamp: 3; overflow: hidden;
      }
      .badge {
        font-size: 0.7rem; font-weight: 650; text-transform: uppercase; letter-spacing: 0.06em;
        color: var(--muted); border: 1px solid var(--line); border-radius: 4px; padding: 0 6px;
      }
      .when { font-size: 0.82rem; color: var(--muted); }
      details { margin-top: 18px; }
      summary { cursor: pointer; color: var(--muted); font-size: 0.9rem; }
      details .entries { opacity: 0.8; }`;

// statusHtml: the status note's body, already rendered with links resolved
// for this page (see siteLinkResolver in notes.mjs).
export function renderHubPage(hub, { statusHtml = "", published, today = new Date() }) {
  const { status, notes, live, stale } = orderHubEntries(hub);
  const noteCount = hub.entries.filter((e) => e.kind === "note").length;
  const docCount = hub.entries.length - noteCount;
  const latest = hub.entries.map((e) => e.updated || "").sort().at(-1);

  const statusSection = status
    ? `
      <section class="status-card" aria-labelledby="hub-status">
        <p class="eyebrow">Status · updated <time datetime="${esc(status.updated)}">${esc(status.updated)}</time>${
          isStaleStatus({ kind: "status", updated: status.updated }, today)
            ? ` · <span class="stale">over ${STATUS_STALE_DAYS} days old — verify before relying on it</span>`
            : ""
        }</p>
        <h2 id="hub-status"><a href="../../${esc(status.path)}">${esc(status.title)}</a></h2>
        <div class="prose">
${statusHtml}
        </div>
      </section>`
    : "";

  const noteGroups = NOTE_KIND_ORDER.map((kind) => [kind, notes.filter((e) => e.noteKind === kind)])
    .filter(([, group]) => group.length)
    .map(
      ([kind, group]) => `
        <h3>${esc(NOTE_KIND_LABELS[kind])}</h3>
        <ul class="entries">
          ${group.map((e) => entryItem(e, { published })).join("\n          ")}
        </ul>`,
    )
    .join("");
  const notesSection = notes.length
    ? `
      <section aria-labelledby="hub-notes">
        <h2 id="hub-notes">Notes</h2>${noteGroups}
      </section>`
    : "";

  const staleBlock = stale.length
    ? `
        <details>
          <summary>Superseded and archived (${stale.length})</summary>
          <ul class="entries">
          ${stale.map((e) => entryItem(e, { published })).join("\n          ")}
          </ul>
        </details>`
    : "";
  const docsSection =
    live.length || stale.length
      ? `
      <section aria-labelledby="hub-artifacts">
        <h2 id="hub-artifacts">Artifacts</h2>${
          live.length
            ? `
        <ul class="entries">
          ${live.map((e) => entryItem(e, { published })).join("\n          ")}
        </ul>`
            : ""
        }${staleBlock}
      </section>`
      : "";

  const counts = [
    noteCount && `${noteCount} ${noteCount === 1 ? "note" : "notes"}`,
    docCount && `${docCount} ${docCount === 1 ? "artifact" : "artifacts"}`,
    latest && `latest update ${latest}`,
  ].filter(Boolean);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow" />
    <link rel="alternate" type="text/markdown" href="index.md" title="Project index for agents" />
    <title>${esc(hub.project)} — project hub</title>
    <style>${PAGE_STYLES}${HUB_STYLES}
    </style>
  </head>
  <body>
    <div class="page">
      <nav class="crumbs" aria-label="Breadcrumb"><a href="../../">All</a> / ${esc(hub.project)}</nav>
      <header>
        <p class="eyebrow">Project hub</p>
        <h1>${esc(hub.project)}</h1>
        <p class="meta">${counts.map((c) => `<span>${esc(c)}</span>`).join("")}<span><a href="index.md">index.md for agents</a></span></p>
      </header>${statusSection}${notesSection}${docsSection}
      <footer>
        <a href="index.md">Project index for agents</a>
        <a href="../../">All entries</a>
        <a href="../../index.json">index.json</a>
      </footer>
    </div>
  </body>
</html>
`;
}

function oneLine(text, limit = 140) {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  if (flat.length <= limit) return flat;
  const cut = flat.slice(0, limit - 1);
  return `${cut.slice(0, cut.lastIndexOf(" ") > limit * 0.6 ? cut.lastIndexOf(" ") : cut.length).replace(/[\s,;:.—-]+$/, "")}…`;
}

// index.md is read by agents and by whatever renders it, so every
// interpolated value (titles, summaries, project names, dates — all authored
// text) is flattened to one line and has Markdown/HTML-significant characters
// backslash-escaped: a title cannot open a link, a tag, a table cell, or a
// heading. URLs get the characters that would end a link target encoded.
const mdText = (text) =>
  String(text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\\`*_[\]<>|]/g, "\\$&")
    .replace(/^#/, "\\#");
const mdUrl = (url) =>
  String(url).replace(/[()<>\s\\`]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);

// The agent-facing hub: one line per entry, pointing at each entry's cheapest
// readable form. Stays small on purpose — agents load it into context whole.
export function renderHubMarkdown(hub, { siteBase }) {
  const { status, notes, live, stale } = orderHubEntries(hub);
  const line = (entry) => {
    const url = mdUrl(`${siteBase}/${entry.markdownPath || entry.path}`);
    const kind = mdText(entry.kind === "note" ? `note/${entry.noteKind}` : `${entry.kind}/${entry.lifecycle}`);
    const summary = mdText(oneLine(entry.summary));
    return `- [${mdText(entry.title)}](${url}) — ${kind} · ${mdText(entry.updated || "undated")}${summary ? ` · ${summary}` : ""}`;
  };
  const lines = [
    `# ${mdText(hub.project)} — project index`,
    "",
    `Entries for ${mdText(hub.project)} on ${siteBase}, status first. Notes are current (rewritten in place); ` +
      "superseded and archived artifacts come last and are history only.",
    "",
    ...[status, ...notes, ...live, ...stale].filter(Boolean).map(line),
    "",
  ];
  return lines.join("\n");
}
