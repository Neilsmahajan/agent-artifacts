// Build-time charts. `artifact.json` may declare `charts`; each one renders
// into its section as static SVG plus a "Show as table" fallback, and into the
// Markdown twin as a table. No chart needs JavaScript: the page shows the same
// charts with scripts off, to curl, and in print.
//
// Responsiveness without JavaScript. An SVG drawn once at a fixed viewBox and
// scaled to a phone shrinks its text with it (760 units on a 340px plot is 45%,
// so 13px labels read as 6px). Instead every text-bearing chart is drawn at
// three real widths (CHART_WIDTHS) and the stylesheet shows the one closest to
// the plot's width with a container query, so labels always render at 0.8-1.4x
// their design size. Each width gets its own layout, not just a rescale: a
// waterfall turns into horizontal rows when its columns get too narrow, and
// label columns size to their text. The stack bar has no text, so it is drawn
// once in percentages and simply stretches.
//
// Text widths are estimated (no font metrics at build time), deliberately on
// the generous side; labels that still do not fit are truncated with an
// ellipsis, and the full text stays in each mark's <title> and in the table.

import { chartAnchor, chartRowAnchor, chartRowKeys, fingerprint } from "./anchors.mjs";

export const CHART_TYPES = ["stack", "waterfall", "diverge", "compare"];
export const CHART_FORMATS = ["number", "currency", "percent"];
export const CHART_WIDTHS = [340, 560, 760];
export const SERIES_SLOTS = 8;
const WATERFALL_KINDS = ["start", "step", "subtotal", "total"];

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]);
const isFilled = (value) => value !== undefined && value !== null && String(value).trim() !== "";
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// ---- validation -------------------------------------------------------------

// Returns a list of human-readable problems; empty means the charts render.
export function validateCharts(data) {
  const errors = [];
  if (data.charts === undefined) return errors;
  if (!Array.isArray(data.charts)) return ["charts must be an array"];
  const sectionCount = Array.isArray(data.sections) ? data.sections.length : 0;
  const seen = new Set();

  data.charts.forEach((chart, index) => {
    const at = `charts[${index}]`;
    const fail = (message) => errors.push(`${at} ${message}`);
    if (!isObject(chart)) {
      fail("must be an object");
      return;
    }
    if (typeof chart.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(chart.id)) {
      fail("requires id (letters, digits, hyphens, underscores)");
    } else if (seen.has(chart.id)) {
      fail(`id "${chart.id}" is used by another chart`);
    } else {
      seen.add(chart.id);
    }
    if (!CHART_TYPES.includes(chart.type)) fail(`type must be one of: ${CHART_TYPES.join(", ")}`);
    if (!Number.isInteger(chart.section) || chart.section < 0 || chart.section >= sectionCount) {
      fail(
        sectionCount
          ? `section must be an index into sections (0-${sectionCount - 1})`
          : "section must be an index into sections, and the artifact has no sections",
      );
    }
    if (typeof chart.title !== "string" || !isFilled(chart.title)) fail("requires title");
    for (const key of ["caption", "valueLabel", "noteLabel"]) {
      if (chart[key] !== undefined && typeof chart[key] !== "string") fail(`${key} must be a string`);
    }
    if (chart.format !== undefined && !CHART_FORMATS.includes(chart.format)) {
      fail(`format must be one of: ${CHART_FORMATS.join(", ")}`);
    }
    if (chart.signed !== undefined && typeof chart.signed !== "boolean") fail("signed must be true or false");
    if (chart.digits !== undefined && (!Number.isInteger(chart.digits) || chart.digits < 0 || chart.digits > 6)) {
      fail("digits must be a whole number from 0 to 6");
    }
    if (chart.currency !== undefined) {
      let valid = typeof chart.currency === "string" && /^[A-Z]{3}$/.test(chart.currency);
      if (valid) {
        try {
          new Intl.NumberFormat("en-US", { style: "currency", currency: chart.currency });
        } catch {
          valid = false;
        }
      }
      if (!valid) fail("currency must be an ISO 4217 code such as USD or EUR");
    }

    if (!Array.isArray(chart.rows) || !chart.rows.length) {
      fail("requires rows (a non-empty array)");
      return;
    }
    const rowFail = (rowIndex, message) => fail(`rows[${rowIndex}] ${message}`);
    const finite = (row, rowIndex, key, required = true) => {
      if (row[key] === undefined && !required) return true;
      if (!isNumber(row[key])) {
        rowFail(rowIndex, `${key} must be a finite number${Number.isFinite(row[key]) ? ` within ±${MAX_VALUE}` : ""}`);
        return false;
      }
      return true;
    };

    let seriesCount = 0;
    if (chart.type === "compare") {
      if (!Array.isArray(chart.series) || chart.series.length < 1 || chart.series.length > 4) {
        fail("compare requires series: 1 to 4 names (strings or {label, slot})");
      } else {
        seriesCount = chart.series.length;
        chart.series.forEach((entry, seriesIndex) => {
          const label = isObject(entry) ? entry.label : entry;
          if (typeof label !== "string" || !isFilled(label)) fail(`series[${seriesIndex}] requires a label`);
          if (isObject(entry) && entry.slot !== undefined && !isSlot(entry.slot)) {
            fail(`series[${seriesIndex}].slot must be a whole number from 1 to ${SERIES_SLOTS}`);
          }
        });
      }
    }

    let stackTotal = 0;
    chart.rows.forEach((row, rowIndex) => {
      if (!isObject(row)) {
        rowFail(rowIndex, "must be an object");
        return;
      }
      if (typeof row.label !== "string" || !isFilled(row.label)) rowFail(rowIndex, "requires label");
      if (chart.type === "stack") {
        if (finite(row, rowIndex, "value")) {
          if (row.value < 0) rowFail(rowIndex, "value must not be negative in a stack");
          else stackTotal += row.value;
        }
        if (row.slot !== undefined && !isSlot(row.slot)) {
          rowFail(rowIndex, `slot must be a whole number from 1 to ${SERIES_SLOTS}`);
        }
      } else if (chart.type === "waterfall") {
        const kind = row.kind ?? "step";
        if (!WATERFALL_KINDS.includes(kind)) {
          rowFail(rowIndex, `kind must be one of: ${WATERFALL_KINDS.join(", ")}`);
        } else if (kind === "subtotal" || kind === "total") {
          if (row.value !== undefined) rowFail(rowIndex, `is a ${kind}: its value is computed from the rows above, so omit value`);
        } else {
          finite(row, rowIndex, "value");
          if (kind === "start" && rowIndex !== 0) rowFail(rowIndex, "kind start is only allowed on the first row");
        }
        if (row.tone !== undefined && (row.tone !== "part" || kind !== "step")) {
          rowFail(rowIndex, 'tone must be "part", and only on a step');
        }
      } else if (chart.type === "diverge") {
        finite(row, rowIndex, "value");
        finite(row, rowIndex, "pct", false);
        if (row.note !== undefined && typeof row.note !== "string") rowFail(rowIndex, "note must be a string");
      } else if (chart.type === "compare") {
        if (!Array.isArray(row.values)) {
          rowFail(rowIndex, "requires values (one number per series)");
        } else {
          if (seriesCount && row.values.length !== seriesCount) {
            rowFail(rowIndex, `values has ${row.values.length} numbers for ${seriesCount} series`);
          }
          row.values.forEach((value, valueIndex) => {
            if (!isNumber(value)) rowFail(rowIndex, `values[${valueIndex}] must be a finite number${Number.isFinite(value) ? ` within ±${MAX_VALUE}` : ""}`);
          });
        }
      }
    });
    if (chart.type === "stack" && !(stackTotal > 0)) fail("stack needs at least one positive value");
  });
  return errors;
}

// Sums and spans of in-range values stay finite and exact enough to format.
const MAX_VALUE = 1e15;
const isNumber = (value) => Number.isFinite(value) && Math.abs(value) <= MAX_VALUE;

const isSlot = (slot) => Number.isInteger(slot) && slot >= 1 && slot <= SERIES_SLOTS;

// The renderer refuses invalid charts outright instead of drawing NaN. The
// build fails loudly; the validator reports the same errors one per line.
export function assertValidCharts(data) {
  const errors = validateCharts(data);
  if (errors.length) throw new Error(`Invalid charts:\n- ${errors.join("\n- ")}`);
}

export function chartsForSection(data, index) {
  return (Array.isArray(data.charts) ? data.charts : []).filter((chart) => chart.section === index);
}

// ---- number formatting --------------------------------------------------------

// Locale is pinned to en-US so the build is byte-stable across machines.
// Values are formatted from their absolute value and the sign is added here,
// using a true minus sign; a value that rounds to zero carries no sign.
export function formatValue(value, chart = {}, { signed = false, format, digits } = {}) {
  const kind = format ?? chart.format ?? "number";
  const abs = Math.abs(value);
  let places = digits ?? chart.digits;
  let body;
  if (kind === "currency") {
    places ??= abs < 10 && !Number.isInteger(abs) ? 2 : 0;
    body = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: chart.currency || "USD",
      minimumFractionDigits: places,
      maximumFractionDigits: places,
    }).format(abs);
  } else if (kind === "percent") {
    places ??= 1;
    body = `${new Intl.NumberFormat("en-US", { minimumFractionDigits: places, maximumFractionDigits: places }).format(abs)}%`;
  } else {
    body = new Intl.NumberFormat(
      "en-US",
      places === undefined ? { maximumFractionDigits: 2 } : { minimumFractionDigits: places, maximumFractionDigits: places },
    ).format(abs);
  }
  if (!/[1-9]/.test(body)) return body;
  if (value < 0) return `−${body}`;
  return signed && value > 0 ? `+${body}` : body;
}

const percentOf = (value) => formatValue(value, {}, { format: "percent", digits: 1 });
const signedPercent = (value) => formatValue(value, {}, { format: "percent", digits: 1, signed: true });

// ---- shared chart model --------------------------------------------------------

function seriesOf(chart) {
  return (chart.series || []).map((entry, index) => ({
    label: isObject(entry) ? entry.label : entry,
    slot: (isObject(entry) && entry.slot) || (index % SERIES_SLOTS) + 1,
  }));
}

const stackSlot = (row, index) => row.slot || (index % SERIES_SLOTS) + 1;

function waterfallBars(chart) {
  let run = 0;
  return chart.rows.map((row) => {
    const kind = row.kind ?? "step";
    if (kind === "step") {
      const previous = run;
      run += row.value;
      const tone = row.tone === "part" ? "viz-part" : row.value >= 0 ? "viz-up" : "viz-down";
      return { row, step: true, value: row.value, lo: Math.min(previous, run), hi: Math.max(previous, run), end: run, cls: tone };
    }
    if (kind === "start") run = row.value;
    return { row, step: false, value: run, lo: Math.min(0, run), hi: Math.max(0, run), end: run, cls: "viz-total" };
  });
}

const waterfallValue = (bar, chart) => formatValue(bar.value, chart, { signed: bar.step });

function divergeTitle(row, chart) {
  const pct = Number.isFinite(row.pct) ? ` (${signedPercent(row.pct)})` : "";
  const note = isFilled(row.note) ? ` · ${isFilled(chart.noteLabel) ? `${chart.noteLabel}: ` : ""}${row.note}` : "";
  return `${row.label}: ${formatValue(row.value, chart, { signed: true })}${pct}${note}`;
}

// One table model feeds both the HTML fallback and the Markdown twin, so the
// two can never disagree about a number.
export function chartTable(chart) {
  const valueLabel = isFilled(chart.valueLabel) ? chart.valueLabel : "Value";
  if (chart.type === "stack") {
    const total = chart.rows.reduce((sum, row) => sum + row.value, 0);
    return {
      head: ["", valueLabel, "Share"],
      rows: [
        ...chart.rows.map((row) => [row.label, formatValue(row.value, chart), percentOf((row.value / total) * 100)]),
        ["Total", formatValue(total, chart), percentOf(100)],
      ],
    };
  }
  if (chart.type === "waterfall") {
    return {
      head: ["", valueLabel],
      rows: waterfallBars(chart).map((bar) => [bar.row.label, waterfallValue(bar, chart)]),
    };
  }
  if (chart.type === "diverge") {
    const hasPct = chart.rows.some((row) => Number.isFinite(row.pct));
    const hasNote = chart.rows.some((row) => isFilled(row.note));
    return {
      head: ["", valueLabel, ...(hasPct ? ["%"] : []), ...(hasNote ? [isFilled(chart.noteLabel) ? chart.noteLabel : "Note"] : [])],
      rows: chart.rows.map((row) => [
        row.label,
        formatValue(row.value, chart, { signed: true }),
        ...(hasPct ? [Number.isFinite(row.pct) ? signedPercent(row.pct) : ""] : []),
        ...(hasNote ? [row.note ?? ""] : []),
      ]),
    };
  }
  return {
    head: ["", ...seriesOf(chart).map((series) => series.label)],
    rows: chart.rows.map((row) => [row.label, ...row.values.map((value) => formatValue(value, chart, { signed: chart.signed }))]),
  };
}

// Every mark of one row (bar, value and label, in each width variant) sits in
// one group carrying the row's anchor, so a tap anywhere on the row comments on
// it. The legend entry and the table row carry the same anchor.
// A transparent hit area spans the whole row, so a tap between the label and
// a short bar still lands on the row.
const group = (rowAnchor, body, [x, y, width, height]) =>
  `<g data-anchor="${esc(rowAnchor)}"><rect class="viz-hit" fill="transparent" x="${num(x)}" y="${num(y)}" width="${num(width)}" height="${num(height)}"/>${body}</g>`;

// ---- SVG primitives ----------------------------------------------------------

const LABEL = 13; // px, sans
const VALUE = 12.5; // px, mono
// Width kinds: sans multipliers on the per-character estimate, or MONO.
const SANS = 1;
const SANS_BOLD = 1.07;
const MONO = 0;

// Advance widths in em by character class, calibrated against the system sans
// stack (measured average 0.54em regular, 0.59em semibold) but sized for the
// wide glyphs: an all-caps ticker runs ~0.7em per character.
function charEm(char) {
  if (/[iljtfr.,:;'!|()[\] ]/.test(char)) return 0.32;
  if (/[MWmw@%]/.test(char)) return 0.86;
  if (/[A-Z&]/.test(char)) return 0.7;
  if (/[0-9$#?]/.test(char)) return 0.6;
  return 0.55;
}

const charWidth = (char, size, kind) => (kind === MONO ? 0.61 : charEm(char) * kind) * size;

const textWidth = (value, size, kind) =>
  [...String(value)].reduce((sum, char) => sum + charWidth(char, size, kind), 0);

function fitText(value, maxWidth, size, kind) {
  const chars = [...String(value)];
  if (textWidth(value, size, kind) <= maxWidth) return chars.join("");
  const budget = maxWidth - charWidth("…", size, kind);
  let width = 0;
  let keep = 0;
  while (keep < chars.length - 1 && width + charWidth(chars[keep], size, kind) <= budget) {
    width += charWidth(chars[keep], size, kind);
    keep += 1;
  }
  return `${chars.slice(0, Math.max(1, keep)).join("").trimEnd()}…`;
}

// Coordinates are rounded to 0.1px: smaller markup and a byte-stable build.
const num = (value) => {
  const rounded = Math.round(value * 10) / 10;
  return String(Object.is(rounded, -0) ? 0 : rounded);
};

function text(x, y, content, cls, anchor = "start") {
  const anchorAttr = anchor === "start" ? "" : ` text-anchor="${anchor}"`;
  return `<text x="${num(x)}" y="${num(y)}"${anchorAttr} class="${cls}">${esc(content)}</text>`;
}

function rect(x, y, width, height, cls, title) {
  return `<rect x="${num(x)}" y="${num(y)}" width="${num(width)}" height="${num(height)}" rx="4" class="viz-mark ${cls}"><title>${esc(title)}</title></rect>`;
}

const line = (x1, y1, x2, y2, cls) =>
  `<line x1="${num(x1)}" y1="${num(y1)}" x2="${num(x2)}" y2="${num(y2)}" class="${cls}"/>`;

function svg(width, height, labelledBy, body) {
  return `<svg class="viz-svg viz-w${width}" viewBox="0 0 ${width} ${num(height)}" width="${width}" height="${num(height)}" role="img" aria-labelledby="${labelledBy}">${body}</svg>`;
}

// Maps [min, max] (always spanning zero) onto [start, start + length].
function scale(values, start, length) {
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const span = max - min || 1;
  return { min, max, at: (value) => start + ((value - min) / span) * length };
}

// ---- chart types --------------------------------------------------------------

// Text-free, so it is drawn once in percentages and stretches to any width.
function stackPlot(chart, labelledBy, anchors) {
  const total = chart.rows.reduce((sum, row) => sum + row.value, 0);
  let offset = 0;
  const marks = chart.rows
    .map((row, index) => {
      const share = (row.value / total) * 100;
      const x = offset;
      offset += share;
      if (share < 0.1) return "";
      const pct = (value) => `${Math.round(value * 100) / 100}%`;
      return `<rect x="${pct(x)}" y="0" width="${pct(share)}" height="44" rx="5" data-anchor="${esc(anchors[index])}" class="viz-mark viz-s${stackSlot(row, index)}"><title>${esc(`${row.label}: ${formatValue(row.value, chart)} (${percentOf(share)})`)}</title></rect>`;
    })
    .join("");
  return `<svg class="viz-fluid" width="100%" height="44" role="img" aria-labelledby="${labelledBy}">${marks}</svg>`;
}

function stackLegend(chart, anchors) {
  const total = chart.rows.reduce((sum, row) => sum + row.value, 0);
  const items = chart.rows.map(
    (row, index) => `<li data-anchor="${esc(anchors[index])}"><span class="viz-swatch viz-s${stackSlot(row, index)}"></span><span class="viz-legend-label">${esc(row.label)}</span><span class="viz-num">${esc(formatValue(row.value, chart))}</span><span class="viz-num viz-quiet">${esc(percentOf((row.value / total) * 100))}</span></li>`,
  );
  return `\n              <ul class="viz-legend">${items.join("")}</ul>`;
}

function compareLegend(chart) {
  const items = seriesOf(chart).map(
    (series) => `<li><span class="viz-swatch viz-s${series.slot}"></span><span class="viz-legend-label">${esc(series.label)}</span></li>`,
  );
  return `\n              <ul class="viz-legend viz-legend-inline">${items.join("")}</ul>`;
}

// Column labels, split over at most two lines at the word break that balances
// them best. Returns null when the label cannot fit even then.
function wrapLabel(label, maxWidth, factor) {
  if (textWidth(label, LABEL, factor) <= maxWidth) return [label];
  const words = label.split(/\s+/);
  let best = null;
  for (let i = 1; i < words.length; i += 1) {
    const lines = [words.slice(0, i).join(" "), words.slice(i).join(" ")];
    const widest = Math.max(...lines.map((part) => textWidth(part, LABEL, factor)));
    if (!best || widest < best.widest) best = { lines, widest };
  }
  return best && best.widest <= maxWidth ? best.lines : null;
}

function waterfallPlot(chart, width, labelledBy, anchors) {
  const bars = waterfallBars(chart);
  const slot = width / bars.length;
  const values = bars.map((bar) => waterfallValue(bar, chart));
  const labels = bars.map((bar) => wrapLabel(bar.row.label, slot - 8, bar.step ? SANS : SANS_BOLD));
  const columnsFit =
    slot >= 76 &&
    labels.every(Boolean) &&
    values.every((value) => textWidth(value, VALUE, MONO) <= slot - 4);
  return columnsFit
    ? waterfallColumns(bars, values, labels, width, labelledBy, anchors)
    : waterfallRows(bars, values, width, labelledBy, anchors);
}

function waterfallColumns(bars, values, labels, width, labelledBy, anchors) {
  const slot = width / bars.length;
  const barWidth = Math.min(64, slot * 0.6);
  const below = bars.some((bar) => bar.hi <= 0 && bar.lo < 0);
  const twoLines = labels.some((lines) => lines.length > 1);
  const top = 28;
  const plotHeight = 220;
  const labelTop = top + plotHeight + (below ? 22 : 0);
  const height = labelTop + (twoLines ? 44 : 28);
  const y = scale(bars.flatMap((bar) => [bar.lo, bar.hi]), 0, plotHeight);
  const at = (value) => top + plotHeight - (y.at(value) - 0);
  let body = line(0, at(0), width, at(0), "viz-axis");
  bars.forEach((bar, index) => {
    const center = slot * index + slot / 2;
    const x0 = center - barWidth / 2;
    if (index < bars.length - 1) {
      body += line(x0 + barWidth, at(bar.end), slot * (index + 1) + slot / 2 - barWidth / 2, at(bar.end), "viz-connector");
    }
    const barHeight = Math.max(at(bar.lo) - at(bar.hi), 1.5);
    let row = rect(x0, at(bar.hi), barWidth, barHeight, bar.cls, `${bar.row.label}: ${values[index]}`);
    const underneath = bar.hi <= 0 && bar.lo < 0;
    row += text(center, underneath ? at(bar.lo) + 17 : at(bar.hi) - 8, values[index], "viz-value", "middle");
    labels[index].forEach((part, lineIndex) => {
      row += text(center, labelTop + 20 + lineIndex * 17, part, bar.step ? "viz-label" : "viz-label viz-strong", "middle");
    });
    body += group(anchors[index], row, [slot * index, 0, slot, height]);
  });
  return svg(width, height, labelledBy, body);
}

// Narrow screens: the same bridge laid out as rows, bars floating on one axis.
function waterfallRows(bars, values, width, labelledBy, anchors) {
  const rowHeight = 32;
  const height = bars.length * rowHeight + 6;
  const valueWidth = Math.max(...values.map((value) => textWidth(value, VALUE, MONO))) + 12;
  const { labelWidth, left, plot } = fitColumns(
    width,
    columnWidth(bars.map((bar) => [bar.row.label, bar.step ? SANS : SANS_BOLD]), 56, width * 0.4),
    0,
    valueWidth,
  );
  const x = scale(bars.flatMap((bar) => [bar.lo, bar.hi]), left, plot);
  let body = line(x.at(0), 0, x.at(0), height, "viz-axis");
  bars.forEach((bar, index) => {
    const middle = 4 + index * rowHeight + rowHeight / 2;
    if (index < bars.length - 1) {
      body += line(x.at(bar.end), middle + 9, x.at(bar.end), middle + rowHeight - 9, "viz-connector");
    }
    const factor = bar.step ? SANS : SANS_BOLD;
    body += group(
      anchors[index],
      text(0, middle + 4, fitText(bar.row.label, labelWidth - 10, LABEL, factor), bar.step ? "viz-label" : "viz-label viz-strong") +
        rect(x.at(bar.lo), middle - 9, Math.max(x.at(bar.hi) - x.at(bar.lo), 1.5), 18, bar.cls, `${bar.row.label}: ${values[index]}`) +
        text(width, middle + 4, values[index], "viz-value", "end"),
      [0, middle - rowHeight / 2, width, rowHeight],
    );
  });
  return svg(width, height, labelledBy, body);
}

// Splits a row between label column, value pads and plot. The plot keeps at
// least 35% of the width; the label column gives way first (its labels are
// then truncated), and only extreme values let a value label overhang.
function fitColumns(width, labelWidth, leftPad, rightPad) {
  const minPlot = width * 0.35;
  const shortfall = labelWidth + leftPad + rightPad + minPlot - width;
  const label = shortfall > 0 ? Math.max(Math.min(labelWidth, 36), labelWidth - shortfall) : labelWidth;
  const left = label + leftPad;
  return { labelWidth: label, left, plot: Math.max(minPlot, width - left - rightPad) };
}

// Width of a label column: the widest label plus padding, within [min, max].
function columnWidth(labels, min, max) {
  const widest = Math.max(...labels.map(([label, factor]) => textWidth(label, LABEL, factor)));
  return Math.round(Math.min(max, Math.max(min, widest + 12)));
}

function divergePlot(chart, width, labelledBy, anchors) {
  const rows = chart.rows;
  const withPct = width >= 560 && rows.some((row) => Number.isFinite(row.pct));
  const values = rows.map((row) => {
    const value = formatValue(row.value, chart, { signed: true });
    return withPct && Number.isFinite(row.pct) ? `${value}  ${signedPercent(row.pct)}` : value;
  });
  const rowHeight = 34;
  const height = rows.length * rowHeight + 8;
  const valueWidth = Math.max(...values.map((value) => textWidth(value, VALUE, MONO))) + 10;
  const hasNegative = rows.some((row) => row.value < 0);
  const hasPositive = rows.some((row) => row.value > 0);
  const { labelWidth, left, plot } = fitColumns(
    width,
    columnWidth(rows.map((row) => [row.label, SANS_BOLD]), 40, width * 0.3),
    hasNegative ? valueWidth : 0,
    hasPositive ? valueWidth : 0,
  );
  const x = scale(rows.map((row) => row.value), left, plot);
  const zero = x.at(0);
  let body = line(zero, 0, zero, height, "viz-axis");
  rows.forEach((row, index) => {
    const middle = 4 + index * rowHeight + rowHeight / 2;
    const barWidth = Math.max(Math.abs(x.at(row.value) - zero), 1.5);
    const positive = row.value >= 0;
    body += group(
      anchors[index],
      text(0, middle + 5, fitText(row.label, labelWidth - 10, LABEL, SANS_BOLD), "viz-label viz-strong") +
        rect(positive ? zero : zero - barWidth, middle - 10, barWidth, 20, positive ? "viz-up" : "viz-down", divergeTitle(row, chart)) +
        text(positive ? zero + barWidth + 8 : zero - barWidth - 8, middle + 5, values[index], "viz-value", positive ? "start" : "end"),
      [0, middle - rowHeight / 2, width, rowHeight],
    );
  });
  return svg(width, height, labelledBy, body);
}

// Grouped horizontal bars. Labels sit in a left column when they fit in 40% of
// the width, otherwise on their own line above each group.
function comparePlot(chart, width, labelledBy, anchors) {
  const series = seriesOf(chart);
  const rows = chart.rows;
  const values = rows.map((row) => row.values.map((value) => formatValue(value, chart, { signed: chart.signed })));
  const widest = Math.max(...rows.map((row) => textWidth(row.label, LABEL, SANS_BOLD)));
  const labelsLeft = widest + 14 <= width * 0.4;
  const labelColumn = labelsLeft ? Math.round(widest + 14) : 0;
  const labelHeight = labelsLeft ? 0 : 22;
  const barHeight = 20;
  const barGap = 6;
  const groupHeight = labelHeight + series.length * barHeight + (series.length - 1) * barGap + 22;
  const height = rows.length * groupHeight - 14; // no gap after the last group
  const valueWidth = Math.max(...values.flat().map((value) => textWidth(value, VALUE, MONO))) + 10;
  const all = rows.flatMap((row) => row.values);
  const hasNegative = all.some((value) => value < 0);
  const hasPositive = all.some((value) => value > 0);
  const { labelWidth, left, plot } = fitColumns(width, labelColumn, hasNegative ? valueWidth : 0, hasPositive ? valueWidth : 0);
  const x = scale(all, left, plot);
  const zero = x.at(0);
  let body = line(zero, 0, zero, height, "viz-axis");
  rows.forEach((row, rowIndex) => {
    const top = 4 + rowIndex * groupHeight;
    const barsTop = top + labelHeight;
    const barsHeight = series.length * barHeight + (series.length - 1) * barGap;
    let marks = labelsLeft
      ? text(0, barsTop + barsHeight / 2 + 5, fitText(row.label, labelWidth - 10, LABEL, SANS_BOLD), "viz-label viz-strong")
      : text(0, top + 13, fitText(row.label, width, LABEL, SANS_BOLD), "viz-label viz-strong");
    series.forEach((entry, seriesIndex) => {
      const value = row.values[seriesIndex];
      const y = barsTop + seriesIndex * (barHeight + barGap);
      const barWidth = Math.max(Math.abs(x.at(value) - zero), 1.5);
      const positive = value >= 0;
      marks += rect(positive ? zero : zero - barWidth, y, barWidth, barHeight, `viz-s${entry.slot}`, `${entry.label}, ${row.label}: ${values[rowIndex][seriesIndex]}`);
      marks += text(positive ? zero + barWidth + 8 : zero - barWidth - 8, y + 15, values[rowIndex][seriesIndex], seriesIndex === 0 ? "viz-value viz-strong" : "viz-value", positive ? "start" : "end");
    });
    body += group(anchors[rowIndex], marks, [0, top, width, Math.min(groupHeight, height - top)]);
  });
  return svg(width, height, labelledBy, body);
}

const PLOTS = { waterfall: waterfallPlot, diverge: divergePlot, compare: comparePlot };

// ---- figure and Markdown -----------------------------------------------------

function renderTable(chart, anchors) {
  const { head, rows } = chartTable(chart);
  const headCells = head.map((cell) => `<th scope="col">${esc(cell)}</th>`).join("");
  // Rows beyond the data rows are computed (a stack's total).
  const rowAnchor = (index) => anchors[index] ?? `${chartAnchor(chart)}/total`;
  const bodyRows = rows
    .map(([label, ...cells], index) => `<tr data-anchor="${esc(rowAnchor(index))}" data-fp="${fingerprint(label, ...cells)}"><th scope="row">${esc(label)}</th>${cells.map((cell) => `<td>${esc(cell)}</td>`).join("")}</tr>`)
    .join("");
  return `<details class="viz-table"><summary>Show as table</summary><table><thead><tr>${headCells}</tr></thead><tbody>${bodyRows}</tbody></table></details>`;
}

export function renderChart(chart) {
  // Figure ids are always "chart-<id>"; captions use their own prefix so no
  // chart id can produce another chart's caption id.
  const titleId = `viz-title-${chart.id}`;
  const anchors = chartRowKeys(chart).map((key) => chartRowAnchor(chart, key));
  const plot =
    chart.type === "stack"
      ? stackPlot(chart, titleId, anchors)
      : CHART_WIDTHS.map((width) => PLOTS[chart.type](chart, width, titleId, anchors)).join("\n                ");
  const legend = chart.type === "stack" ? stackLegend(chart, anchors) : chart.type === "compare" ? compareLegend(chart) : "";
  const caption = isFilled(chart.caption) ? `\n              <p class="viz-caption">${esc(chart.caption)}</p>` : "";
  return `<figure class="viz viz-${chart.type}" id="chart-${esc(chart.id)}" data-anchor="${esc(chartAnchor(chart))}" data-fp="${fingerprint(chart.title, chart.caption)}">
              <figcaption class="viz-title" id="${esc(titleId)}">${esc(chart.title)}</figcaption>
              <div class="viz-plot">
                ${plot}
              </div>${legend}${caption}
              ${renderTable(chart, anchors)}
            </figure>`;
}

const markdownCell = (value) => String(value ?? "").replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\s*\r?\n\s*/g, " ");

export function renderChartMarkdown(chart) {
  const { head, rows } = chartTable(chart);
  const lines = [`**Chart:** ${chart.title}`];
  if (isFilled(chart.caption)) lines.push("", chart.caption);
  lines.push(
    "",
    `| ${head.map(markdownCell).join(" | ")} |`,
    `| ${head.map((_, index) => (index === 0 ? "---" : "---:")).join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(markdownCell).join(" | ")} |`),
  );
  return lines;
}
