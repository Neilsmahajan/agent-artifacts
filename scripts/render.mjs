// Build-time renderer. Turns artifact.json into complete markup so the built
// file carries its content in the HTML itself: readable by curl, WebFetch, and
// any agent that cannot run JavaScript. interactive.js only enhances what is
// already here — it never renders content.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assignAnchors, assertValidAnchorIds, fingerprint } from "./anchors.mjs";
import { assertValidCharts, chartsForSection, renderChart, renderChartMarkdown } from "./charts.mjs";

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]);

const normalizeStatus = (status = "planned") =>
  String(status).trim().toLowerCase().replaceAll(" ", "-");

const isFilled = (value) => value !== undefined && value !== null && String(value).trim() !== "";

// Stable anchor attributes (see anchors.mjs). Leaf blocks also get a
// fingerprint of their source text, so a note written against one wording can
// tell when the block has since been rewritten.
const anchor = (id, ...text) =>
  ` data-anchor="${esc(id)}"${text.length ? ` data-fp="${fingerprint(...text)}"` : ""}`;

export function allTasks(data) {
  return (data.phases || []).flatMap((phase) => phase.tasks || []);
}

export function calculateProgress(data) {
  if (Number.isFinite(data.progress)) return Math.max(0, Math.min(100, data.progress));
  const tasks = allTasks(data);
  if (!tasks.length) return 0;
  return Math.round((tasks.filter((task) => task.done).length / tasks.length) * 100);
}

// Progress is only meaningful when the artifact tracks tasks or states its own
// number; a report with neither should not display "0%".
const hasProgress = (data) => Number.isFinite(data.progress) || allTasks(data).length > 0;

// Only http(s), mailto, same-document, and relative targets survive. A
// build-time renderer has no window.location, so relative forms are matched
// syntactically and resolved against a dummy base.
function safeHref(url) {
  if (!isFilled(url)) return null;
  const raw = String(url).trim();
  if (/^(?:#|\/(?!\/)|\.{1,2}\/)/.test(raw)) return { href: raw, external: false };
  let protocol;
  try {
    protocol = new URL(raw, "https://artifact.invalid/").protocol;
  } catch {
    return null;
  }
  if (!["http:", "https:", "mailto:"].includes(protocol)) return null;
  return { href: raw, external: protocol !== "mailto:" };
}

function renderMeta(data) {
  const values = [
    isFilled(data.owner) && `Owner: ${data.owner}`,
    isFilled(data.updated) && `Updated ${data.updated}`,
    isFilled(data.version) && `Version ${data.version}`,
    isFilled(data.project) && `Project: ${data.project}`,
  ].filter(Boolean);
  return values.map((value) => `<span>${esc(value)}</span>`).join("");
}

// A pill only suits a few words; a paragraph-long status in one becomes a huge
// oval. Long ones collapse to a single line that expands on tap. Its CSS ships
// here, ahead of the page's styles.css, because per-artifact stylesheets are
// copies that predate it; a page can still restyle `.status-note`.
const STATUS_PILL_MAX = 48;

const STATUS_NOTE_CSS = `
.status-note{flex:1 1 16rem;min-width:0;max-width:var(--prose,44rem);border-radius:14px;background:var(--ok-soft,#e2efe8);color:var(--ok,#3d7a68);font-size:.8rem;font-weight:600;line-height:1.5}
.status-note summary{display:flex;align-items:baseline;gap:8px;padding:4px 12px;cursor:pointer;list-style:none;-webkit-tap-highlight-color:transparent}
.status-note summary::-webkit-details-marker{display:none}
.status-note summary::after{content:"\\25BE";flex:none;font-size:.75rem}
.status-note[open] summary{padding:10px 14px}
.status-note[open] summary::after{content:"\\25B4"}
.status-note summary:focus-visible{border-radius:14px;outline:2px solid var(--accent,currentColor);outline-offset:2px}
.status-note:not([open]) .status-note-text{overflow:hidden;min-width:0;text-overflow:ellipsis;white-space:nowrap}
@media print{.status-note .status-note-text{white-space:normal!important}.status-note summary::after{display:none}}`;

function renderStatus(status) {
  const text = isFilled(status) ? String(status) : "Draft";
  if (text.length <= STATUS_PILL_MAX) return `<span class="status-pill" id="status">${esc(text)}</span>`;
  return `<details class="status-note" id="status"><summary><span class="status-note-text">${esc(text)}</span></summary></details>`;
}

function renderHighlights(items = [], ids = []) {
  return items
    .slice(0, 4)
    .map(
      (item, index) => `<article class="highlight"${anchor(ids[index], item.label, item.value)}>
          <p class="highlight-label">${esc(item.label || "Highlight")}</p>
          <p class="highlight-value">${esc(item.value || "—")}</p>
        </article>`,
    )
    .join("\n        ");
}

function renderTask(task, id) {
  const state = task.done ? "done" : "open";
  const detail = isFilled(task.detail)
    ? `<span class="task-detail">${esc(task.detail)}</span>`
    : "";
  return `<li class="task is-${state}" data-task-state="${state}"${anchor(id, task.title, task.detail)}>
                <span class="task-mark" aria-hidden="true">✓</span>
                <span><span class="task-title">${esc(task.title || "Untitled task")}</span>${detail}</span>
              </li>`;
}

function renderPhases(phases = [], ids) {
  return phases
    .map((phase, phaseIndex) => {
      const tasks = phase.tasks?.length
        ? `\n              <ul class="task-list">
                ${phase.tasks.map((task, taskIndex) => renderTask(task, ids.tasks[phaseIndex][taskIndex])).join("\n                ")}
              </ul>`
        : "";
      const status = String(phase.status || "planned").replaceAll("-", " ");
      return `<article class="phase-card"${anchor(ids.phases[phaseIndex], phase.name, phase.summary)}>
              <div class="phase-number" aria-hidden="true"></div>
              <div>
                <div class="phase-topline">
                  <div>
                    <h3>${esc(phase.name || "Untitled phase")}</h3>
                    <p class="phase-summary">${esc(phase.summary || "")}</p>
                  </div>
                  <span class="phase-status" data-status="${esc(normalizeStatus(phase.status))}">${esc(status)}</span>
                </div>${tasks}
              </div>
            </article>`;
    })
    .join("\n            ");
}

// A card may carry one outbound link (`url`, optional `linkLabel`). Cards
// without one render exactly as before, so existing builds stay byte-identical.
function renderCardLink(card) {
  const target = safeHref(card.url);
  if (!target) return "";
  const attrs = target.external ? ' target="_blank" rel="noreferrer"' : "";
  return `
                <p class="card-link"><a href="${esc(target.href)}"${attrs}>${esc(card.linkLabel || "Open link")} ↗</a></p>`;
}

// Generic prose sections for non-plan documents: reports, research, decisions.
// Each section carries an optional kicker, paragraphs, bullets, and cards.
// Charts assigned to the section render right after its prose; a section with
// none renders exactly as before, so chart-less builds stay byte-identical.
function renderSection(section, index, charts = [], id, cardIds = []) {
  const kicker = isFilled(section.kicker)
    ? `<p class="section-kicker">${esc(section.kicker)}</p>
                `
    : "";
  const paragraphs = (section.paragraphs || [])
    .map((text, n) => `<p${anchor(`${id}.p${n + 1}`, text)}>${esc(text)}</p>`)
    .join("\n              ");
  const bullets = (section.bullets || []).length
    ? `\n            <ul class="bullet-list">
              ${section.bullets.map((item, n) => `<li${anchor(`${id}.b${n + 1}`, item)}>${esc(item)}</li>`).join("\n              ")}
            </ul>`
    : "";
  const cards = (section.cards || []).length
    ? `\n            <div class="stack-list">
              ${section.cards
                .map(
                  (card, n) => `<article class="stack-card"${anchor(cardIds[n], card.title, card.detail)}>
                <h3>${esc(card.title || "Item")}</h3>
                <p>${esc(card.detail || "")}</p>${renderCardLink(card)}
              </article>`,
                )
                .join("\n              ")}
            </div>`
    : "";
  const figures = charts.length
    ? `\n            ${charts.map(renderChart).join("\n            ")}`
    : "";
  return `<section class="content-section" id="section-${index}"${anchor(id, section.title)}>
            <div class="section-heading">
              <div>
                ${kicker}<h2>${esc(section.title || "Section")}</h2>
              </div>
            </div>
            <div class="section-body">
              ${paragraphs}
            </div>${figures}${bullets}${cards}
          </section>`;
}

function renderArchitecture(nodes = [], ids = []) {
  return nodes
    .map(
      (node, index) => `<article class="architecture-node"${anchor(ids[index], node.label, node.detail)}>
              <span class="node-index">${esc(String(index + 1).padStart(2, "0"))}</span>
              <h3>${esc(node.label || "Component")}</h3>
              <p>${esc(node.detail || "")}</p>
            </article>`,
    )
    .join("\n            ");
}

function renderDecisions(items = [], ids = []) {
  return items
    .map((item, index) => {
      const rationale = isFilled(item.rationale)
        ? `\n                <p class="rationale">Why: ${esc(item.rationale)}</p>`
        : "";
      return `<article class="stack-card"${anchor(ids[index], item.title, item.decision, item.rationale)}>
                <h3>${esc(item.title || "Decision")}</h3>
                <p>${esc(item.decision || "")}</p>${rationale}
              </article>`;
    })
    .join("\n              ");
}

function renderRisks(items = [], ids = []) {
  return items
    .map((item, index) => {
      const description = isFilled(item.description) ? `\n                <p>${esc(item.description)}</p>` : "";
      const mitigation = isFilled(item.mitigation)
        ? `\n                <p class="mitigation">Mitigation: ${esc(item.mitigation)}</p>`
        : "";
      return `<article class="stack-card"${anchor(ids[index], item.title, item.description, item.mitigation)}>
                <div class="risk-title-row">
                  <h3>${esc(item.title || "Risk")}</h3>
                  <span class="risk-severity" data-severity="${esc(normalizeStatus(item.severity || "medium"))}">${esc(item.severity || "medium")}</span>
                </div>${description}${mitigation}
              </article>`;
    })
    .join("\n              ");
}

// Paste-ready text: profile copy, config snippets, commands. It is reproduced
// verbatim inside <pre>, never reflowed, because the whole point is that the
// reader pastes it somewhere unchanged.
function renderCopyBlocks(items = [], ids = []) {
  return items
    .map((item, index) => {
      const label = isFilled(item.label)
        ? `<p class="copy-block-label">${esc(item.label)}</p>`
        : "";
      return `<article class="copy-block"${anchor(ids[index], item.title, item.text)}>
              <div class="copy-block-head">
                <div>
                  ${label}
                  <h3>${esc(item.title || "Text")}</h3>
                </div>
                <button class="quiet-button copy-block-button" type="button" data-copy-block="${index}">
                  <span aria-hidden="true">⧉</span>
                  <span class="button-label">Copy</span>
                </button>
              </div>
              <pre id="copy-block-${index}">${esc(item.text || "")}</pre>
            </article>`;
    })
    .join("\n            ");
}

function renderActions(items = []) {
  return items.map((item, n) => `<li${anchor(`next-actions.b${n + 1}`, item)}>${esc(item)}</li>`).join("\n            ");
}

function renderLinks(items = []) {
  return items
    .map((item) => {
      if (!isFilled(item.label)) return null;
      const target = safeHref(item.url);
      if (!target) return null;
      const attrs = target.external ? ' target="_blank" rel="noreferrer"' : "";
      return `<a href="${esc(target.href)}"${attrs}>${esc(item.label)}</a>`;
    })
    .filter(Boolean)
    .join("\n        ");
}

// Embedded payloads power the copy-back button and give agents a structured
// copy of the same content. `</script>` inside a string would close the block
// early, so the `<` is escaped; JSON.parse reads < back as `<`.
function embedAsJson(value) {
  return JSON.stringify(value, null, 2).replaceAll("<", "\\u003c");
}

// A built artifact is mostly inlined CSS and JS by weight. That is the right
// trade for a human opening it in a browser and the wrong one for an agent
// paying per token, so the same content is also emitted as Markdown.
//
// Every field that carries meaning appears here — an agent handed a silently
// abridged artifact has no way to know what was dropped. Presentation-only keys
// (`eyebrow`, `progressCaption`) and any non-schema keys are deliberately
// omitted; `artifact.json` remains the lossless representation.
export function renderMarkdown(data) {
  assertValidCharts(data);
  const lines = [`# ${data.title || "Artifact"}`];
  if (isFilled(data.summary)) lines.push("", data.summary);

  const meta = [
    isFilled(data.status) && `Status: ${data.status}`,
    isFilled(data.lifecycle) && `Lifecycle: ${data.lifecycle}`,
    isFilled(data.project) && `Project: ${data.project}`,
    isFilled(data.owner) && `Owner: ${data.owner}`,
    isFilled(data.updated) && `Updated: ${data.updated}`,
    isFilled(data.version) && `Version: ${data.version}`,
    hasProgress(data) && `Progress: ${calculateProgress(data)}%`,
  ].filter(Boolean);
  if (meta.length) lines.push("", meta.join(" · "));

  // Lifecycle is the machine-readable staleness signal; status stays prose. An
  // agent skimming the Markdown must not mistake a superseded plan for a live
  // one, so the redirect is stated up front, not buried in the meta line.
  if (data.lifecycle === "superseded") {
    lines.push(
      "",
      `> **Superseded.** ${isFilled(data.supersededBy) ? `Read \`${data.supersededBy}\` instead — this document is kept for history only.` : "This document is kept for history only."}`,
    );
  } else if (data.lifecycle === "archived") {
    lines.push("", "> **Archived.** Kept for history; no longer current.");
  }

  if ((data.highlights || []).length) {
    lines.push("", "## Highlights");
    for (const item of data.highlights) {
      lines.push(`- **${item.label || "Highlight"}:** ${item.value || ""}`);
    }
  }

  if ((data.phases || []).length) {
    lines.push("", "## Phases and tasks");
    for (const phase of data.phases) {
      lines.push("", `### ${phase.name || "Phase"} (${phase.status || "planned"})`);
      if (isFilled(phase.summary)) lines.push(phase.summary);
      for (const task of phase.tasks || []) {
        lines.push(`- [${task.done ? "x" : " "}] ${task.title || "Untitled task"}`);
        if (isFilled(task.detail)) lines.push(`      ${task.detail}`);
      }
    }
  }

  (data.sections || []).forEach((section, sectionIndex) => {
    lines.push("", `## ${section.title || "Section"}`);
    for (const paragraph of section.paragraphs || []) lines.push("", paragraph);
    // Charts become tables, so an agent gets the numbers, not a picture.
    for (const chart of chartsForSection(data, sectionIndex)) lines.push("", ...renderChartMarkdown(chart));
    if ((section.bullets || []).length) {
      lines.push("");
      for (const item of section.bullets) lines.push(`- ${item}`);
    }
    if ((section.cards || []).length) {
      lines.push("");
      for (const card of section.cards) {
        const link = safeHref(card.url)
          ? ` [${card.linkLabel || "Open link"}](${String(card.url).trim()})`
          : "";
        lines.push(`- **${card.title || "Item"}:** ${card.detail || ""}${link}`);
      }
    }
  });

  if ((data.copyBlocks || []).length) {
    lines.push("", "## Text you can paste as-is");
    for (const item of data.copyBlocks) {
      const label = isFilled(item.label) ? ` (${item.label})` : "";
      lines.push("", `### ${item.title || "Text"}${label}`);
      // Fenced verbatim. The fence is widened past the longest backtick run in
      // the text so a block containing backticks cannot terminate it early.
      const text = String(item.text ?? "");
      const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
      const fence = "`".repeat(Math.max(3, longest + 1));
      lines.push(fence, text, fence);
    }
  }

  if ((data.architecture || []).length) {
    lines.push("", "## System shape");
    data.architecture.forEach((item, index) => {
      lines.push(`${index + 1}. **${item.label || "Component"}** — ${item.detail || ""}`);
    });
  }

  if ((data.decisions || []).length) {
    lines.push("", "## Decisions");
    for (const item of data.decisions) {
      lines.push(`- **${item.title || "Decision"}:** ${item.decision || ""}`);
      if (isFilled(item.rationale)) lines.push(`      Why: ${item.rationale}`);
    }
  }

  if ((data.risks || []).length) {
    lines.push("", "## Risks");
    for (const item of data.risks) {
      lines.push(`- **[${item.severity || "medium"}] ${item.title || "Risk"}:** ${item.description || ""}`);
      if (isFilled(item.mitigation)) lines.push(`      Mitigation: ${item.mitigation}`);
    }
  }

  if ((data.nextActions || []).length) {
    lines.push("", "## Next actions");
    for (const item of data.nextActions) lines.push(`- ${item}`);
  }

  if ((data.links || []).length) {
    lines.push("", "## Links");
    for (const item of data.links) {
      if (isFilled(item.label) && isFilled(item.url)) lines.push(`- [${item.label}](${item.url})`);
    }
  }

  if (isFilled(data.footer)) lines.push("", "---", data.footer);

  lines.push("");
  return lines.join("\n");
}

export const TEMPLATE_SCRIPT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../assets/plan-site/interactive.js");

// The artifact's own interactive.js when it has one (a customization), else
// the bundled template. Shared by the build and the validator so both always
// render against the same script.
export async function resolveScript(dir) {
  try {
    return { script: await readFile(resolve(dir, "interactive.js"), "utf8"), source: "local" };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { script: await readFile(TEMPLATE_SCRIPT, "utf8"), source: "template" };
  }
}

// Identifies the built page to its own script: the artifact's slug (its
// directory name) and a short hash of its source. Copy feedback quotes both.
// Derived from the directory name only, never its full path, so a build from a
// publish snapshot matches a build from the working tree byte for byte.
export function pageInfo(data, slug) {
  if (!isFilled(slug)) return null;
  return {
    slug: String(slug),
    build: createHash("sha256").update(JSON.stringify(data)).digest("hex").slice(0, 8),
  };
}

export function renderArtifact(data, { styles, script, page = null }) {
  assertValidCharts(data);
  assertValidAnchorIds(data);
  const ids = assignAnchors(data);
  const progress = calculateProgress(data);
  const showProgress = hasProgress(data);
  const tasks = allTasks(data);
  const title = data.title || "Artifact";

  const phases = data.phases || [];
  const sections = data.sections || [];
  const copyBlocks = data.copyBlocks || [];
  const architecture = data.architecture || [];
  const decisions = data.decisions || [];
  const risks = data.risks || [];
  const nextActions = data.nextActions || [];
  const links = renderLinks(data.links || []);

  const navEntries = [
    phases.length && ["phases", "Phases and tasks"],
    ...sections.map((section, index) => [`section-${index}`, section.title || "Section"]),
    copyBlocks.length && ["copy-blocks", "Ready-to-use text"],
    architecture.length && ["architecture", "System shape"],
    decisions.length && ["decisions", "Decisions"],
    risks.length && ["risks", "Risks"],
    nextActions.length && ["next-actions", "Next actions"],
  ].filter(Boolean);
  const nav = navEntries.length > 1
    ? `\n      <nav class="section-nav" aria-label="Artifact sections">
        <p class="nav-label">On this page</p>
        ${navEntries.map(([id, label]) => `<a href="#${id}">${esc(label)}</a>`).join("\n        ")}
      </nav>`
    : "";

  const filters = tasks.length
    ? `
              <div class="filter-group" role="group" aria-label="Filter tasks">
                <button class="filter is-active" type="button" data-filter="all" aria-pressed="true">All</button>
                <button class="filter" type="button" data-filter="open" aria-pressed="false">Open</button>
                <button class="filter" type="button" data-filter="done" aria-pressed="false">Done</button>
              </div>`
    : "";

  const phasesSection = phases.length
    ? `<section class="content-section" id="phases" data-anchor="phases">
            <div class="section-heading">
              <div>
                <p class="section-kicker">Execution</p>
                <h2>Phases and tasks</h2>
              </div>${filters}
            </div>
            <div class="phase-list" id="phase-list">
              ${renderPhases(phases, ids)}
            </div>
          </section>`
    : "";

  const sectionMarkup = sections
    .map((section, index) => renderSection(section, index, chartsForSection(data, index), ids.sections[index], ids.cards[index]))
    .join("\n\n          ");

  const copyBlocksSection = copyBlocks.length
    ? `<section class="content-section" id="copy-blocks" data-anchor="copy-blocks">
            <div class="section-heading">
              <div>
                <p class="section-kicker">Ready to use</p>
                <h2>Text you can paste as-is</h2>
              </div>
            </div>
            <div class="copy-block-list">
              ${renderCopyBlocks(copyBlocks, ids.copyBlocks)}
            </div>
          </section>`
    : "";

  const architectureSection = architecture.length
    ? `<section class="content-section" id="architecture" data-anchor="architecture">
            <div class="section-heading">
              <div>
                <p class="section-kicker">System</p>
                <h2>How the pieces connect</h2>
              </div>
            </div>
            <div class="architecture-flow" id="architecture-flow">
              ${renderArchitecture(architecture, ids.architecture)}
            </div>
          </section>`
    : "";

  const decisionsHalf = decisions.length
    ? `<div id="decisions" data-anchor="decisions">
              <div class="section-heading compact">
                <div>
                  <p class="section-kicker">Direction</p>
                  <h2>Key decisions</h2>
                </div>
              </div>
              <div class="stack-list" id="decision-list">
                ${renderDecisions(decisions, ids.decisions)}
              </div>
            </div>`
    : "";
  const risksHalf = risks.length
    ? `<div id="risks" data-anchor="risks">
              <div class="section-heading compact">
                <div>
                  <p class="section-kicker">Watchlist</p>
                  <h2>Risks and mitigations</h2>
                </div>
              </div>
              <div class="stack-list" id="risk-list">
                ${renderRisks(risks, ids.risks)}
              </div>
            </div>`
    : "";
  const splitSection = decisionsHalf || risksHalf
    ? `<section class="content-section${decisionsHalf && risksHalf ? " split-section" : ""}">
            ${[decisionsHalf, risksHalf].filter(Boolean).join("\n\n            ")}
          </section>`
    : "";

  const actionsSection = nextActions.length
    ? `<section class="content-section action-section" id="next-actions" data-anchor="next-actions">
            <div>
              <p class="section-kicker">Momentum</p>
              <h2>What happens next</h2>
              <p class="section-description">The smallest actions that move this forward.</p>
            </div>
            <ol class="action-list" id="action-list">
            ${renderActions(nextActions)}
            </ol>
          </section>`
    : "";

  const bodySections = [
    phasesSection,
    sectionMarkup,
    copyBlocksSection,
    architectureSection,
    splitSection,
    actionsSection,
  ]
    .filter(Boolean)
    .join("\n\n          ");

  const progressBlock = showProgress
    ? `

        <div class="progress-block" aria-label="Progress">
          <div class="progress-heading">
            <span id="progress-title">Progress</span>
            <strong id="progress-value">${progress}%</strong>
          </div>
          <progress
            class="progress-track"
            id="progress-bar"
            max="100"
            value="${progress}"
            aria-label="Overall progress"
          >${progress}%</progress>
          <p id="progress-caption">${esc(data.progressCaption || "Calculated from completed tasks.")}</p>
        </div>`
    : "";

  const highlightsSection = (data.highlights || []).length
    ? `

      <section class="highlights" id="highlights" aria-label="Highlights" data-anchor="highlights">
        ${renderHighlights(data.highlights, ids.highlights)}
      </section>`
    : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="description" content="${esc(data.summary || "A shareable project artifact.")}" />
    <meta name="robots" content="noindex, nofollow" />${
      page
        ? `\n    <meta name="artifact-slug" content="${esc(page.slug)}" />\n    <meta name="artifact-build" content="${esc(page.build)}" />`
        : ""
    }
    <link rel="alternate" type="text/markdown" href="artifact.md" title="Markdown for agents" />
    <link rel="alternate" type="application/json" href="artifact.json" title="Artifact source JSON" />
    <title>${esc(title)}</title>
    <style>${STATUS_NOTE_CSS}
${styles}
    </style>
  </head>
  <body>
    <a class="skip-link" href="#main">Skip to content</a>

    <header class="site-header">
      <a class="brand" href="#top" aria-label="Top of artifact">
        <span class="brand-mark" aria-hidden="true">A</span>
        <span>Artifact</span>
      </a>
      <div class="header-actions">
        <button class="quiet-button" id="theme-toggle" type="button" aria-label="Change color theme">
          <span aria-hidden="true">◐</span>
          <span class="button-label">Theme</span>
        </button>
        <button class="quiet-button" id="print-button" type="button" aria-label="Print">
          <span aria-hidden="true">⎙</span>
          <span class="button-label">Print</span>
        </button>
        <button class="copy-button" id="copy-agent" type="button" data-copy aria-label="Copy for agent">
          <span aria-hidden="true">⧉</span>
          <span class="button-label">Copy for agent</span>
        </button>
      </div>
    </header>

    <main id="main">
      <section class="hero" id="top" aria-labelledby="artifact-title">
        <div class="eyebrow-row">
          <p class="eyebrow" id="eyebrow">${esc(data.eyebrow || "Artifact")}</p>
          ${renderStatus(data.status)}
        </div>
        <h1 id="artifact-title"${anchor("title", title)}>${esc(title)}</h1>
        <p class="hero-summary" id="summary"${anchor("summary", data.summary)}>${esc(data.summary || "")}</p>${
          data.lifecycle === "superseded"
            ? `\n        <p class="lifecycle-notice" data-lifecycle="superseded">Superseded${isFilled(data.supersededBy) ? ` by <a href="../${esc(data.supersededBy)}/">${esc(data.supersededBy)}</a>` : ""} — kept for history only.</p>`
            : data.lifecycle === "archived"
              ? `\n        <p class="lifecycle-notice" data-lifecycle="archived">Archived — kept for history; no longer current.</p>`
              : ""
        }
        <div class="meta-row" id="meta-row">${renderMeta(data)}</div>${progressBlock}
      </section>${highlightsSection}
${nav}

      <div class="sections">
          ${bodySections}
      </div>
    </main>

    <footer>
      <p id="footer-copy">${esc(data.footer || "Generated as a reviewable project artifact.")}</p>
      <div id="link-list" class="footer-links">
        ${links ? `${links}\n        ` : ""}<a href="artifact.md">Markdown for agents</a>
        <a href="artifact.json">JSON source</a>
      </div>
    </footer>

    <div class="toast" id="toast" role="status" aria-live="polite" hidden></div>

    <script type="application/json" id="artifact-data">
${embedAsJson(data)}
    </script>
    <script type="application/json" id="artifact-markdown">
${embedAsJson(renderMarkdown(data))}
    </script>
    <script>
${script}
    </script>
  </body>
</html>
`;
}
