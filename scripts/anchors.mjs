#!/usr/bin/env node

// Stable anchors. Every block a reader might comment on carries a
// `data-anchor` id in the built page, and leaf blocks also carry `data-fp`, a
// short fingerprint of their text. Copy feedback (interactive.js) quotes these
// ids, so an agent can find the exact block in artifact.json, and a later
// server-side comment system can re-attach comments after a rebuild.
//
// Id grammar:
//   title, summary, page                       the hero title, its summary, the whole page
//   highlights, phases, copy-blocks,           the built-in containers
//   architecture, decisions, risks, next-actions
//   hl-<slug>  phase-<slug>  task-<slug>       titled items: a kind prefix plus a slug of
//   sec-<slug> card-<slug>   copy-<slug>       the title, de-duplicated with -2, -3 … in
//   arch-<slug> dec-<slug>   risk-<slug>       document order
//   <parent>.p<n>  <parent>.b<n>               paragraph / bullet n (1-based) of a section
//                                              (next actions: next-actions.b<n>)
//   chart:<chart-id>                           a chart
//   chart:<chart-id>/row:<key>                 one chart row: its bars, legend entry and
//                                              table row share the anchor
//   chart:<chart-id>/total                     a stack chart's computed total row
//
// A titled item may set `id` to pin its anchor. The authored value is used
// verbatim (no prefix added) and wins over every derived id. Chart rows may set
// `id` too; it becomes the row key. Ids never change on reorder, only when a
// title without an authored id is renamed — so pin the old id before renaming
// anything already published.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const ANCHOR_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_ID_LENGTH = 64;
export const RESERVED_IDS = [
  "page",
  "title",
  "summary",
  "highlights",
  "phases",
  "copy-blocks",
  "architecture",
  "decisions",
  "risks",
  "next-actions",
];

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const list = (value) => (Array.isArray(value) ? value : []);
const isFilled = (value) => value !== undefined && value !== null && String(value).trim() !== "";

// Lowercase ASCII words joined by hyphens, cut at a word break near `max`. A
// leading word equal to `drop` is removed first, so "Phase 0: Setup" under the
// phase- prefix becomes phase-0-setup, not phase-phase-0-setup.
export function slugify(value, max = 40, drop = "") {
  let slug = String(value ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (drop && slug.startsWith(`${drop}-`)) slug = slug.slice(drop.length + 1);
  if (slug.length > max) {
    slug = slug.slice(0, max);
    const cut = slug.lastIndexOf("-");
    if (cut >= max / 2) slug = slug.slice(0, cut);
    slug = slug.replace(/-+$/, "");
  }
  return slug;
}

// 8 hex characters of SHA-256 over the whitespace-normalised text. Same text,
// same fingerprint, whatever the formatting of artifact.json.
export function fingerprint(...parts) {
  const text = parts
    .filter(isFilled)
    .map((part) => String(part))
    .join("\n")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
  return createHash("sha256").update(text).digest("hex").slice(0, 8);
}

function unique(base, taken) {
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

// Every item that can carry an authored id, in document order.
function titledItems(data) {
  const items = [];
  const push = (path, prefix, item, title, slot, position) =>
    items.push({ path, prefix, item, title, slot, position, explicit: isObject(item) ? item.id : undefined });
  list(data.highlights).forEach((item, i) => push(`highlights[${i}]`, "hl", item, item?.label, ["highlights", i], i));
  list(data.phases).forEach((phase, i) => {
    push(`phases[${i}]`, "phase", phase, phase?.name, ["phases", i], i);
    list(phase?.tasks).forEach((task, j) => push(`phases[${i}].tasks[${j}]`, "task", task, task?.title, ["tasks", i, j], j));
  });
  list(data.sections).forEach((section, i) => {
    push(`sections[${i}]`, "sec", section, section?.title, ["sections", i], i);
    list(section?.cards).forEach((card, j) => push(`sections[${i}].cards[${j}]`, "card", card, card?.title, ["cards", i, j], j));
  });
  list(data.copyBlocks).forEach((item, i) => push(`copyBlocks[${i}]`, "copy", item, item?.title, ["copyBlocks", i], i));
  list(data.architecture).forEach((item, i) => push(`architecture[${i}]`, "arch", item, item?.label, ["architecture", i], i));
  list(data.decisions).forEach((item, i) => push(`decisions[${i}]`, "dec", item, item?.title, ["decisions", i], i));
  list(data.risks).forEach((item, i) => push(`risks[${i}]`, "risk", item, item?.title, ["risks", i], i));
  return items;
}

const idProblem = (id) => {
  if (typeof id !== "string" || id.length > MAX_ID_LENGTH || !ANCHOR_ID.test(id)) {
    return `must be lowercase letters and digits joined by single hyphens (at most ${MAX_ID_LENGTH} characters)`;
  }
  if (RESERVED_IDS.includes(id)) return `"${id}" is reserved`;
  return null;
};

// Returns human-readable problems with authored ids; empty means they render.
export function validateAnchorIds(data) {
  const errors = [];
  const seen = new Map();
  for (const { path, explicit } of titledItems(data)) {
    if (explicit === undefined) continue;
    const problem = idProblem(explicit);
    if (problem) {
      errors.push(`${path}.id ${problem}`);
    } else if (seen.has(explicit)) {
      errors.push(`${path}.id "${explicit}" is also used by ${seen.get(explicit)}`);
    } else {
      seen.set(explicit, path);
    }
  }
  list(data.charts).forEach((chart, i) => {
    const rowsSeen = new Map();
    list(chart?.rows).forEach((row, j) => {
      if (!isObject(row) || row.id === undefined) return;
      const path = `charts[${i}].rows[${j}]`;
      const problem = typeof row.id !== "string" || row.id.length > MAX_ID_LENGTH || !ANCHOR_ID.test(row.id)
        ? `must be lowercase letters and digits joined by single hyphens (at most ${MAX_ID_LENGTH} characters)`
        : null;
      if (problem) errors.push(`${path}.id ${problem}`);
      else if (rowsSeen.has(row.id)) errors.push(`${path}.id "${row.id}" is also used by ${rowsSeen.get(row.id)}`);
      else rowsSeen.set(row.id, path);
    });
  });
  return errors;
}

export function assertValidAnchorIds(data) {
  const errors = validateAnchorIds(data);
  if (errors.length) throw new Error(`Invalid ids:\n- ${errors.join("\n- ")}`);
}

// The anchor of every titled item, shaped like the data so renderers can look
// them up by index: ids.sections[i], ids.tasks[phase][task], ids.cards[section][card].
export function assignAnchors(data) {
  assertValidAnchorIds(data);
  const items = titledItems(data);
  const taken = new Set(RESERVED_IDS);
  for (const { explicit } of items) if (explicit !== undefined) taken.add(explicit);
  const ids = {
    highlights: [],
    phases: [],
    tasks: [],
    sections: [],
    cards: [],
    copyBlocks: [],
    architecture: [],
    decisions: [],
    risks: [],
  };
  for (const { prefix, title, slot, position, explicit } of items) {
    let id = explicit;
    if (id === undefined) {
      id = unique(`${prefix}-${slugify(title, 40, prefix) || position + 1}`, taken);
      taken.add(id);
    }
    const [group, i, j] = slot;
    if (j === undefined) ids[group][i] = id;
    else (ids[group][i] ||= [])[j] = id;
  }
  return ids;
}

// Row keys for one chart: authored `id`s first, then label slugs, de-duplicated.
export function chartRowKeys(chart) {
  const rows = list(chart?.rows);
  const taken = new Set(rows.filter((row) => isObject(row) && typeof row.id === "string").map((row) => row.id));
  return rows.map((row, index) => {
    if (isObject(row) && typeof row.id === "string") return row.id;
    const key = unique(slugify(row?.label) || `row-${index + 1}`, taken);
    taken.add(key);
    return key;
  });
}

export const chartAnchor = (chart) => `chart:${chart.id}`;
export const chartRowAnchor = (chart, key) => `chart:${chart.id}/row:${key}`;

// Every anchor on the page in document order, with the artifact.json path it
// came from and its text. Used by the CLI below and by the tests.
export function listAnchors(data) {
  const ids = assignAnchors(data);
  const out = [];
  const add = (anchor, path, text) => out.push({ anchor, path, text: String(text ?? "") });
  add("title", "title", data.title);
  if (isFilled(data.summary)) add("summary", "summary", data.summary);
  if (list(data.highlights).length) add("highlights", "highlights", "Highlights");
  list(data.highlights).slice(0, 4).forEach((item, i) => add(ids.highlights[i], `highlights[${i}]`, `${item?.label ?? ""}: ${item?.value ?? ""}`));
  if (list(data.phases).length) add("phases", "phases", "Phases and tasks");
  list(data.phases).forEach((phase, i) => {
    add(ids.phases[i], `phases[${i}]`, phase?.name);
    list(phase?.tasks).forEach((task, j) => add(ids.tasks[i][j], `phases[${i}].tasks[${j}]`, task?.title));
  });
  list(data.sections).forEach((section, i) => {
    const id = ids.sections[i];
    add(id, `sections[${i}]`, section?.title);
    list(section?.paragraphs).forEach((text, n) => add(`${id}.p${n + 1}`, `sections[${i}].paragraphs[${n}]`, text));
    list(data.charts).filter((chart) => chart?.section === i).forEach((chart) => {
      const c = data.charts.indexOf(chart);
      add(chartAnchor(chart), `charts[${c}]`, chart.title);
      chartRowKeys(chart).forEach((key, r) => add(chartRowAnchor(chart, key), `charts[${c}].rows[${r}]`, chart.rows[r]?.label));
      if (chart.type === "stack") add(`${chartAnchor(chart)}/total`, `charts[${c}]`, "Total (computed)");
    });
    list(section?.bullets).forEach((text, n) => add(`${id}.b${n + 1}`, `sections[${i}].bullets[${n}]`, text));
    list(section?.cards).forEach((card, j) => add(ids.cards[i][j], `sections[${i}].cards[${j}]`, card?.title));
  });
  const container = (key, anchor, label) => {
    if (list(data[key]).length) add(anchor, key, label);
  };
  container("copyBlocks", "copy-blocks", "Text you can paste as-is");
  list(data.copyBlocks).forEach((item, i) => add(ids.copyBlocks[i], `copyBlocks[${i}]`, item?.title));
  container("architecture", "architecture", "How the pieces connect");
  list(data.architecture).forEach((item, i) => add(ids.architecture[i], `architecture[${i}]`, item?.label));
  container("decisions", "decisions", "Key decisions");
  list(data.decisions).forEach((item, i) => add(ids.decisions[i], `decisions[${i}]`, item?.title));
  container("risks", "risks", "Risks and mitigations");
  list(data.risks).forEach((item, i) => add(ids.risks[i], `risks[${i}]`, item?.title));
  container("nextActions", "next-actions", "What happens next");
  list(data.nextActions).forEach((text, n) => add(`next-actions.b${n + 1}`, `nextActions[${n}]`, text));
  return out;
}

// CLI: node anchors.mjs <artifact-dir>  — one line per anchor: id, JSON path, text.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const dir = resolve(process.argv[2] || ".");
  const data = JSON.parse(await readFile(resolve(dir, "artifact.json"), "utf8"));
  for (const { anchor, path, text } of listAnchors(data)) {
    const short = text.replace(/\s+/g, " ").trim();
    console.log(`${anchor}\t${path}\t${short.length > 70 ? `${short.slice(0, 69)}…` : short}`);
  }
}
