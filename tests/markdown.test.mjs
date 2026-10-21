// Run: node --test <skill-dir>/tests/
//
// Notes are agent-written, so the renderer is tested mostly as a sanitizer:
// no source byte may become markup, and only allowed link targets may become
// hrefs.

import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyHref, renderMarkdownHtml, sanitizeMarkdownLinks } from "../scripts/markdown.mjs";
import { groupByHub, renderHubMarkdown } from "../scripts/hubs.mjs";
import { createSiteIndex, parseNote, siteLinkResolver, validateNote } from "../scripts/notes.mjs";

const render = (source, options) => renderMarkdownHtml(source, options).html;

test("raw HTML is escaped, never passed through", () => {
  const html = render(`<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n**<b>bold</b>**\n\n- <iframe>\n\n| a |\n| - |\n| <svg onload=x> |\n\n> <style>x</style>`);
  assert.doesNotMatch(html, /<(?:script|img|b|iframe|svg|style)\b/i);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /<strong>&lt;b&gt;bold&lt;\/b&gt;<\/strong>/);
});

test("only http(s), mailto, relative and fragment links survive", () => {
  const bad = [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
    "vbscript:msgbox",
    "//evil.example/x",
    "/\\evil.example",
    "file:///etc/passwd",
  ];
  for (const target of bad) {
    const { html, warnings } = renderMarkdownHtml(`[click](${target})`);
    assert.doesNotMatch(html, /<a\b/, target);
    assert.ok(warnings.length, target);
  }
  assert.equal(classifyHref("java\tscript:alert(1)"), null);
  // Not even parsed as a link: stays escaped text.
  assert.doesNotMatch(render("[x](data:text/html,<script>alert(1)</script>)"), /<a\b|<script/);
  assert.match(render("[a](https://example.com/x?y=1&z=2)"), /<a href="https:\/\/example\.com\/x\?y=1&amp;z=2" target="_blank" rel="noreferrer noopener">a<\/a>/);
  assert.match(render("[mail](mailto:a@example.com)"), /<a href="mailto:a@example\.com">mail<\/a>/);
  assert.match(render("[top](#now)"), /<a href="#now">top<\/a>/);
  assert.match(render("[rel](../people/alex.md)"), /<a href="\.\.\/people\/alex\.md">rel<\/a>/);
});

test("attribute injection through a link target is impossible", () => {
  const html = render(`[x](https://example.com/"onmouseover="alert(1))`);
  assert.doesNotMatch(html, /"onmouseover=/);
  const entity = render("[x](&#106;avascript:alert(1))");
  assert.doesNotMatch(entity, /href="&#106;/);
});

test("images render as links, never as subresources", () => {
  const html = render("![diagram](https://example.com/a.png)");
  assert.doesNotMatch(html, /<img\b/);
  assert.match(html, /<a href="https:\/\/example\.com\/a\.png"[^>]*>diagram<\/a>/);
});

test("block constructs", () => {
  const html = render(
    [
      "# Title",
      "",
      "Para with `code <b>` and *em* and __strong__ and ~~gone~~.",
      "",
      "```js",
      "const a = '<b>';",
      "```",
      "",
      "1. one",
      "2. two",
      "   - nested",
      "     continued",
      "3. three",
      "",
      "- [ ] open",
      "- [x] done",
      "",
      "> quoted",
      "> more",
      "",
      "---",
      "",
      "| Left | Right |",
      "| :--- | ----: |",
      "| a \\| b | `c` |",
    ].join("\n"),
  );
  assert.match(html, /<h2 id="title">Title<\/h2>/);
  assert.match(html, /<code>code &lt;b&gt;<\/code>/);
  assert.match(html, /<em>em<\/em>/);
  assert.match(html, /<strong>strong<\/strong>/);
  assert.match(html, /<del>gone<\/del>/);
  assert.match(html, /<pre><code>const a = &#39;&lt;b&gt;&#39;;<\/code><\/pre>/);
  assert.match(html, /<ol>\n<li>one<\/li>\n<li>two\n<ul>\n<li>nested\ncontinued<\/li>\n<\/ul><\/li>\n<li>three<\/li>\n<\/ol>/);
  assert.match(html, /<li class="task"><input type="checkbox" disabled \/> open<\/li>/);
  assert.match(html, /<li class="task"><input type="checkbox" disabled checked \/> done<\/li>/);
  assert.match(html, /<blockquote>\n<p>quoted\nmore<\/p>\n<\/blockquote>/);
  assert.match(html, /<hr \/>/);
  assert.match(html, /<th class="align-left">Left<\/th><th class="align-right">Right<\/th>/);
  assert.match(html, /<td class="align-left">a \| b<\/td><td class="align-right"><code>c<\/code><\/td>/);
});

test("snake_case and URLs are not mangled by emphasis", () => {
  const html = render("use snake_case_name and https://example.com/a_b_c/*x*/y now.");
  assert.match(html, /snake_case_name/);
  assert.match(html, /<a href="https:\/\/example\.com\/a_b_c\/\*x\*\/y"/);
  assert.match(html, /<\/a> now\./);
});

test("heading levels shift so the shallowest heading lands on headingBase", () => {
  assert.match(render("## A\n\n### B", { headingBase: 2 }), /<h2 id="a">A<\/h2>\n<h3 id="b">B<\/h3>/);
  assert.match(render("## A", { headingBase: 3 }), /<h3 id="a">A<\/h3>/);
});

test("frontmatter parser ignores body lines and rejects nesting", () => {
  const parsed = parseNote("---\ntitle: T\nproject: p\n---\nvisibility: shared\n");
  assert.equal(parsed.fields.visibility, undefined);
  assert.match(parsed.body, /visibility: shared/);
  assert.ok(parseNote("---\ntitle: T\n  nested: x\n---\n").errors.length);
  assert.ok(parseNote("title: T\n").errors.length);
  assert.equal(parseNote("---\n__proto__: x\ntitle: T\n---\n").fields.title, "T");
});

test("site resolver keeps published targets and drops the rest", () => {
  const site = createSiteIndex({ artifactSlugs: ["plan"], noteIds: ["alpha/status", "people/alex"], hubSlugs: ["alpha"] });
  const resolve = siteLinkResolver({ id: "alpha/status", pageDir: "notes/alpha/status/", site });
  assert.equal(resolve("../people/alex.md"), "../../../notes/people/alex/");
  assert.equal(resolve("../../plan/"), "../../../plan/");
  assert.equal(resolve("../../plan/artifact.md#x"), "../../../plan/artifact.md#x");
  assert.equal(resolve("../people/private.md"), null);
  assert.equal(resolve("../../private-plan/"), null);
  const hub = siteLinkResolver({ id: "alpha/status", pageDir: "projects/alpha/", site });
  assert.equal(hub("../people/alex.md"), "../../notes/people/alex/");
});

test("note validation: sizes, secrets, enums", () => {
  const head = "---\ntitle: T\nproject: p\nupdated: 2026-09-01\nkind: reference\n---\n";
  assert.deepEqual(validateNote({ id: "p/t", text: head + "ok", today: new Date(2026, 8, 25) }).errors, []);
  assert.ok(validateNote({ id: "p/t", text: head + "x".repeat(5000), today: new Date(2026, 8, 25) }).warnings.some((w) => /bytes/.test(w)));
  assert.ok(validateNote({ id: "p/t", text: head + "x".repeat(13000) }).errors.some((e) => /bytes/.test(e)));
  assert.ok(validateNote({ id: "p/t", text: head + "sk-abcdefghijklmnopqrstuvwxyz" }).errors.some((e) => /OpenAI/.test(e)));
  assert.ok(validateNote({ id: "p/t", text: head.replace("reference", "status").replace("2026-09-01", "2026-06-01"), today: new Date(2026, 8, 25) }).warnings.some((w) => /days ago/.test(w)));
});

test("fuzz: random Markdown-ish input yields only allowlisted markup, quickly", () => {
  const alphabet = ["*", "_", "`", "[", "]", "(", ")", "<", ">", "\"", "'", "&", "!", "#", "-", "|", ":", "~", "\\", " ", " ", "\n", "\n\n", "a", "b", "1.", "http://x.y/", "javascript:", "> ", "```", "- ", "   ", "\t"];
  const tags = /^(?:p|h[1-6]|strong|em|del|code|pre|a|ul|ol|li|input|blockquote|hr|br|div|table|thead|tbody|tr|th|td)$/;
  const attrs = /^(?:id|href|target|rel|class|type|disabled|checked|start)$/;
  let seed = 42;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const started = Date.now();
  for (let round = 0; round < 3000; round += 1) {
    let source = "";
    const length = 1 + Math.floor(random() * 120);
    for (let i = 0; i < length; i += 1) source += alphabet[Math.floor(random() * alphabet.length)];
    const { html } = renderMarkdownHtml(source, { resolveRelative: () => null });
    for (const [, name, rest] of html.matchAll(/<\/?([a-zA-Z0-9]+)([^>]*)>/g)) {
      assert.match(name, tags, source);
      for (const [, attr] of rest.matchAll(/\s([a-zA-Z-]+)(?:="[^"]*")?/g)) assert.match(attr, attrs, source);
      if (/href=/.test(rest)) assert.match(rest, /href="(?:https?:|mailto:|#)/, source);
    }
    assert.doesNotMatch(html, /<[a-zA-Z/][^>]*</, source);
  }
  assert.ok(Date.now() - started < 10000, "renderer too slow on fuzz input");
});

test("pathological input does not backtrack catastrophically", () => {
  const started = Date.now();
  render("*".repeat(5000) + "a");
  render("_a".repeat(5000));
  render("[".repeat(3000) + "](" .repeat(3000));
  render("`".repeat(4000) + "a");
  render("> ".repeat(2000) + "a");
  render(("- a\n  ").repeat(2000));
  assert.ok(Date.now() - started < 5000, `took ${Date.now() - started}ms`);
});

test("raw Markdown sanitizer drops the same links the page drops, and nothing else", () => {
  const onSite = (href) => (href.includes("private") ? null : href);
  const source = [
    "Keep [ok](../ok/) and [web](https://example.com) and `code`.",
    "Drop [plan](../../private-plan/) and ![img](../private.png) and [js](javascript:alert(1)).",
    "Nested [[inner](../../private-a/)](../../private-b/) and <javascript:alert(1)>.",
    "[ref]: ../../private-ref/",
    "[good]: ../ok/",
    "```",
    "[literal](../../private-in-fence/)",
    "```",
  ].join("\n");
  const { text, dropped } = sanitizeMarkdownLinks(source, { resolveRelative: onSite });
  assert.equal(
    text,
    [
      "Keep [ok](../ok/) and [web](https://example.com) and `code`.",
      "Drop plan and img and js.",
      "Nested inner and javascript:alert(1).",
      "[good]: ../ok/",
      "```",
      "[literal](../../private-in-fence/)",
      "```",
    ].join("\n"),
  );
  assert.ok(dropped.includes("../../private-plan/") && dropped.includes("../../private-ref/"));
  const clean = "No links here.\r\n\r\n[a](../ok/)\r\n";
  assert.equal(sanitizeMarkdownLinks(clean, { resolveRelative: onSite }).text, clean);
});

test("hub index.md escapes interpolated text so it cannot inject links or HTML", () => {
  const hostile = "[x](javascript:alert(1)) <img src=x onerror=alert(1)> *b* _i_ `c` | t \\";
  const md = renderHubMarkdown(
    {
      slug: "p",
      project: "# <b>Proj</b> [p](https://evil.example)",
      entries: [
        { kind: "artifact", title: hostile, summary: `# ${hostile}\nsecond line`, updated: "<u>2026</u>", lifecycle: "active", path: "a(b) c/", markdownPath: null },
      ],
    },
    { siteBase: "https://site.example" },
  );
  const [heading, , , , item] = md.split("\n");
  assert.equal(heading, "# \\# \\<b\\>Proj\\</b\\> \\[p\\](https://evil.example) — project index");
  assert.ok(item.startsWith("- [\\[x\\](javascript:alert(1)) \\<img"), item);
  assert.match(item, /\]\(https:\/\/site\.example\/a%28b%29%20c\/\) — artifact\/active · \\<u\\>2026\\<\/u\\> · \\# \\\[x/);
  assert.match(item, /\\\*b\\\* \\_i\\_ \\`c\\` \\\| t \\\\ second line$/);
  // Every [ ] < > | outside the one intended link is escaped.
  const unescaped = item.replace(/^- \[/, "").replace(/\]\(https:[^)]*\)/, "").match(/(?<!\\)[[\]<>|`*_]/g);
  assert.equal(unescaped, null, item);
});

test("project names that slugify to the same hub are refused, not merged", () => {
  assert.throws(
    () => groupByHub([{ slug: "a", project: "AI Tooling" }, { slug: "b", project: "ai-tooling" }, { slug: "c", project: "ai-tooling" }]),
    /\/projects\/ai-tooling\/: "AI Tooling" \(a\) vs "ai-tooling" \(b, c\)/,
  );
  assert.equal(groupByHub([{ slug: "a", project: "ai-tooling" }, { slug: "b", project: "ai-tooling" }]).length, 1);
});
