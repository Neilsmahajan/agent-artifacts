#!/usr/bin/env node

// Scaffolds an artifact source directory: the content (artifact.json) plus its
// stylesheet (styles.css). build-artifact.mjs turns those into the single
// self-contained index.html that actually gets shared. interactive.js is not
// copied: the build uses the bundled template, so new artifacts pick up its
// improvements. Add a local interactive.js only to customize behaviour.

import { cp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function usage() {
  console.log("Usage: create-artifact.mjs --output <directory> [--title <title>]");
}

function parseArgs(argv) {
  const args = { title: "Implementation Plan" };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--output") args.output = argv[++i];
    else if (value === "--title") args.title = argv[++i];
    else if (value === "--help" || value === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return args;
}

async function isNonEmpty(path) {
  try {
    const info = await stat(path);
    if (!info.isDirectory()) return true;
    return (await readdir(path)).length > 0;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  usage();
  process.exit(0);
}
if (!args.output) {
  usage();
  throw new Error("--output is required");
}

const output = resolve(args.output);
if (await isNonEmpty(output)) {
  throw new Error(`Refusing to overwrite non-empty target: ${output}`);
}

const scriptDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const template = resolve(scriptDir, "../assets/plan-site");
// The isNonEmpty check above is what guards against clobbering real content, so
// by this point the target is either absent or an empty directory. `cp` handles
// both; errorOnExist is deliberately not set, because it would reject an
// existing-but-empty directory that this script has already accepted.
await cp(template, output, {
  recursive: true,
  filter: (source) => source !== resolve(template, "interactive.js"),
});

const artifactPath = resolve(output, "artifact.json");
const artifact = JSON.parse(await readFile(artifactPath, "utf8"));
artifact.title = args.title;
await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

console.log(`Created artifact sources at ${output}`);
console.log(`Next: edit ${artifactPath}, then run build-artifact.mjs ${output}`);
