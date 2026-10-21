// Run: node --test <skill-dir>/tests/
//
// Stable anchors (data-anchor / data-fp), authored ids, the template
// interactive.js fallback, and the comment layer's safety rules.
//
// Scratch dirs live under ~/.cache because the scripts refuse temp roots.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { assignAnchors, chartRowKeys, fingerprint, listAnchors, slugify, validateAnchorIds } from "../scripts/anchors.mjs";
import { pageInfo, renderArtifact } from "../scripts/render.mjs";

const skillDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = (name) => resolve(skillDir, "scripts", name);
const scratchParent = process.env.PUBLISH_TEST_SCRATCH || resolve(homedir(), ".cache", "publish-cloudflare-artifact-tests");
const assets = { styles: "/* css */", script: "/* js */" };
const run = (name, ...args) => spawnSync(process.execPath, [script(name), ...args], { encoding: "utf8" });
const exists = (path) => access(path).then(() => true, () => false);

let scratch;
before(async () => {
  await mkdir(scratchParent, { recursive: true });
  scratch = await mkdtemp(resolve(scratchParent, "anchors-"));
});
after(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

const base = () => ({
  title: "Anchor fixture",
  summary: "Fixture.",
  status: "Test fixture",
  lifecycle: "active",
  project: "test",
  updated: "2026-10-17",
  phases: [
    { name: "Phase 0: Set up", summary: "First.", tasks: [{ title: "Write the code" }, { title: "Test it", done: true }] },
  ],
  sections: [
    { title: "Cash on hand", paragraphs: ["Cash covers four months.", "Second paragraph."], bullets: ["One", "Two"] },
    { title: "Debt", paragraphs: ["The margin loan."], cards: [{ title: "Visa", detail: "Paid monthly." }] },
  ],
  decisions: [{ title: "Keep it simple", decision: "Yes." }],
  risks: [{ title: "Concentration", severity: "high", description: "One stock." }],
  nextActions: ["Do the thing"],
});

const anchorsIn = (html) => [...html.matchAll(/data-anchor="([^"]+)"/g)].map(([, id]) => id);

test("ids follow the grammar: kind prefix plus a slug of the title", () => {
  const ids = assignAnchors(base());
  assert.deepEqual(ids.sections, ["sec-cash-on-hand", "sec-debt"]);
  assert.deepEqual(ids.phases, ["phase-0-set-up"]);
  assert.deepEqual(ids.tasks, [["task-write-the-code", "task-test-it"]]);
  assert.deepEqual(ids.cards[1], ["card-visa"]);
  assert.deepEqual(ids.decisions, ["dec-keep-it-simple"]);
  assert.deepEqual(ids.risks, ["risk-concentration"]);

  assert.equal(slugify("Jordan/Sam: down $21,898, with a margin call"), "jordan-sam-down-21-898-with-a-margin");
  assert.equal(slugify("Café déjà vu"), "cafe-deja-vu");
  // Long titles are cut at a word break.
  assert.equal(slugify("Decide: which pages get comments, and how long they're kept"), "decide-which-pages-get-comments-and-how");
  // A title with no ASCII letters falls back to its position.
  assert.equal(assignAnchors({ ...base(), sections: [{ title: "Notes" }, { title: "日本" }] }).sections[1], "sec-2");

  const listed = listAnchors(base()).map(({ anchor }) => anchor);
  for (const id of ["title", "summary", "phases", "sec-cash-on-hand.p2", "sec-cash-on-hand.b1", "decisions", "risks", "next-actions", "next-actions.b1"]) {
    assert.ok(listed.includes(id), id);
  }
  // The CLI list covers exactly what the page can be commented on.
  const charted = { ...base(), charts: [{ id: "split", section: 0, type: "stack", title: "Split", rows: [{ label: "A", value: 1 }] }] };
  const rendered = new Set(anchorsIn(renderArtifact(charted, assets)));
  assert.deepEqual(new Set(listAnchors(charted).map(({ anchor }) => anchor)), rendered);
});

test("reordering sections keeps their ids, and paragraphs follow their section", () => {
  const data = base();
  const reordered = { ...data, sections: [data.sections[1], data.sections[0]] };
  assert.deepEqual(assignAnchors(reordered).sections, ["sec-debt", "sec-cash-on-hand"]);

  const html = renderArtifact(reordered, assets);
  const debt = html.match(/<section class="content-section" id="section-0"[^>]*>[\s\S]*?<\/section>/)[0];
  assert.match(debt, /data-anchor="sec-debt"/);
  assert.match(debt, /<p data-anchor="sec-debt\.p1" data-fp="[0-9a-f]{8}">The margin loan\.<\/p>/);
  // Positional HTML ids (deep links, the nav, custom scripts) are unchanged.
  assert.match(html, /<a href="#section-1">Cash on hand<\/a>/);
});

test("duplicate titles get unique ids", () => {
  const data = { ...base(), sections: [{ title: "Notes" }, { title: "Notes" }, { title: "Notes" }] };
  assert.deepEqual(assignAnchors(data).sections, ["sec-notes", "sec-notes-2", "sec-notes-3"]);
  const tasks = { ...base(), phases: [{ name: "A", summary: "a", tasks: [{ title: "Ship" }] }, { name: "B", summary: "b", tasks: [{ title: "Ship" }] }] };
  assert.deepEqual(assignAnchors(tasks).tasks, [["task-ship"], ["task-ship-2"]]);

  // Every anchor on a full page is unique, and so are the HTML ids.
  const html = renderArtifact({ ...base(), sections: [...base().sections, { title: "Debt", paragraphs: ["Again."] }] }, assets);
  const anchors = anchorsIn(html);
  assert.equal(new Set(anchors).size, anchors.length, anchors.join(" "));
  const htmlIds = [...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => id);
  assert.equal(new Set(htmlIds).size, htmlIds.length);
});

test("explicit ids win, verbatim, and derived ids step around them", () => {
  const data = base();
  data.sections[0].id = "cash";
  data.sections[1].id = "sec-cash-on-hand"; // claims the id the first section would derive
  data.sections.push({ title: "Cash on hand" });
  const ids = assignAnchors(data);
  assert.deepEqual(ids.sections, ["cash", "sec-cash-on-hand", "sec-cash-on-hand-2"]);
  const html = renderArtifact(data, assets);
  assert.match(html, /data-anchor="cash" data-fp=/);
  assert.match(html, /data-anchor="cash\.p1"/);
});

test("the validator checks id grammar and uniqueness", async () => {
  const data = base();
  data.sections[0].id = "Cash On Hand";
  data.sections[1].id = "summary";
  data.decisions[0].id = "dup";
  data.risks[0].id = "dup";
  data.phases[0].tasks[0].id = 7;
  assert.deepEqual(validateAnchorIds(data), [
    "phases[0].tasks[0].id must be lowercase letters and digits joined by single hyphens (at most 64 characters)",
    "sections[0].id must be lowercase letters and digits joined by single hyphens (at most 64 characters)",
    'sections[1].id "summary" is reserved',
    'risks[0].id "dup" is also used by decisions[0]',
  ]);
  assert.throws(() => renderArtifact(data, assets), /Invalid ids:/);

  const charted = {
    ...base(),
    charts: [{ id: "c", section: 0, type: "diverge", title: "t", rows: [{ label: "A", value: 1, id: "x" }, { label: "B", value: 2, id: "x" }] }],
  };
  assert.deepEqual(validateAnchorIds(charted), ['charts[0].rows[1].id "x" is also used by charts[0].rows[0]']);

  // End to end: the CLI reports the field and does not attempt a rebuild.
  const dir = resolve(scratch, "bad-ids");
  assert.equal(run("create-artifact.mjs", "--output", dir).status, 0);
  await writeFile(resolve(dir, "artifact.json"), JSON.stringify(base(), null, 2));
  assert.equal(run("build-artifact.mjs", dir).status, 0);
  await writeFile(resolve(dir, "artifact.json"), JSON.stringify(data, null, 2));
  const invalid = run("validate-artifact.mjs", dir);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /ERROR: risks\[0\]\.id "dup" is also used by decisions\[0\]/);
  assert.doesNotMatch(invalid.stderr, /Could not rebuild/);
});

test("fingerprints track the text, not its formatting", () => {
  assert.match(fingerprint("Cash covers four months."), /^[0-9a-f]{8}$/);
  assert.equal(fingerprint("Cash  covers\nfour months. "), fingerprint("Cash covers four months."));
  assert.notEqual(fingerprint("Cash covers five months."), fingerprint("Cash covers four months."));

  const one = renderArtifact(base(), assets);
  const edited = base();
  edited.sections[0].paragraphs[1] = "Second paragraph, rewritten.";
  const two = renderArtifact(edited, assets);
  const fpOf = (html, id) => html.match(new RegExp(`data-anchor="${id.replace(".", "\\.")}" data-fp="([0-9a-f]{8})"`))[1];
  assert.equal(fpOf(one, "sec-cash-on-hand.p1"), fpOf(two, "sec-cash-on-hand.p1"));
  assert.notEqual(fpOf(one, "sec-cash-on-hand.p2"), fpOf(two, "sec-cash-on-hand.p2"));
});

test("every commentable block carries an anchor", () => {
  const data = {
    ...base(),
    highlights: [{ label: "Net worth", value: "$1" }],
    copyBlocks: [{ title: "Command", text: "ls" }],
    architecture: [{ label: "Page", detail: "Static." }],
  };
  const anchors = anchorsIn(renderArtifact(data, assets));
  for (const id of [
    "title", "summary", "highlights", "hl-net-worth", "phases", "phase-0-set-up", "task-write-the-code",
    "sec-cash-on-hand", "sec-cash-on-hand.p1", "sec-cash-on-hand.b2", "card-visa", "copy-blocks", "copy-command",
    "architecture", "arch-page", "decisions", "dec-keep-it-simple", "risks", "risk-concentration",
    "next-actions", "next-actions.b1",
  ]) {
    assert.ok(anchors.includes(id), `missing ${id}`);
  }
});

test("chart rows share one anchor across bars, legend and table", () => {
  const charts = [
    { id: "split", section: 0, type: "stack", title: "Split", rows: [{ label: "Bonds", value: 2 }, { label: "Stocks", value: 3, id: "equities" }] },
    { id: "moves", section: 1, type: "diverge", title: "Moves", rows: [{ label: "DT", value: -1 }, { label: "DT", value: 2 }] },
  ];
  assert.deepEqual(chartRowKeys(charts[1]), ["dt", "dt-2"]);
  const html = renderArtifact({ ...base(), charts }, assets);
  assert.match(html, /<figure class="viz viz-stack" id="chart-split" data-anchor="chart:split" data-fp="[0-9a-f]{8}">/);
  assert.match(html, /<rect [^>]*data-anchor="chart:split\/row:bonds" class="viz-mark viz-s1">/);
  assert.match(html, /<li data-anchor="chart:split\/row:equities"><span class="viz-swatch/);
  assert.match(html, /<tr data-anchor="chart:split\/row:bonds" data-fp="[0-9a-f]{8}"><th scope="row">Bonds<\/th>/);
  assert.match(html, /<tr data-anchor="chart:split\/total" data-fp="[0-9a-f]{8}"><th scope="row">Total<\/th>/);
  // Each width variant wraps the row's bar, value and label in one group.
  const groups = html.match(/<g data-anchor="chart:moves\/row:dt-2">/g) || [];
  assert.equal(groups.length, 3);
});

test("a page without its own interactive.js builds from the template and stays fresh", async () => {
  const dir = resolve(scratch, "template-js");
  assert.equal(run("create-artifact.mjs", "--output", dir).status, 0);
  assert.equal(await exists(resolve(dir, "interactive.js")), false, "the scaffold must not copy interactive.js");
  assert.equal(await exists(resolve(dir, "styles.css")), true);
  await writeFile(resolve(dir, "artifact.json"), JSON.stringify(base(), null, 2));

  const built = run("build-artifact.mjs", dir);
  assert.equal(built.status, 0, built.stderr);
  assert.match(built.stdout, /Using the bundled template interactive\.js/);
  assert.equal(await exists(resolve(dir, "interactive.js")), false, "the build must not write interactive.js back");
  const html = await readFile(resolve(dir, "index.html"), "utf8");
  const template = await readFile(resolve(skillDir, "assets/plan-site/interactive.js"), "utf8");
  assert.ok(html.includes(template), "the template script is inlined");
  assert.match(html, /<meta name="artifact-slug" content="template-js" \/>/);
  assert.match(html, new RegExp(`<meta name="artifact-build" content="${pageInfo(base(), "template-js").build}" />`));
  const valid = run("validate-artifact.mjs", dir);
  assert.equal(valid.status, 0, valid.stderr);

  // A local copy is a customization: it wins, and the validator rebuilds with it.
  await writeFile(resolve(dir, "interactive.js"), "/* custom */\n");
  assert.equal(run("validate-artifact.mjs", dir).status, 1, "the old build no longer matches");
  assert.equal(run("build-artifact.mjs", dir).status, 0);
  assert.match(await readFile(resolve(dir, "index.html"), "utf8"), /\/\* custom \*\//);
  assert.equal(run("validate-artifact.mjs", dir).status, 0);

  // A missing styles.css is still restored from the template, as before.
  await rm(resolve(dir, "styles.css"));
  assert.equal(run("build-artifact.mjs", dir).status, 0);
  assert.equal(await exists(resolve(dir, "styles.css")), true);
});

test("the comment layer never renders notes as markup and only fetches its own comments path", async () => {
  const source = await readFile(resolve(skillDir, "assets/plan-site/interactive.js"), "utf8");
  const code = source.replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|createContextualFragment/);
  assert.doesNotMatch(code, /XMLHttpRequest|sendBeacon|WebSocket|EventSource|\beval\s*\(|new Function|\bimport\s*\(/);
  // One fetch, to the endpoint the hub-comments meta names (checked against
  // this page's origin and slug), and never one that follows a redirect.
  assert.deepEqual(code.match(/\bfetch\s*\(/g), ["fetch("]);
  assert.match(code, /return fetch\(hubUrl \+ path, \{/);
  assert.match(code, /redirect: "error"/);
  assert.match(code, /target\.origin !== location\.origin \|\| target\.pathname !== "\/" \+ pageSlug \+ "\/_comments\/"/);
  assert.doesNotMatch(source, /<\/script/i);
  // Feedback block shape, as documented in the plan.
  assert.match(source, /'Feedback on "'/);
  assert.match(source, /Agent: edit artifact\.json to address these\. Keep every existing id\. Rebuild, validate, commit and publish\./);
  // Controls are hidden in print, motion is opt-in, and taps meet 44px.
  assert.match(source, /@media print\{\.notes-ui\{display:none!important\}/);
  assert.match(source, /prefers-reduced-motion:no-preference/);
  assert.match(source, /min-height:44px/);
});

test("the template stylesheet lets the task filter hide tasks on screen and shows them in print", async () => {
  const css = await readFile(resolve(skillDir, "assets/plan-site/styles.css"), "utf8");
  // `.task { display: grid }` beats the UA `[hidden]` rule, so it needs its own.
  const screen = css.match(/^\.task\[hidden\]\s*\{([^}]*)\}/m);
  assert.ok(screen, "a top-level .task[hidden] rule is required");
  assert.match(screen[1], /display:\s*none/);
  // Printing while a filter is active must still list every task.
  const print = css.slice(css.indexOf("@media print", css.indexOf(".task[hidden]"))).match(/\.task\[hidden\]\s*\{([^}]*)\}/);
  assert.ok(print, "the print stylesheet must override the hidden rule");
  assert.match(print[1], /display:\s*grid\s*!important/);
});
