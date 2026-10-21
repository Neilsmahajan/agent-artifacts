// Run: node --test <skill-dir>/tests/
//
// Build-time charts: rendered markup, the Markdown tables, schema validation,
// and the guarantee that an artifact without charts builds exactly as before.
//
// Scratch dirs live under ~/.cache because the scripts refuse temp roots.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { CHART_WIDTHS, chartTable, formatValue, validateCharts } from "../scripts/charts.mjs";
import { renderArtifact, renderMarkdown } from "../scripts/render.mjs";

const skillDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = (name) => resolve(skillDir, "scripts", name);
const scratchParent = process.env.PUBLISH_TEST_SCRATCH || resolve(homedir(), ".cache", "publish-cloudflare-artifact-tests");
const assets = { styles: "/* css */", script: "/* js */" };

let scratch;
before(async () => {
  await mkdir(scratchParent, { recursive: true });
  scratch = await mkdtemp(resolve(scratchParent, "charts-"));
});
after(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

const base = () => ({
  title: "Chart fixture",
  summary: "Fixture.",
  status: "Test fixture",
  lifecycle: "active",
  project: "test",
  updated: "2026-10-01",
  sections: [
    { title: "Budget", paragraphs: ["Where the budget goes."], bullets: ["One bullet."] },
    { title: "Results", paragraphs: ["How the quarter went."] },
  ],
});

const sampleCharts = () => [
  {
    id: "split",
    section: 0,
    type: "stack",
    title: "Most of the budget is people",
    caption: "Planned spend, fiscal year.",
    format: "currency",
    rows: [
      { label: "People", value: 600000 },
      { label: "Tools", value: 250000 },
      { label: "Travel", value: 150000, slot: 7 },
    ],
  },
  {
    id: "bridge",
    section: 0,
    type: "waterfall",
    title: "Opening cash plus sales, minus costs",
    valueLabel: "Amount",
    format: "currency",
    rows: [
      { label: "Opening cash", value: 1000, kind: "start" },
      { label: "Sales", value: 400 },
      { label: "New tooling", value: 150, tone: "part" },
      { label: "Costs", value: -300 },
      { label: "Closing cash", kind: "total" },
    ],
  },
  {
    id: "teams",
    section: 1,
    type: "diverge",
    title: "Two teams beat plan",
    format: "number",
    noteLabel: "Plan",
    rows: [
      { label: "North", value: 12, pct: 8.5, note: "140" },
      { label: "South", value: -7, pct: -4.2, note: "165" },
    ],
  },
  {
    id: "growth",
    section: 1,
    type: "compare",
    title: "Growth trails the index",
    format: "percent",
    digits: 2,
    signed: true,
    series: ["Us", { label: "Index", slot: 7 }],
    rows: [
      { label: "This year", values: [4.5, 6.25] },
      { label: "Last year", values: [-1.5, 2] },
    ],
  },
];

const withCharts = (charts = sampleCharts()) => ({ ...base(), charts });

test("no charts is a byte-for-byte no-op", async () => {
  const template = JSON.parse(await readFile(resolve(skillDir, "assets/plan-site/artifact.json"), "utf8"));
  // The embedded artifact-data block is the lossless source, so it differs by
  // the `charts` key itself; everything rendered from it must not.
  const withoutSource = (html) => html.replace(/<script type="application\/json" id="artifact-data">[\s\S]*?<\/script>/, "");
  for (const data of [base(), template]) {
    const html = renderArtifact(data, assets);
    assert.equal(withoutSource(renderArtifact({ ...data, charts: [] }, assets)), withoutSource(html));
    assert.equal(renderMarkdown({ ...data, charts: [] }), renderMarkdown(data));
    assert.doesNotMatch(html.replace(/<script type="application\/json"[\s\S]*?<\/script>/g, ""), /viz|<svg|<figure/);
  }
  // The section markup is unchanged when the section has no chart of its own.
  const one = renderArtifact({ ...base(), charts: [sampleCharts()[2]] }, assets);
  const plain = renderArtifact(base(), assets);
  const section0 = (html) => html.match(/<section class="content-section" id="section-0"[^>]*>[\s\S]*?<\/section>/)[0];
  assert.equal(section0(one), section0(plain));
});

test("charts render into their section as static SVG with a table fallback", () => {
  const html = renderArtifact(withCharts(), assets);
  const section = (index) => html.match(new RegExp(`<section class="content-section" id="section-${index}"[^>]*>[\\s\\S]*?</section>`))[0];
  assert.match(section(0), /id="chart-split"[\s\S]*id="chart-bridge"/);
  assert.match(section(1), /id="chart-teams"[\s\S]*id="chart-growth"/);
  // After the prose, before the bullets.
  assert.ok(section(0).indexOf("chart-split") > section(0).indexOf("section-body"));
  assert.ok(section(0).indexOf("chart-bridge") < section(0).indexOf("bullet-list"));

  // Text-bearing charts ship one SVG per width; the stack is one fluid SVG.
  for (const id of ["bridge", "teams", "growth"]) {
    const figure = html.match(new RegExp(`<figure class="viz viz-\\w+" id="chart-${id}"[^>]*>[\\s\\S]*?</figure>`))[0];
    for (const width of CHART_WIDTHS) {
      assert.match(figure, new RegExp(`<svg class="viz-svg viz-w${width}" viewBox="0 0 ${width} [\\d.]+"`));
    }
    assert.match(figure, new RegExp(`aria-labelledby="viz-title-${id}"`));
    assert.match(figure, /<details class="viz-table"><summary>Show as table<\/summary><table>/);
  }
  const stack = html.match(/<figure class="viz viz-stack"[\s\S]*?<\/figure>/)[0];
  assert.equal((stack.match(/<svg /g) || []).length, 1);
  assert.match(stack, /<svg class="viz-fluid" width="100%"/);
  assert.match(stack, /class="viz-mark viz-s7"><title>Travel: \$150,000 \(15\.0%\)<\/title>/);
  assert.match(stack, /<ul class="viz-legend">/);

  // Every data mark carries a hover title.
  const rects = html.match(/<rect\b[^>]*>(?:<title>[^<]*<\/title>)?<\/rect>/g);
  assert.ok(rects.length > 20);
  for (const mark of rects) assert.match(mark, /<title>[^<]+<\/title>/);

  // Waterfall tones and running totals.
  assert.match(html, /class="viz-mark viz-total"><title>Closing cash: \$1,250<\/title>/);
  assert.match(html, /class="viz-mark viz-part"><title>New tooling: \+\$150<\/title>/);
  assert.match(html, /class="viz-mark viz-down"><title>Costs: −\$300<\/title>/);
  assert.match(html, /<title>South: −7 \(−4\.2%\) · Plan: 165<\/title>/);
  assert.match(html, /<title>Index, Last year: \+2\.00%<\/title>/);

  // Colors only ever come from classes, never inline styles or remote refs.
  const charts = html.slice(html.indexOf("<figure"), html.lastIndexOf("</figure>"));
  assert.doesNotMatch(charts, /style=|href=|xlink|<use|<image|<foreignObject/i);
});

test("each width variant keeps its geometry inside its own viewBox", () => {
  const html = renderArtifact(withCharts(), assets);
  for (const [, width, body] of html.matchAll(/<svg class="viz-svg viz-w(\d+)"[^>]*>([\s\S]*?)<\/svg>/g)) {
    for (const [, value] of body.matchAll(/\bx[12]?="(-?[\d.]+)"/g)) {
      assert.ok(Number(value) >= 0 && Number(value) <= Number(width), `x=${value} outside 0..${width}`);
    }
  }
  // The narrow waterfall turns into rows: values right-aligned at the edge.
  const narrow = html.match(/<figure class="viz viz-waterfall"[\s\S]*?<svg class="viz-svg viz-w340"[^>]*>([\s\S]*?)<\/svg>/)[1];
  assert.match(narrow, /<text x="340" y="[\d.]+" text-anchor="end" class="viz-value">−\$300<\/text>/);
});

test("chart text is escaped everywhere it appears", () => {
  const evil = "<img src=x onerror=alert(1)>\"'&";
  const charts = [
    { id: "x", section: 0, type: "waterfall", title: evil, caption: evil, valueLabel: evil, rows: [{ label: evil, value: 1 }] },
    { id: "y", section: 0, type: "compare", title: "t", series: [evil], rows: [{ label: evil, values: [1] }] },
    { id: "z", section: 0, type: "diverge", title: "t", noteLabel: evil, rows: [{ label: "a", value: -1, note: evil }] },
  ];
  const html = renderArtifact(withCharts(charts), assets);
  const visible = html.replace(/<script type="application\/json"[\s\S]*?<\/script>/g, "");
  assert.doesNotMatch(visible, /<img|onerror=alert\(1\)>|"'&</);
  assert.match(visible, /&lt;img src=x onerror=alert\(1\)&gt;&quot;&#39;&amp;/);
});

test("Markdown carries each chart as a table under its section", () => {
  const markdown = renderMarkdown(withCharts());
  const budget = markdown.slice(markdown.indexOf("## Budget"), markdown.indexOf("## Results"));
  assert.match(budget, /\*\*Chart:\*\* Most of the budget is people\n\nPlanned spend, fiscal year\.\n\n\|  \| Value \| Share \|\n\| --- \| ---: \| ---: \|\n\| People \| \$600,000 \| 60\.0% \|/);
  assert.match(budget, /\| Total \| \$1,000,000 \| 100\.0% \|/);
  assert.match(budget, /\|  \| Amount \|\n\| --- \| ---: \|\n\| Opening cash \| \$1,000 \|\n\| Sales \| \+\$400 \|\n\| New tooling \| \+\$150 \|\n\| Costs \| −\$300 \|\n\| Closing cash \| \$1,250 \|/);
  // Charts sit after the prose and before the bullets, like the page.
  assert.ok(budget.indexOf("**Chart:**") > budget.indexOf("Where the budget goes."));
  assert.ok(budget.indexOf("**Chart:**") < budget.indexOf("- One bullet."));
  const results = markdown.slice(markdown.indexOf("## Results"));
  assert.match(results, /\|  \| Value \| % \| Plan \|\n\| --- \| ---: \| ---: \| ---: \|\n\| North \| \+12 \| \+8\.5% \| 140 \|/);
  assert.match(results, /\|  \| Us \| Index \|\n\| --- \| ---: \| ---: \|\n\| This year \| \+4\.50% \| \+6\.25% \|\n\| Last year \| −1\.50% \| \+2\.00% \|/);

  const piped = renderMarkdown(withCharts([{ id: "p", section: 1, type: "diverge", title: "t", rows: [{ label: "a | b\nc", value: 1 }] }]));
  assert.match(piped, /\| a \\\| b c \| \+1 \|/);
});

test("number formatting is pinned, signed, and has no negative zero", () => {
  assert.equal(formatValue(1234.5, { format: "currency" }), "$1,235");
  assert.equal(formatValue(0.51, { format: "currency" }), "$0.51");
  assert.equal(formatValue(-56652.08, { format: "currency" }), "−$56,652");
  assert.equal(formatValue(10, { format: "currency", currency: "EUR" }, { signed: true }), "+€10");
  assert.equal(formatValue(12.345, { format: "percent" }), "12.3%");
  assert.equal(formatValue(-0.001, { format: "percent" }, { signed: true }), "0.0%");
  assert.equal(formatValue(-0, {}), "0");
  assert.equal(formatValue(1234567.891, {}), "1,234,567.89");
  assert.equal(formatValue(3, { digits: 2 }), "3.00");
  assert.deepEqual(chartTable(sampleCharts()[1]).rows.at(-1), ["Closing cash", "$1,250"]);
});

test("validation explains each schema problem", () => {
  assert.deepEqual(validateCharts(withCharts()), []);
  assert.deepEqual(validateCharts(base()), []);
  assert.deepEqual(validateCharts({ ...base(), charts: {} }), ["charts must be an array"]);

  const errors = validateCharts(
    withCharts([
      { id: "a", section: 0, type: "pie", title: "t", rows: [{ label: "x", value: 1 }] },
      { id: "a", section: 5, type: "stack", title: "t", rows: [{ label: "x", value: -1 }] },
      { id: "bad id", section: 0, type: "stack", title: "", rows: [] },
      { id: "w", section: 0, type: "waterfall", title: "t", format: "money", digits: 9, currency: "usd", rows: [
        { label: "s", value: "10" },
        { label: "start late", kind: "start", value: 1 },
        { label: "sub", kind: "subtotal", value: 5 },
        { label: "odd", kind: "sideways", value: 1 },
        { label: "toned total", kind: "total", tone: "part" },
      ] },
      { id: "d", section: 1, type: "diverge", title: "t", rows: [{ label: "", value: 1, pct: "5" }] },
      { id: "c", section: 1, type: "compare", title: "t", series: ["A", { label: "B", slot: 9 }], rows: [{ label: "r", values: [1] }, { label: "q" }] },
      { id: "e", section: 1, type: "compare", title: "t", rows: [{ label: "r", values: [1] }] },
    ]),
  );
  const expected = [
    "charts[0] type must be one of: stack, waterfall, diverge, compare",
    'charts[1] id "a" is used by another chart',
    "charts[1] section must be an index into sections (0-1)",
    "charts[1] rows[0] value must not be negative in a stack",
    "charts[1] stack needs at least one positive value",
    "charts[2] requires id (letters, digits, hyphens, underscores)",
    "charts[2] requires title",
    "charts[2] requires rows (a non-empty array)",
    "charts[3] format must be one of: number, currency, percent",
    "charts[3] digits must be a whole number from 0 to 6",
    "charts[3] currency must be an ISO 4217 code such as USD or EUR",
    "charts[3] rows[0] value must be a finite number",
    "charts[3] rows[1] kind start is only allowed on the first row",
    "charts[3] rows[2] is a subtotal: its value is computed from the rows above, so omit value",
    "charts[3] rows[3] kind must be one of: start, step, subtotal, total",
    'charts[3] rows[4] tone must be "part", and only on a step',
    "charts[4] rows[0] requires label",
    "charts[4] rows[0] pct must be a finite number",
    "charts[5] series[1].slot must be a whole number from 1 to 8",
    "charts[5] rows[0] values has 1 numbers for 2 series",
    "charts[5] rows[1] requires values (one number per series)",
    "charts[6] compare requires series: 1 to 4 names (strings or {label, slot})",
  ];
  for (const message of expected) assert.ok(errors.includes(message), `missing: ${message}\ngot:\n${errors.join("\n")}`);
  assert.equal(errors.length, expected.length, errors.join("\n"));

  assert.match(validateCharts({ ...base(), sections: undefined, phases: [{ name: "p", summary: "s" }], charts: [sampleCharts()[0]] })[0], /the artifact has no sections/);
  assert.throws(() => renderArtifact(withCharts([{ id: "q", section: 0, type: "pie", title: "t", rows: [] }]), assets), /Invalid charts/);
});

test("a charted artifact builds, validates, and fails clearly when broken", async () => {
  const dir = resolve(scratch, "charted");
  const created = spawnSync(process.execPath, [script("create-artifact.mjs"), "--output", dir], { encoding: "utf8" });
  assert.equal(created.status, 0, created.stderr);
  await writeFile(resolve(dir, "artifact.json"), JSON.stringify(withCharts(), null, 2));
  const built = spawnSync(process.execPath, [script("build-artifact.mjs"), dir], { encoding: "utf8" });
  assert.equal(built.status, 0, built.stderr);
  const valid = spawnSync(process.execPath, [script("validate-artifact.mjs"), dir], { encoding: "utf8" });
  assert.equal(valid.status, 0, valid.stderr);
  assert.doesNotMatch(valid.stderr, /chart rules/);

  // A stylesheet without the chart block is flagged.
  await writeFile(resolve(dir, "styles.css"), "body { color: black; }\n");
  spawnSync(process.execPath, [script("build-artifact.mjs"), dir], { encoding: "utf8" });
  const unstyled = spawnSync(process.execPath, [script("validate-artifact.mjs"), dir], { encoding: "utf8" });
  assert.match(unstyled.stderr, /WARN: artifact has charts but styles\.css has no chart rules/);

  // Broken charts: schema errors, one per line, instead of a failed rebuild.
  const data = withCharts();
  data.charts[1].rows[1].value = null;
  await writeFile(resolve(dir, "artifact.json"), JSON.stringify(data, null, 2));
  const invalid = spawnSync(process.execPath, [script("validate-artifact.mjs"), dir], { encoding: "utf8" });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /ERROR: charts\[1\] rows\[1\] value must be a finite number/);
  assert.doesNotMatch(invalid.stderr, /Could not rebuild/);
  const rebuild = spawnSync(process.execPath, [script("build-artifact.mjs"), dir], { encoding: "utf8" });
  assert.notEqual(rebuild.status, 0);
  assert.match(rebuild.stderr, /Invalid charts:\n- charts\[1\] rows\[1\] value must be a finite number/);
});

test("review regressions: cramped plots, huge values, id clashes, odd titles", () => {
  // Value columns wider than the plot: the label column gives way, the scale
  // never reverses, and every bar keeps a positive width.
  const cramped = withCharts([{
    id: "v", section: 0, type: "diverge", title: "t", format: "currency", digits: 2,
    rows: [{ label: "Positive variance", value: 100000000 }, { label: "Negative variance", value: -100000000 }],
  }]);
  const narrow = renderArtifact(cramped, assets).match(/<svg class="viz-svg viz-w340"[^>]*>([\s\S]*?)<\/svg>/)[1];
  const bars = [...narrow.matchAll(/<rect x="(-?[\d.]+)" y="[\d.]+" width="([\d.]+)"/g)].map(([, x, w]) => [Number(x), Number(w)]);
  assert.equal(bars.length, 2);
  for (const [x, w] of bars) assert.ok(x >= 0 && w > 10 && x + w <= 340, `${x}+${w}`);
  assert.ok(bars[1][0] < bars[0][0], "negative bar sits left of the positive one");

  // Values whose sum would overflow are rejected up front.
  const huge = validateCharts(withCharts([{ id: "h", section: 0, type: "stack", title: "t", rows: [{ label: "a", value: 1e308 }, { label: "b", value: 1e308 }] }]));
  assert.ok(huge.includes("charts[0] rows[0] value must be a finite number within ±1000000000000000"), huge.join("\n"));

  // Caption ids live in their own namespace, so no two ids in the page clash.
  const html = renderArtifact(withCharts([
    { id: "x", section: 0, type: "diverge", title: "t", rows: [{ label: "a", value: 1 }] },
    { id: "x-title", section: 0, type: "diverge", title: "t", rows: [{ label: "a", value: 1 }] },
    { id: "title-x", section: 0, type: "diverge", title: "t", rows: [{ label: "a", value: 1 }] },
  ]), assets);
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => id);
  assert.equal(new Set(ids).size, ids.length, ids.join(" "));

  // A non-string title is a field error, not a crash.
  const odd = validateCharts(withCharts([{ id: "o", section: 0, type: "diverge", title: { toString: null }, rows: [{ label: "a", value: 1 }] }]));
  assert.deepEqual(odd, ["charts[0] requires title"]);
});
