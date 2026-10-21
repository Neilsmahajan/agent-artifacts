#!/usr/bin/env node

// Builds one self-contained .html file from an artifact directory.
//
// The output has no external references: CSS and JS are inlined, and all content
// is pre-rendered into the markup. That single file is the deliverable for every
// transport — gist, Cloudflare Pages, email attachment, local file — and it
// reads correctly for both humans (in a browser) and agents (via curl/WebFetch).

import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { pageInfo, renderArtifact, renderMarkdown, resolveScript } from "./render.mjs";

function usage() {
  console.log(
    "Usage: build-artifact.mjs <artifact-dir> [--out <file.html>] [--markdown <file.md>]",
  );
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--out") args.out = argv[++i];
    else if (value === "--markdown") args.markdown = argv[++i];
    else if (value === "--help" || value === "-h") args.help = true;
    else if (!args.dir) args.dir = value;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  usage();
  process.exit(0);
}

const dir = resolve(args.dir || ".");
const scriptDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const fallbackAssets = resolve(scriptDir, "../assets/plan-site");

const data = JSON.parse(await readFile(resolve(dir, "artifact.json"), "utf8"));

// Read styles.css from the artifact directory so per-artifact design survives a
// rebuild. A directory missing it gets the bundled copy written into it rather
// than silently building against a file that is not there: the validator's
// freshness check compares the build against the sources on disk.
async function readStyles() {
  const local = resolve(dir, "styles.css");
  try {
    return await readFile(local, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const bundled = await readFile(resolve(fallbackAssets, "styles.css"), "utf8");
    await writeFile(local, bundled, "utf8");
    console.log("Restored missing styles.css from the bundled template");
    return bundled;
  }
}

// interactive.js is different: a directory without one builds from the bundled
// template, which is never copied in, so template improvements (Copy feedback,
// fixes) reach every such artifact on its next rebuild. A local copy is a
// deliberate customization and wins. The validator resolves it the same way.
const [styles, { script, source: scriptSource }] = await Promise.all([readStyles(), resolveScript(dir)]);
if (scriptSource === "template") console.log("Using the bundled template interactive.js");

// An unescaped closing script tag inside either inlined asset would terminate
// the block early and inject the rest as markup.
for (const [name, content] of [["styles.css", styles], ["interactive.js", script]]) {
  if (/<\/script/i.test(content)) {
    throw new Error(`${name} contains a closing script tag and cannot be inlined safely`);
  }
}

const html = renderArtifact(data, { styles, script, page: pageInfo(data, basename(dir)) });
const out = resolve(args.out ? args.out : resolve(dir, "index.html"));
await writeFile(out, html, "utf8");

const kb = (Buffer.byteLength(html, "utf8") / 1024).toFixed(1);
console.log(`Built ${out} (${kb} KB, self-contained)`);

// The Markdown twin is what agents should read. Inlined CSS and JS make the
// HTML roughly ten times the size for the same content, and an agent pays for
// every byte of it.
const markdownOut = resolve(args.markdown ? args.markdown : resolve(dir, "artifact.md"));
const markdown = renderMarkdown(data);
await writeFile(markdownOut, markdown, "utf8");
const mdKb = (Buffer.byteLength(markdown, "utf8") / 1024).toFixed(1);
console.log(`Built ${markdownOut} (${mdKb} KB, for agents)`);

if (basename(out) === "index.html") {
  console.log("For a gist, rebuild with --out <descriptive-slug>.html so the raw URL is self-describing.");
}
