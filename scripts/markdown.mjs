// A small, dependency-free Markdown → HTML renderer for notes.
//
// Notes are written by agents, so the source is untrusted input: every byte of
// text is HTML-escaped (there is no raw-HTML passthrough at all), and links
// survive only for http(s), mailto, same-document fragments, and relative
// paths. The supported subset is what agents actually write in short notes —
// headings, paragraphs, emphasis, code, lists with one nesting level, links,
// blockquotes, rules, and pipe tables. Anything else renders as plain text,
// which is always safe and still readable.

import { esc } from "./render.mjs";

const SAFE_SCHEMES = new Set(["http:", "https:", "mailto:"]);

// Classifies a link target. Returns null for anything that must not become an
// href. Relative targets are returned unresolved; the caller decides what they
// mean (they are relative to the note's .md file, see notes.mjs).
export function classifyHref(raw) {
  const url = String(raw ?? "").trim();
  // Control characters and spaces can smuggle a scheme past naive checks
  // ("java\tscript:"); a legitimate link in a note never needs them.
  if (!url || /[\u0000- \u007f]/.test(url)) return null;
  if (url.startsWith("#")) return { type: "fragment", href: url };
  // Browsers treat "\" as "/" in http(s) URLs, so "/\evil.example" is a
  // scheme-relative link to another host. Scheme-relative links are refused
  // too: a note links out with an explicit https://.
  if (url.includes("\\") || url.startsWith("//")) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) {
    let protocol;
    try {
      protocol = new URL(url).protocol;
    } catch {
      return null;
    }
    if (!SAFE_SCHEMES.has(protocol)) return null;
    return { type: protocol === "mailto:" ? "mailto" : "external", href: url };
  }
  return { type: "relative", href: url };
}

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const QUOTE = /^ {0,3}>/;
const LIST_ITEM = /^( *)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*)|[ \t]*)$/;
// [label](target) and ![alt](target), shared by the renderer and the raw
// Markdown sanitizer so both agree on what counts as a link.
const INLINE_LINK =
  /(!?)(?<!\\)\[((?:[^[\]\\]|\\.)*)\]\([ \t]*(<[^<>\n]*>|[^\s()<>]*(?:\([^\s()<>]*\)[^\s()<>]*)*)(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'))?[ \t]*\)/;
const TABLE_SEPARATOR = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

const isBlank = (line) => /^[ \t]*$/.test(line);
const indentOf = (line) => line.match(/^ */)[0].length;
const isOrdered = (marker) => /\d/.test(marker);

function listItem(line) {
  if (HR.test(line)) return null;
  const match = LIST_ITEM.exec(line);
  if (!match) return null;
  return { indent: match[1].length, marker: match[2], text: match[3] ?? "", ordered: isOrdered(match[2]) };
}

function fenceOpen(line) {
  const match = FENCE.exec(line);
  if (!match) return null;
  // A backtick fence's info string cannot contain backticks (that would be an
  // inline code span instead).
  if (match[2][0] === "`" && match[3].includes("`")) return null;
  return { indent: match[1].length, char: match[2][0], length: match[2].length };
}

function startsBlock(line) {
  return HEADING.test(line) || HR.test(line) || QUOTE.test(line) || fenceOpen(line) !== null || listItem(line) !== null;
}

function isTableStart(block, i) {
  return (
    block[i].includes("|") &&
    i + 1 < block.length &&
    block[i + 1].includes("|") &&
    TABLE_SEPARATOR.test(block[i + 1]) &&
    splitRow(block[i]).length === splitRow(block[i + 1]).length
  );
}

function splitRow(line) {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
  return row.split(/(?<!\\)\|/).map((cell) => cell.trim().replaceAll("\\|", "|"));
}

function slugify(text) {
  return (
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .trim()
      .replace(/\s+/g, "-") || "section"
  );
}

// Renders Markdown to an HTML fragment.
//
// options.resolveRelative(href) → string | null maps a relative link target
//   to the href the page should use (null drops the link, keeping its text).
//   Without it relative links are kept as written.
// options.headingBase is the level the body's shallowest heading renders at,
//   so a note body starting at "##" nests correctly under the page's own <h1>
//   (or under a hub's section heading) without skipping levels.
//
// Returns { html, warnings }; warnings name links that were dropped.
export function renderMarkdownHtml(source, options = {}) {
  const { resolveRelative = (href) => href, headingBase = 2 } = options;
  const warnings = [];
  const usedIds = new Map();

  // Strip control characters the inline pass uses as private sentinels
  // (\u0000 placeholder delimiters, \u0001 hard breaks); they carry no meaning
  // in a note.
  const lines = String(source ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f]/g, "")
    .split("\n")
    .map((line) => line.replace(/^\t+/, (tabs) => "    ".repeat(tabs.length)));

  let minHeading = 6;
  let inFence = null;
  for (const line of lines) {
    const fence = fenceOpen(line);
    if (inFence) {
      if (fence && fence.char === inFence.char && fence.length >= inFence.length && isBlank(line.slice(fence.indent + fence.length))) inFence = null;
      continue;
    }
    if (fence) {
      inFence = fence;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) minHeading = Math.min(minHeading, heading[1].length);
  }
  const headingShift = headingBase - minHeading;

  function link(raw, label) {
    const target = classifyHref(raw);
    if (!target) {
      warnings.push(`dropped link with a disallowed target: ${String(raw).slice(0, 80)}`);
      return label;
    }
    let href = target.href;
    if (target.type === "relative") {
      href = resolveRelative(target.href);
      if (!href) {
        warnings.push(`link to ${target.href} does not resolve to anything on this site — rendered as plain text`);
        return label;
      }
    }
    const attrs = target.type === "external" ? ' target="_blank" rel="noreferrer noopener"' : "";
    return `<a href="${esc(href)}"${attrs}>${label}</a>`;
  }

  function inline(text) {
    const slots = [];
    const stash = (html) => `\u0000${slots.push(html) - 1}\u0000`;

    function pass(value, allowLinks) {
      let s = value;
      // Code spans first: nothing inside backticks is Markdown.
      s = s.replace(/(?<!`)(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_, _ticks, code) => {
        const trimmed = /^ .* $/s.test(code) && code.trim() ? code.slice(1, -1) : code;
        return stash(`<code>${esc(trimmed.replace(/\n/g, " "))}</code>`);
      });
      if (allowLinks) {
        // [label](target) and ![alt](target). Images render as plain links:
        // a note page loads no subresources.
        s = s.replace(
          new RegExp(INLINE_LINK.source, "g"),
          (_, _bang, label, target) => {
            const href = target.startsWith("<") ? target.slice(1, -1) : target;
            const labelHtml = pass(label, false);
            return stash(link(href, labelHtml || esc(href)));
          },
        );
        s = s.replace(/<((?:https?:\/\/|mailto:)[^\s<>]+)>/gi, (_, url) => stash(link(url, esc(url))));
        s = s.replace(/\bhttps?:\/\/[^\s<>"'`\u0000]+/gi, (match) => {
          let url = match;
          let trailing = "";
          // Trailing sentence punctuation is almost never part of the URL; a
          // closing paren is kept only when the URL opened one.
          while (/[.,;:!?*_)\]]$/.test(url)) {
            if (url.endsWith(")") && (url.match(/\(/g) || []).length >= (url.match(/\)/g) || []).length) break;
            trailing = url.slice(-1) + trailing;
            url = url.slice(0, -1);
          }
          return stash(link(url, esc(url))) + trailing;
        });
      }
      s = s.replace(/\\([\\`*_{}[\]()#+\-.!|<>~])/g, (_, char) => stash(esc(char)));
      s = esc(s);
      s = s.replace(/\*\*(?=[^\s*])([\s\S]*?[^\s*])\*\*/g, "<strong>$1</strong>");
      s = s.replace(/(?<![\p{L}\p{N}_])__(?=[^\s_])([\s\S]*?[^\s_])__(?![\p{L}\p{N}_])/gu, "<strong>$1</strong>");
      s = s.replace(/(?<!\*)\*(?=[^\s*])([\s\S]*?[^\s*])\*(?!\*)/g, "<em>$1</em>");
      s = s.replace(/(?<![\p{L}\p{N}_])_(?=[^\s_])([\s\S]*?[^\s_])_(?![\p{L}\p{N}_])/gu, "<em>$1</em>");
      s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>");
      return s;
    }

    let html = pass(text, true);
    // Stashed fragments can contain other placeholders (a link label holding
    // a code span), so restore until none are left.
    while (/\u0000\d+\u0000/.test(html)) {
      html = html.replace(/\u0000(\d+)\u0000/g, (_, index) => slots[Number(index)]);
    }
    return html.replace(/\u0001/g, "<br />");
  }

  // Joins paragraph lines, turning a trailing double space or backslash into
  // a hard break.
  function paragraphText(paragraphLines) {
    return paragraphLines
      .map((line, index) => {
        const trimmed = line.replace(/^[ \t]+/, "");
        if (index < paragraphLines.length - 1 && / {2,}$|\\$/.test(trimmed)) {
          return trimmed.replace(/ {2,}$|\\$/, "") + "\u0001";
        }
        return trimmed.replace(/[ \t]+$/, "");
      })
      .join("\n");
  }

  function renderFence(block, start, open) {
    const body = [];
    let i = start + 1;
    for (; i < block.length; i += 1) {
      const close = fenceOpen(block[i]);
      if (close && close.char === open.char && close.length >= open.length && isBlank(block[i].slice(close.indent + close.length))) {
        i += 1;
        break;
      }
      body.push(block[i].replace(new RegExp(`^ {0,${open.indent}}`), ""));
    }
    return { html: `<pre><code>${esc(body.join("\n"))}</code></pre>`, next: i };
  }

  function renderList(block, start) {
    const first = listItem(block[start]);
    const baseIndent = first.indent;
    const ordered = first.ordered;
    const items = [];
    let sawBlank = false;
    let i = start;

    const newItem = (item) => ({
      task: /^\[[ xX]\](?:[ \t]|$)/.test(item.text) ? /^\[[xX]\]/.test(item.text) : null,
      blocks: [{ type: "p", lines: [item.text.replace(/^\[[ xX]\][ \t]?/, "")] }],
    });

    while (i < block.length) {
      const line = block[i];
      if (isBlank(line)) {
        let j = i + 1;
        while (j < block.length && isBlank(block[j])) j += 1;
        if (j >= block.length) break;
        const next = listItem(block[j]);
        const continues =
          (next && next.indent <= baseIndent + 1 && next.ordered === ordered) ||
          (items.length && indentOf(block[j]) >= baseIndent + 2);
        if (!continues) break;
        sawBlank = true;
        i = j;
        continue;
      }
      const item = listItem(line);
      if (item && item.indent <= baseIndent + 1) {
        if (item.ordered !== ordered) break;
        items.push(newItem(item));
        sawBlank = false;
        i += 1;
        continue;
      }
      if (!items.length) break;
      const current = items.at(-1);
      const last = current.blocks.at(-1);
      if (item) {
        // Any deeper marker belongs to the one supported nesting level.
        if (last.type !== "list" || sawBlank) current.blocks.push({ type: "list", ordered: item.ordered, start: item.marker, items: [] });
        current.blocks.at(-1).items.push(newItem(item));
        sawBlank = false;
        i += 1;
        continue;
      }
      const indent = indentOf(line);
      if (indent < baseIndent + 2 && (sawBlank || startsBlock(line))) break;
      const fence = fenceOpen(line.slice(Math.min(indent, baseIndent + 2)));
      if (fence && indent >= baseIndent + 2) {
        const stripped = block.map((l) => l.replace(new RegExp(`^ {0,${indent}}`), ""));
        const { html, next } = renderFence(stripped, i, fenceOpen(stripped[i]));
        const target = last.type === "list" && !sawBlank ? last.items.at(-1) : current;
        target.blocks.push({ type: "html", html });
        sawBlank = false;
        i = next;
        continue;
      }
      if (last.type === "list" && !sawBlank) {
        const child = last.items.at(-1);
        const childLast = child.blocks.at(-1);
        if (childLast.type === "p") childLast.lines.push(line);
        else child.blocks.push({ type: "p", lines: [line] });
      } else if (last.type === "p" && !sawBlank) {
        last.lines.push(line);
      } else {
        current.blocks.push({ type: "p", lines: [line] });
      }
      sawBlank = false;
      i += 1;
    }
    return { html: listHtml(ordered, first.marker, items), next: i };
  }

  function listHtml(ordered, marker, items) {
    const tag = ordered ? "ol" : "ul";
    const startNumber = ordered ? parseInt(marker, 10) : 1;
    const startAttr = ordered && startNumber !== 1 ? ` start="${startNumber}"` : "";
    const body = items
      .map((item) => {
        const paragraphs = item.blocks.filter((b) => b.type === "p").length;
        const parts = item.blocks.map((b) => {
          if (b.type === "list") return listHtml(b.ordered, b.start, b.items);
          if (b.type === "html") return b.html;
          const text = inline(paragraphText(b.lines));
          return paragraphs > 1 ? `<p>${text}</p>` : text;
        });
        const box = item.task === null ? "" : `<input type="checkbox" disabled${item.task ? " checked" : ""} /> `;
        return `<li${item.task === null ? "" : ' class="task"'}>${box}${parts.join("\n")}</li>`;
      })
      .join("\n");
    return `<${tag}${startAttr}>\n${body}\n</${tag}>`;
  }

  function renderTable(block, start) {
    const header = splitRow(block[start]);
    const aligns = splitRow(block[start + 1]).map((cell) =>
      cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : cell.startsWith(":") ? "left" : "",
    );
    const cellHtml = (tag, cells) =>
      header
        .map((_, index) => {
          const align = aligns[index] ? ` class="align-${aligns[index]}"` : "";
          return `<${tag}${align}>${inline(cells[index] ?? "")}</${tag}>`;
        })
        .join("");
    const rows = [];
    let i = start + 2;
    while (i < block.length && !isBlank(block[i]) && !startsBlock(block[i])) {
      rows.push(`<tr>${cellHtml("td", splitRow(block[i]))}</tr>`);
      i += 1;
    }
    const tbody = rows.length ? `\n<tbody>\n${rows.join("\n")}\n</tbody>` : "";
    return {
      html: `<div class="table-wrap"><table>\n<thead><tr>${cellHtml("th", header)}</tr></thead>${tbody}\n</table></div>`,
      next: i,
    };
  }

  function renderBlocks(block, depth) {
    const out = [];
    let i = 0;
    while (i < block.length) {
      const line = block[i];
      if (isBlank(line)) {
        i += 1;
        continue;
      }
      const fence = fenceOpen(line);
      if (fence) {
        const { html, next } = renderFence(block, i, fence);
        out.push(html);
        i = next;
        continue;
      }
      const heading = HEADING.exec(line);
      if (heading) {
        const level = Math.min(6, Math.max(1, heading[1].length + headingShift));
        const content = inline(heading[2]);
        // GitHub-style ids from the heading's source text, so "#some-heading"
        // fragments written against the .md keep working on the page.
        const base = slugify(heading[2].replace(/\]\([^)]*\)/g, ""));
        const seen = usedIds.get(base) ?? 0;
        usedIds.set(base, seen + 1);
        const id = seen ? `${base}-${seen}` : base;
        out.push(`<h${level} id="${esc(id)}">${content}</h${level}>`);
        i += 1;
        continue;
      }
      if (HR.test(line)) {
        out.push("<hr />");
        i += 1;
        continue;
      }
      if (isTableStart(block, i)) {
        const { html, next } = renderTable(block, i);
        out.push(html);
        i = next;
        continue;
      }
      if (QUOTE.test(line)) {
        const quoted = [];
        while (i < block.length && QUOTE.test(block[i])) {
          quoted.push(block[i].replace(/^ {0,3}> ?/, ""));
          i += 1;
        }
        // Nesting is bounded by the input anyway; the cap just keeps a
        // pathological ">>>>>>…" line from recursing deeply.
        out.push(depth < 8 ? `<blockquote>\n${renderBlocks(quoted, depth + 1)}\n</blockquote>` : `<p>${inline(quoted.join("\n"))}</p>`);
        continue;
      }
      if (listItem(line)) {
        const { html, next } = renderList(block, i);
        out.push(html);
        i = next;
        continue;
      }
      const paragraph = [line];
      i += 1;
      while (i < block.length && !isBlank(block[i]) && !startsBlock(block[i]) && !isTableStart(block, i)) {
        paragraph.push(block[i]);
        i += 1;
      }
      out.push(`<p>${inline(paragraphText(paragraph))}</p>`);
    }
    return out.join("\n");
  }

  return { html: renderBlocks(lines, 0), warnings: [...new Set(warnings)] };
}

// Reduces every link whose target this site would not render — a disallowed
// scheme, or a relative target that resolveRelative() rejects — to its text,
// in the Markdown source itself. The raw .md ships next to the rendered page,
// so without this a shared note linking to private material would still carry
// the private path. Reference definitions ("[ref]: target") with such targets
// are removed. Fenced code is left alone (it is shown verbatim on the page
// too); everything else is treated as potential link syntax, erring toward
// sanitizing. Returns the source unchanged when nothing is dropped.
export function sanitizeMarkdownLinks(source, { resolveRelative = (href) => href } = {}) {
  const dropped = [];
  const keep = (target) => {
    const classified = classifyHref(target);
    if (!classified) return false;
    return classified.type !== "relative" || Boolean(resolveRelative(classified.href));
  };
  const linkPattern = new RegExp(INLINE_LINK.source, "g");
  const sanitizeSegment = (text) => {
    let previous;
    let current = text;
    // Unwrapping an inner link can expose an outer one ("[[a](x)](y)"), so
    // repeat until stable. Each pass only shortens the text.
    do {
      previous = current;
      current = current.replace(linkPattern, (match, _bang, label, target) => {
        const href = target.startsWith("<") ? target.slice(1, -1) : target;
        if (keep(href)) return match;
        dropped.push(href);
        return label;
      });
      current = current.replace(/<([a-z][a-z0-9+.-]*:[^\s<>]*)>/gi, (match, url) => {
        if (keep(url)) return match;
        dropped.push(url);
        return url;
      });
    } while (current !== previous);
    return current;
  };

  const out = [];
  let segment = [];
  let inFence = null;
  const flush = () => {
    if (segment.length) out.push(sanitizeSegment(segment.join("\n")));
    segment = [];
  };
  for (const line of String(source ?? "").split("\n")) {
    const bare = line.replace(/\r$/, "").replace(/^\t+/, (tabs) => "    ".repeat(tabs.length));
    if (inFence) {
      out.push(line);
      const close = fenceOpen(bare);
      if (close && close.char === inFence.char && close.length >= inFence.length && isBlank(bare.slice(close.indent + close.length))) {
        inFence = null;
      }
      continue;
    }
    const fence = fenceOpen(bare);
    if (fence || isBlank(bare)) {
      flush();
      out.push(line);
      inFence = fence;
      continue;
    }
    const definition = /^ {0,3}\[(?:[^\]\\]|\\.)+\]:[ \t]*<?([^\s>]*)>?/.exec(bare);
    if (definition && !keep(definition[1])) {
      flush();
      dropped.push(definition[1]);
      continue;
    }
    segment.push(line);
  }
  flush();
  return { text: dropped.length ? out.join("\n") : String(source ?? ""), dropped: [...new Set(dropped)] };
}
