// Run: node --test <skill-dir>/tests/
//
// Real-browser tests for the comment layer ("Comment" / "Notes" / "Copy
// feedback") in assets/plan-site/interactive.js, in Chromium and WebKit with
// iPhone emulation. A fixture artifact is built into a scratch root, served by
// scripts/serve-artifact.mjs (so its Content-Security-Policy applies), and
// driven with Playwright.
//
// Playwright is optional. Without it, or without a browser build, these tests
// skip with a message and the rest of the suite is unaffected. To run them:
//
//   mkdir -p ~/.cache/publish-cloudflare-artifact-tests && cd $_ \
//     && bun add playwright && bunx playwright install chromium webkit
//
// (`playwright` is also found if it resolves from the skill directory.)

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const skillDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = (name) => resolve(skillDir, "scripts", name);
const scratchParent = process.env.PUBLISH_TEST_SCRATCH || resolve(homedir(), ".cache", "publish-cloudflare-artifact-tests");
const run = (name, ...args) => spawnSync(process.execPath, [script(name), ...args], { encoding: "utf8" });

// ---- optional Playwright ----------------------------------------------------

function loadPlaywright() {
  for (const base of [resolve(skillDir, "package.json"), resolve(scratchParent, "package.json")]) {
    try {
      return createRequire(base)("playwright");
    } catch {
      // try the next location
    }
  }
  return null;
}

const playwright = loadPlaywright();
const INSTALL_HINT = "install with: mkdir -p ~/.cache/publish-cloudflare-artifact-tests && cd $_ && bun add playwright && bunx playwright install chromium webkit";

function skipReason(browserName) {
  if (!playwright) return `Playwright is not installed (${INSTALL_HINT})`;
  const type = playwright[browserName];
  let path = "";
  try {
    path = type.executablePath();
  } catch {
    // fall through
  }
  if (!path || !existsSync(path)) return `Playwright ${browserName} is not installed (bunx playwright install ${browserName})`;
  if (!playwright.devices["iPhone 15"]) return "this Playwright has no iPhone 15 device descriptor";
  return false;
}

// ---- fixture ----------------------------------------------------------------

const UPDATED = "2026-10-17";
const fixture = () => ({
  title: "Browser fixture",
  summary: "A page for the comment layer.",
  status: "Test fixture",
  lifecycle: "active",
  project: "test",
  updated: UPDATED,
  phases: [
    { name: "Phase 0: Set up", summary: "First.", tasks: [{ title: "Write the code" }, { title: "Test it", done: true }] },
  ],
  sections: [
    {
      title: "Cash on hand",
      paragraphs: ["Cash covers four months of spending.", "A second paragraph about runway."],
      bullets: ["Bullet one about runway", "Bullet two about debt"],
    },
    { title: "Debt", paragraphs: ["The margin loan is the main risk."], bullets: ["Pay it down first"] },
  ],
  charts: [
    {
      id: "split",
      section: 0,
      type: "stack",
      title: "Split",
      rows: [{ label: "Bonds", value: 2 }, { label: "Stocks", value: 3 }],
    },
  ],
  decisions: [{ title: "Keep it simple", decision: "Yes." }],
  risks: [{ title: "Concentration", severity: "high", description: "One stock." }],
  nextActions: ["Do the thing"],
});

const ENDING = "Agent: edit artifact.json to address these. Keep every existing id. Rebuild, validate, commit and publish.";

let scratch;
let server;
let origin = "";

async function buildPage(slug, data) {
  const dir = resolve(scratch, "root", slug);
  if (!existsSync(resolve(dir, "styles.css"))) {
    const created = run("create-artifact.mjs", "--output", dir);
    assert.equal(created.status, 0, created.stderr);
  }
  await writeFile(resolve(dir, "artifact.json"), JSON.stringify(data, null, 2));
  const built = run("build-artifact.mjs", dir);
  assert.equal(built.status, 0, built.stderr);
  return dir;
}

function startServer(root) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [script("serve-artifact.mjs"), root], {
      env: { ...process.env, ARTIFACT_PORT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const timer = setTimeout(() => reject(new Error(`serve-artifact did not start: ${out}`)), 10000);
    child.stdout.on("data", (chunk) => {
      out += chunk;
      const match = out.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) {
        clearTimeout(timer);
        resolvePromise({ child, url: match[0] });
      }
    });
    child.on("error", reject);
  });
}

const enabled = ["chromium", "webkit"].some((name) => !skipReason(name));

before(async () => {
  if (!enabled) return;
  await mkdir(scratchParent, { recursive: true });
  scratch = await mkdtemp(resolve(scratchParent, "comments-"));
  await mkdir(resolve(scratch, "root"), { recursive: true });
  for (const slug of ["main", "other"]) await buildPage(slug, fixture());
  server = await startServer(resolve(scratch, "root"));
  origin = server.url;
});

after(async () => {
  if (server) server.child.kill();
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

// ---- page helpers -----------------------------------------------------------

const url = (slug) => `${origin}/${slug}/`;
const pill = (page, name) => page.locator(".notes-bar button", { hasText: name });
const block = (page, anchor) => page.locator(`[data-anchor="${anchor}"]:not(rect):not(g)`).first();
const notesKey = (slug) => `artifact-notes:${slug}`;

async function storedNotes(page, slug) {
  const raw = await page.evaluate((key) => localStorage.getItem(key), notesKey(slug));
  return raw ? JSON.parse(raw).notes : [];
}

async function commentOn(page) {
  await pill(page, /^Comment/).tap();
  await page.waitForSelector("html.notes-mode");
}

// Taps a block, writes a note and saves it.
async function addNote(page, target, text) {
  await target.tap();
  const field = page.locator("#notes-field");
  await field.waitFor({ state: "visible" });
  await field.fill(text);
  await page.getByRole("button", { name: "Save note" }).tap();
  await page.locator(".notes-sheet[open]").waitFor({ state: "detached" });
}

// Copy feedback must work in WebKit without clipboard permissions, so copies
// are recorded; the real clipboard is read in its own Chromium-only test.
const RECORD_CLIPBOARD = () => {
  window.__copied = [];
  const clipboard = navigator.clipboard;
  if (!clipboard) return;
  clipboard.writeText = (text) => {
    window.__copied.push(text);
    return Promise.resolve();
  };
};

// The sheet slides up for ~180ms; measure it once it has settled.
const settle = (page) => page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {}))));

function feedback(page) {
  return page.evaluate(() => window.__copied[window.__copied.length - 1]);
}

async function metaOf(page, name) {
  return page.locator(`meta[name="${name}"]`).getAttribute("content");
}

async function inView(page, selector) {
  return page.evaluate((sel) => {
    const node = document.querySelector(sel);
    const rect = node.getBoundingClientRect();
    const x = Math.min(Math.max(rect.left + rect.width / 2, 0), innerWidth - 1);
    const y = Math.min(Math.max(rect.top + rect.height / 2, 0), innerHeight - 1);
    const hit = document.elementFromPoint(x, y);
    return {
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
      innerWidth,
      innerHeight,
      reachable: !!hit && (hit === node || node.contains(hit)),
    };
  }, selector);
}

function assertInside(box, limit, label) {
  assert.ok(box.top >= -0.5 && box.bottom <= limit + 0.5, `${label} is within 0..${limit}: top ${box.top}, bottom ${box.bottom}`);
  assert.ok(box.left >= -0.5 && box.right <= box.innerWidth + 0.5, `${label} is within the width`);
  assert.ok(box.reachable, `${label} is not covered by another element`);
}

// ---- tests ------------------------------------------------------------------

for (const browserName of ["chromium", "webkit"]) {
  const reason = skipReason(browserName);
  describe(`comment layer in ${browserName} (iPhone 15)`, { skip: reason }, () => {
    let browser;
    const contexts = [];
    const device = (() => {
      if (reason) return {};
      const { defaultBrowserType, ...rest } = playwright.devices["iPhone 15"];
      return rest;
    })();

    before(async () => {
      browser = await playwright[browserName].launch();
    });
    after(async () => {
      await browser?.close();
    });

    // A fresh context (own localStorage) per test, with its requests recorded.
    async function open(slug = "main", options = {}) {
      const context = await browser.newContext({ ...device, ...options });
      contexts.push(context);
      if (options.javaScriptEnabled === false) {
        const page = await context.newPage();
        await page.goto(url(slug));
        return { context, page, requests: [] };
      }
      await context.addInitScript(RECORD_CLIPBOARD);
      const page = await context.newPage();
      const requests = [];
      page.on("request", (request) => requests.push({ url: request.url(), type: request.resourceType() }));
      page.on("websocket", (socket) => requests.push({ url: socket.url(), type: "websocket" }));
      await page.goto(url(slug));
      await page.waitForSelector("html.notes-ready");
      return { context, page, requests };
    }

    after(async () => {
      for (const context of contexts) await context.close().catch(() => {});
    });

    test("the Comment pill, tapping a heading, a bullet and a chart row, and the counts", async () => {
      const { page } = await open();
      assert.equal(await pill(page, "Comment").innerText(), "Comment");
      assert.equal(await pill(page, "Notes").isHidden(), true, "Notes shows only in comment mode");
      assert.equal(await pill(page, "Copy feedback").isHidden(), true, "nothing to copy yet");

      await commentOn(page);
      assert.equal(await pill(page, "Done").isVisible(), true);

      await addNote(page, page.locator('[data-anchor="sec-cash-on-hand"] .section-heading h2').first(), "Heading note");
      assert.equal(await pill(page, "Notes").innerText(), "Notes · 1");
      await addNote(page, block(page, "sec-cash-on-hand.b1"), "Bullet note");
      assert.equal(await pill(page, "Notes").innerText(), "Notes · 2");
      await addNote(page, page.locator('li[data-anchor="chart:split/row:bonds"]').first(), "Chart row note");
      assert.equal(await pill(page, "Notes").innerText(), "Notes · 3");
      assert.equal(await pill(page, "Copy feedback").isVisible(), true);

      const notes = await storedNotes(page, "main");
      assert.deepEqual(notes.map((note) => note.anchor).sort(), ["chart:split/row:bonds", "sec-cash-on-hand", "sec-cash-on-hand.b1"]);
      assert.equal(await page.locator(".notes-has-note").count() >= 3, true, "noted blocks are marked");

      await pill(page, "Done").tap();
      assert.equal(await pill(page, "Comment").innerText(), "Comment · 3");
      assert.equal(await pill(page, "Notes").isHidden(), true);
    });

    test("notes persist across reload, are scoped per page, and Clear all takes two taps", async () => {
      const { page } = await open("main");
      await commentOn(page);
      await addNote(page, block(page, "sec-cash-on-hand.p1"), "First");
      await addNote(page, block(page, "sec-debt.b1"), "Second");

      await page.reload();
      await page.waitForSelector("html.notes-ready");
      assert.equal(await pill(page, "Comment").innerText(), "Comment · 2", "notes survive a reload");
      await commentOn(page);
      assert.equal(await pill(page, "Notes").innerText(), "Notes · 2");

      // A second page on the same origin keeps its own notes.
      await page.goto(url("other"));
      await page.waitForSelector("html.notes-ready");
      assert.equal(await pill(page, "Comment").innerText(), "Comment", "the other page starts empty");
      assert.deepEqual(await storedNotes(page, "other"), []);
      assert.equal((await storedNotes(page, "main")).length, 2);
      await commentOn(page);
      await addNote(page, block(page, "sec-debt.p1"), "Other page note");
      assert.equal((await storedNotes(page, "other")).length, 1);
      assert.equal((await storedNotes(page, "main")).length, 2, "main is untouched");

      await page.goto(url("main"));
      await page.waitForSelector("html.notes-ready");
      await commentOn(page);
      await pill(page, /^Notes/).tap();
      const clear = page.getByRole("button", { name: "Clear all" });
      await clear.tap();
      assert.equal((await storedNotes(page, "main")).length, 2, "one tap only arms the button");
      assert.equal(await page.getByRole("button", { name: "Tap again to clear" }).isVisible(), true);
      await page.getByRole("button", { name: "Tap again to clear" }).tap();
      assert.deepEqual(await storedNotes(page, "main"), []);
      assert.equal(await page.evaluate((key) => localStorage.getItem(key), notesKey("main")), null, "the key is removed");
      assert.equal(await page.locator(".notes-empty").isVisible(), true);
      assert.equal(await page.locator(".notes-items li").count(), 0);
      assert.equal((await storedNotes(page, "other")).length, 1, "the other page keeps its note");
    });

    test("editing a note updates it instead of duplicating, and one note can be deleted", async () => {
      const { page } = await open();
      await commentOn(page);
      await addNote(page, block(page, "sec-cash-on-hand.p1"), "Original text");
      await addNote(page, block(page, "sec-cash-on-hand.p2"), "Keep me");
      await addNote(page, block(page, "sec-debt.p1"), "Delete me");
      assert.equal((await storedNotes(page, "main")).length, 3);

      // Tapping the block again reopens its note.
      await block(page, "sec-cash-on-hand.p1").tap();
      assert.equal(await page.locator("#notes-field").inputValue(), "Original text");
      assert.match(await page.locator(".notes-sheet[open] .notes-sheet-title").innerText(), /^Edit your note/);
      await page.locator("#notes-field").fill("Edited text");
      await page.getByRole("button", { name: "Save note" }).tap();
      let notes = await storedNotes(page, "main");
      assert.equal(notes.length, 3, "still three notes");
      assert.equal(notes.filter((note) => note.anchor === "sec-cash-on-hand.p1").length, 1);
      assert.equal(notes.find((note) => note.anchor === "sec-cash-on-hand.p1").text, "Edited text");

      // Edit from the Notes list as well.
      await pill(page, /^Notes/).tap();
      await page.locator(".notes-item", { hasText: "Keep me" }).getByRole("button", { name: "Edit" }).tap();
      await page.locator("#notes-field").fill("Kept and changed");
      await page.getByRole("button", { name: "Save note" }).tap();
      notes = await storedNotes(page, "main");
      assert.equal(notes.length, 3);
      assert.equal(notes.find((note) => note.anchor === "sec-cash-on-hand.p2").text, "Kept and changed");

      // Delete from the list.
      await pill(page, /^Notes/).tap();
      await page.getByRole("button", { name: "Delete note on sec-debt.p1" }).tap();
      notes = await storedNotes(page, "main");
      assert.deepEqual(notes.map((note) => note.anchor).sort(), ["sec-cash-on-hand.p1", "sec-cash-on-hand.p2"]);
      assert.equal(await pill(page, /^Notes/).innerText(), "Notes · 2");

      // And from the editor.
      await page.locator(".notes-sheet[open]").getByRole("button", { name: "Close" }).tap();
      await block(page, "sec-cash-on-hand.p2").tap();
      await page.locator(".notes-sheet[open]").getByRole("button", { name: "Delete" }).tap();
      assert.deepEqual((await storedNotes(page, "main")).map((note) => note.anchor), ["sec-cash-on-hand.p1"]);
    });

    for (const variant of ["selection still present at the tap (mouse-like)", "selection cleared before the tap (a phone)"]) {
      test(`selected text becomes a quote: ${variant}`, async () => {
        const { page } = await open();
        await commentOn(page);
        const target = block(page, "sec-cash-on-hand.p1");
        await target.scrollIntoViewIfNeeded();
        await page.evaluate(() => {
          const paragraph = document.querySelector('[data-anchor="sec-cash-on-hand.p1"]');
          const text = paragraph.firstChild;
          const start = text.data.indexOf("four months");
          const range = document.createRange();
          range.setStart(text, start);
          range.setEnd(text, start + "four months".length);
          const selection = getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
        });
        // selectionchange is async; the page remembers the selection from it.
        await page.waitForTimeout(150);
        if (variant.includes("cleared")) {
          assert.equal(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), true, "emulated phone has a coarse pointer");
          await page.evaluate(() => getSelection().removeAllRanges());
          await page.waitForTimeout(100);
        }
        await target.tap();
        await page.locator("#notes-field").waitFor({ state: "visible" });
        assert.equal(await page.locator(".notes-selected-text").innerText(), 'Selected: "four months"');
        await page.locator("#notes-field").fill("Why four?");
        await page.getByRole("button", { name: "Save note" }).tap();

        const [note] = await storedNotes(page, "main");
        assert.equal(note.selected.exact, "four months");
        assert.equal(note.selected.prefix, "Cash covers ");
        assert.equal(note.selected.suffix, " of spending.");

        await pill(page, "Copy feedback").tap();
        const text = await feedback(page);
        assert.match(text, /^1\. \[sec-cash-on-hand\.p1\] \(selected: "four months"\)\n {3}Note: Why four\?$/m);
      });
    }

    test("a tap with no selection quotes the block, and Remove drops the selected quote", async () => {
      const { page } = await open();
      await commentOn(page);
      await page.evaluate(() => {
        const text = document.querySelector('[data-anchor="sec-debt.p1"]').firstChild;
        const range = document.createRange();
        range.setStart(text, 4);
        range.setEnd(text, 10);
        getSelection().removeAllRanges();
        getSelection().addRange(range);
      });
      await page.waitForTimeout(150);
      await block(page, "sec-debt.p1").tap();
      await page.getByRole("button", { name: "Remove the selected-text quote" }).tap();
      assert.equal(await page.locator(".notes-selected").isHidden(), true);
      await page.locator("#notes-field").fill("Whole paragraph");
      await page.getByRole("button", { name: "Save note" }).tap();
      const [note] = await storedNotes(page, "main");
      assert.equal(note.selected, null);
      await pill(page, "Copy feedback").tap();
      assert.match(await feedback(page), /^1\. \[sec-debt\.p1\] "The margin loan is the main risk\."$/m);
    });

    test("Copy feedback matches the documented format, with the right anchors", async () => {
      const { page } = await open();
      await commentOn(page);
      // Added out of page order on purpose: the block lists them top to bottom
      // (the chart sits between a section's heading and its bullets).
      await addNote(page, page.locator('li[data-anchor="chart:split/row:bonds"]').first(), "Why so low?");
      await addNote(page, block(page, "sec-cash-on-hand.b1"), "Line one\nLine two");
      await addNote(page, page.locator('[data-anchor="sec-cash-on-hand"] .section-heading h2').first(), "Heading note");
      await pill(page, "Copy feedback").tap();
      await page.waitForFunction(() => window.__copied.length > 0);

      const build = await metaOf(page, "artifact-build");
      assert.match(build, /^[0-9a-f]+$/);
      const expected = [
        'Feedback on "Browser fixture"',
        `Page: main · version ${UPDATED} · build ${build}`,
        "Source: main/artifact.json (in its artifacts root)",
        "",
        '1. [sec-cash-on-hand] "Cash on hand"',
        "   Note: Heading note",
        "",
        "2. [chart:split/row:bonds]",
        "   Note: Why so low?",
        "",
        '3. [sec-cash-on-hand.b1] "Bullet one about runway"',
        "   Note: Line one",
        "   Line two",
        "",
        ENDING,
        "",
      ].join("\n");
      assert.equal(await feedback(page), expected);
      assert.match(await page.locator("#toast").innerText(), /^Copied 3 notes\./);
    });

    test("Copy feedback falls back to a selected textarea when the clipboard is unavailable", async () => {
      const { page } = await open();
      await page.evaluate(() => {
        navigator.clipboard.writeText = () => Promise.reject(new Error("denied"));
        document.execCommand = () => false;
      });
      await commentOn(page);
      await addNote(page, block(page, "sec-debt.b1"), "Manual copy please");
      await pill(page, "Copy feedback").tap();
      const area = page.locator("#manual-copy textarea");
      await area.waitFor({ state: "visible" });
      const text = await area.inputValue();
      assert.match(text, /^Feedback on "Browser fixture"\n/);
      assert.match(text, /1\. \[sec-debt\.b1\] "Pay it down first"\n {3}Note: Manual copy please\n/);
      assert.ok(text.endsWith(`${ENDING}\n`));
    });

    test("zero network requests after the initial load while commenting", async () => {
      const { page, requests } = await open();
      const origin_ = new URL(origin).origin;
      const afterLoad = requests.length;
      assert.ok(requests.every((request) => request.url.startsWith(origin_)), `only same-origin requests: ${JSON.stringify(requests)}`);
      assert.equal(requests.filter((request) => request.type === "document").length, 1);

      await commentOn(page);
      await addNote(page, block(page, "sec-cash-on-hand.p1"), "One");
      await addNote(page, page.locator('li[data-anchor="chart:split/row:bonds"]').first(), "Two");
      await block(page, "sec-cash-on-hand.p1").tap();
      await page.locator("#notes-field").fill("One, edited");
      await page.getByRole("button", { name: "Save note" }).tap();
      await pill(page, /^Notes/).tap();
      await page.locator(".notes-item", { hasText: "Two" }).getByRole("button", { name: "Show" }).tap();
      await pill(page, "Copy feedback").tap();
      await page.waitForTimeout(300);
      assert.deepEqual(requests.slice(afterLoad), [], "comment mode makes no requests");
    });

    test("Copy feedback writes to the real clipboard", { skip: browserName === "chromium" ? false : "WebKit cannot grant clipboard permissions in automation" }, async () => {
      const context = await browser.newContext({ ...device, permissions: ["clipboard-read", "clipboard-write"] });
      contexts.push(context);
      const page = await context.newPage();
      await page.goto(url("main"));
      await page.waitForSelector("html.notes-ready");
      await commentOn(page);
      await addNote(page, block(page, "sec-debt.p1"), "Clipboard check");
      await pill(page, "Copy feedback").tap();
      await page.waitForFunction(() => /Copied/.test(document.getElementById("toast").textContent));
      const text = await page.evaluate(() => navigator.clipboard.readText());
      assert.match(text, /^Feedback on "Browser fixture"\nPage: main · version /);
      assert.match(text, /1\. \[sec-debt\.p1\] "The margin loan is the main risk\."\n {3}Note: Clipboard check\n/);
      assert.ok(text.endsWith(`${ENDING}\n`));
    });

    test("print hides every notes control", async () => {
      const { page } = await open();
      await commentOn(page);
      await addNote(page, block(page, "sec-cash-on-hand.p1"), "Print me not");
      assert.equal(await page.locator(".notes-bar").isVisible(), true, "visible on screen");
      await page.emulateMedia({ media: "print" });
      const state = await page.evaluate(() => ({
        ui: [...document.querySelectorAll(".notes-ui")].map((node) => getComputedStyle(node).display),
        outline: getComputedStyle(document.querySelector('[data-anchor="sec-cash-on-hand.p1"]')).outlineStyle,
      }));
      assert.ok(state.ui.length >= 3, "bar, editor and list exist");
      assert.deepEqual([...new Set(state.ui)], ["none"]);
      assert.equal(state.outline, "none", "noted blocks are not outlined in print");
      assert.equal(await page.locator(".notes-ui").first().isVisible(), false);
      await page.emulateMedia({ media: "screen" });
      assert.equal(await page.locator(".notes-bar").isVisible(), true);
    });

    test("without JavaScript the content renders and there is no notes UI", async () => {
      const { page } = await open("main", { javaScriptEnabled: false });
      assert.equal(await page.locator("h1").first().isVisible(), true);
      assert.equal(await page.getByText("Cash covers four months of spending.").isVisible(), true);
      assert.equal(await page.locator(".content-section svg").count() > 0, true, "charts render without JS");
      assert.equal(await page.locator(".notes-ui").count(), 0);
      assert.equal(await page.locator("html.notes-ready").count(), 0);
    });

    test("anchors survive a rebuild that reorders sections", async () => {
      const slug = `stable-${browserName}`;
      await buildPage(slug, fixture());
      const { page } = await open(slug);
      await commentOn(page);
      const cashP2 = "A second paragraph about runway.";
      await addNote(page, block(page, "sec-cash-on-hand.p2"), "On cash");
      await addNote(page, block(page, "sec-debt.p1"), "On debt");
      await addNote(page, page.locator('li[data-anchor="chart:split/row:stocks"]').first(), "On the chart");
      const before = (await storedNotes(page, slug)).map(({ anchor, fp }) => ({ anchor, fp })).sort((a, b) => a.anchor.localeCompare(b.anchor));
      const order = await page.evaluate(() => [...document.querySelectorAll('section[data-anchor^="sec-"]')].map((node) => node.dataset.anchor));
      assert.deepEqual(order, ["sec-cash-on-hand", "sec-debt"]);

      // Swap the two sections; the chart travels with its section (index 1).
      const data = fixture();
      data.sections.reverse();
      data.charts[0].section = 1;
      await buildPage(slug, data);

      await page.reload();
      await page.waitForSelector("html.notes-ready");
      const reordered = await page.evaluate(() => [...document.querySelectorAll('section[data-anchor^="sec-"]')].map((node) => node.dataset.anchor));
      assert.deepEqual(reordered, ["sec-debt", "sec-cash-on-hand"]);
      assert.deepEqual(
        (await storedNotes(page, slug)).map(({ anchor, fp }) => ({ anchor, fp })).sort((a, b) => a.anchor.localeCompare(b.anchor)),
        before,
        "stored notes are untouched",
      );

      await commentOn(page);
      const marked = await page.evaluate(() => [...document.querySelectorAll(".notes-has-note")].map((node) => [node.dataset.anchor, node.textContent.replace(/\s+/g, " ").trim().slice(0, 40)]));
      assert.ok(marked.some(([anchor, text]) => anchor === "sec-cash-on-hand.p2" && text === cashP2), JSON.stringify(marked));
      assert.ok(marked.some(([anchor, text]) => anchor === "sec-debt.p1" && text.startsWith("The margin loan")), JSON.stringify(marked));
      assert.ok(marked.some(([anchor]) => anchor === "chart:split/row:stocks"));

      await pill(page, "Copy feedback").tap();
      const text = await feedback(page);
      assert.doesNotMatch(text, /no longer on the page|text changed/, "no note is flagged stale");
      // Document order follows the new layout: Debt first, then Cash, then the chart in Cash.
      const anchors = [...text.matchAll(/^\d+\. \[([^\]]+)\]/gm)].map((match) => match[1]);
      assert.deepEqual(anchors, ["sec-debt.p1", "sec-cash-on-hand.p2", "chart:split/row:stocks"]);
    });

    test("a note whose text or block changed is flagged, not lost", async () => {
      const slug = `stale-${browserName}`;
      await buildPage(slug, fixture());
      const { page } = await open(slug);
      await commentOn(page);
      await addNote(page, block(page, "sec-debt.p1"), "Debt note");
      await addNote(page, block(page, "sec-cash-on-hand.b2"), "Bullet note");
      const data = fixture();
      data.sections[1].paragraphs[0] = "The margin loan was repaid.";
      data.sections[0].bullets.pop();
      await buildPage(slug, data);
      await page.reload();
      await page.waitForSelector("html.notes-ready");
      await commentOn(page);
      await pill(page, "Copy feedback").tap();
      const text = await feedback(page);
      assert.match(text, /\[sec-debt\.p1\] .*\(text changed since this note\)/);
      assert.match(text, /\[sec-cash-on-hand\.b2\] .*\(no longer on the page\)/);
    });

    test("the note sheet keeps the textarea and Save button on screen, even with the viewport shrunk", async () => {
      const { page } = await open();
      await commentOn(page);
      await block(page, "sec-cash-on-hand.p1").tap();
      await page.locator("#notes-field").waitFor({ state: "visible" });
      await settle(page);
      const height = page.viewportSize().height;
      const save = ".notes-sheet[open] .notes-primary";

      const full = await inView(page, "#notes-field");
      assertInside(full, full.innerHeight, "textarea");
      assertInside(await inView(page, save), full.innerHeight, "Save note");

      // Roughly what a software keyboard leaves of an 844pt-tall window (844 -> 450).
      const shrunk = Math.round((height * 450) / 844);
      await page.setViewportSize({ width: page.viewportSize().width, height: shrunk });
      await page.waitForTimeout(250);
      await settle(page);
      const small = await inView(page, "#notes-field");
      assert.equal(small.innerHeight, shrunk);
      assertInside(small, shrunk, "textarea (short viewport)");
      assertInside(await inView(page, save), shrunk, "Save note (short viewport)");
    });

    test("the sheet lifts above an on-screen keyboard reported by visualViewport", async () => {
      const { page } = await open();
      await commentOn(page);
      await block(page, "sec-cash-on-hand.p1").tap();
      await page.locator("#notes-field").waitFor({ state: "visible" });
      // iOS leaves innerHeight alone and shrinks visualViewport instead; report
      // a 300px keyboard that way and let the page's own resize handler run.
      const keyboard = 300;
      await page.evaluate((covered) => {
        const real = window.visualViewport;
        const fake = { height: innerHeight - covered, offsetTop: 0, width: innerWidth, addEventListener() {}, removeEventListener() {} };
        Object.defineProperty(window, "visualViewport", { configurable: true, get: () => fake });
        real.dispatchEvent(new Event("resize"));
      }, keyboard);
      await settle(page);
      await page.waitForTimeout(100);
      const visible = (await inView(page, "#notes-field")).innerHeight - keyboard;
      const dialog = await inView(page, ".notes-sheet[open]");
      assert.ok(dialog.bottom <= visible + 0.5, `sheet bottom ${dialog.bottom} sits above the keyboard at ${visible}`);
      assert.ok(dialog.top >= -0.5, "sheet top stays on screen");
      assertInside(await inView(page, "#notes-field"), visible, "textarea above the keyboard");
      assertInside(await inView(page, ".notes-sheet[open] .notes-primary"), visible, "Save note above the keyboard");
    });
  });
}
