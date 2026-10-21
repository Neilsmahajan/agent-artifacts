#!/usr/bin/env node

// Validates an artifact directory: the source content, and the built file that
// actually gets published. The built file is what ships, so it is what gets
// scanned for secrets and checked for stray external references.

import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";

import { validateAnchorIds } from "./anchors.mjs";
import { validateCharts } from "./charts.mjs";
import { findLocalReferences, findSecrets } from "./content-checks.mjs";
import { pageInfo, renderArtifact, renderMarkdown, TEMPLATE_SCRIPT } from "./render.mjs";

const target = resolve(process.argv[2] || ".");
const errors = [];
const warnings = [];

// interactive.js is optional: without a local copy the page builds from the
// bundled template (see build-artifact.mjs), and the rebuild below does too.
const sourceFiles = ["artifact.json", "styles.css", "interactive.js"];
const requiredSources = ["artifact.json", "styles.css"];
const builtFile = "index.html";
const builtMarkdown = "artifact.md";

async function readIfFile(name) {
  try {
    const info = await stat(resolve(target, name));
    if (!info.isFile()) {
      errors.push(`${name} is not a file`);
      return null;
    }
    return await readFile(resolve(target, name), "utf8");
  } catch {
    return null;
  }
}

const contents = {};
for (const name of [...sourceFiles, builtFile, builtMarkdown]) {
  contents[name] = await readIfFile(name);
}

for (const name of requiredSources) {
  if (contents[name] === null) errors.push(`Missing ${name}`);
}
const script = contents["interactive.js"] ?? await readFile(TEMPLATE_SCRIPT, "utf8");
for (const name of [builtFile, builtMarkdown]) {
  if (contents[name] === null) {
    errors.push(`Missing ${name} — run build-artifact.mjs before validating`);
  }
}

let data;
try {
  data = JSON.parse(contents["artifact.json"] ?? "");
} catch (error) {
  errors.push(`artifact.json is invalid: ${error.message}`);
}

// Freshness is checked by rebuilding from the sources on disk and comparing
// bytes, not by comparing timestamps. A timestamp says only that a file was
// written; this proves the published output is what these sources produce, and
// it catches a changed renderer as readily as a changed plan.
//
// Invalid charts or ids make the renderer throw, so they are reported once,
// field by field, instead of as a failed rebuild.
const schemaErrors = data ? [...validateCharts(data), ...validateAnchorIds(data)] : [];
errors.push(...schemaErrors);
if (data && !schemaErrors.length && contents["styles.css"] !== null) {
  const expectations = [
    [builtFile, () => renderArtifact(data, {
      styles: contents["styles.css"],
      script,
      page: pageInfo(data, basename(target)),
    })],
    [builtMarkdown, () => renderMarkdown(data)],
  ];
  for (const [name, build] of expectations) {
    if (contents[name] === null) continue;
    let expected;
    try {
      expected = build();
    } catch (error) {
      errors.push(`Could not rebuild ${name} for comparison: ${error.message}`);
      continue;
    }
    if (expected !== contents[name]) {
      errors.push(`${name} does not match its sources — rebuild before publishing`);
    }
  }
}

if (data) {
  for (const field of ["title", "summary", "status", "updated"]) {
    if (data[field] === undefined || data[field] === null || data[field] === "") {
      errors.push(`artifact.json requires ${field}`);
    }
  }
  const hasPhases = Array.isArray(data.phases) && data.phases.length > 0;
  const hasSections = Array.isArray(data.sections) && data.sections.length > 0;
  if (!hasPhases && !hasSections) {
    errors.push("artifact.json requires phases and/or sections (a non-empty array)");
  }
  if (hasPhases) {
    data.phases.forEach((phase, phaseIndex) => {
      if (!phase.name || !phase.summary) {
        errors.push(`phases[${phaseIndex}] requires name and summary`);
      }
      if (phase.tasks !== undefined && !Array.isArray(phase.tasks)) {
        errors.push(`phases[${phaseIndex}].tasks must be an array`);
      }
    });
  } else if (data.phases !== undefined && !Array.isArray(data.phases)) {
    errors.push("artifact.json phases must be an array");
  }
  if (hasSections) {
    data.sections.forEach((section, sectionIndex) => {
      if (!section.title) errors.push(`sections[${sectionIndex}] requires title`);
    });
  } else if (data.sections !== undefined && !Array.isArray(data.sections)) {
    errors.push("artifact.json sections must be an array");
  }
  if (data.progress !== undefined && (!Number.isFinite(data.progress) || data.progress < 0 || data.progress > 100)) {
    errors.push("progress must be a number from 0 to 100");
  }

  // Lifecycle is a strict enum, separate from the prose `status`: agents branch
  // on it (registry filtering, "is this plan still live?"), so free text here
  // would silently defeat every consumer. Values other than the enum are hard
  // errors; absence is a warning for compatibility with pre-lifecycle roots.
  const lifecycles = ["draft", "active", "superseded", "archived"];
  if (data.lifecycle !== undefined && !lifecycles.includes(data.lifecycle)) {
    errors.push(`lifecycle must be one of: ${lifecycles.join(", ")}`);
  }
  if (data.lifecycle === undefined) {
    warnings.push("artifact.json has no lifecycle (draft|active|superseded|archived) — required for new artifacts");
  }
  if (data.project === undefined) {
    warnings.push("artifact.json has no project — required for new artifacts; the root index groups by it");
  }
  if (data.supersededBy !== undefined) {
    if (typeof data.supersededBy !== "string" || !/^[A-Za-z0-9._-]+$/.test(data.supersededBy)) {
      errors.push("supersededBy must be the slug of the replacing artifact");
    }
    if (data.lifecycle !== "superseded") {
      errors.push('supersededBy requires lifecycle "superseded"');
    }
  }
  // Charts render as three width variants that only the stylesheet's container
  // query sorts out; a bespoke styles.css without the chart block shows all
  // three stacked.
  if (Array.isArray(data.charts) && data.charts.length && contents["styles.css"] !== null
    && !/\.viz-w560\b/.test(contents["styles.css"])) {
    warnings.push("artifact has charts but styles.css has no chart rules — copy the charts block from the bundled template styles.css");
  }
  if (data.tags !== undefined && (!Array.isArray(data.tags) || data.tags.some((tag) => typeof tag !== "string"))) {
    errors.push("tags must be an array of strings");
  }
  // Stale field from the retired share site; sharing is per page now.
  if (data.visibility !== undefined) {
    errors.push("visibility was removed: delete the field; sharing is per page via share.mjs (or the Share screen)");
  }
}

for (const name of [...sourceFiles, builtFile, builtMarkdown]) {
  const content = contents[name];
  if (content === null) continue; // Missing files are reported above.
  for (const label of findSecrets(content)) errors.push(`${name} appears to contain a ${label}`);
  for (const what of findLocalReferences(content)) warnings.push(`${name} contains ${what}`);
}

// The whole point of the build is one file that renders with no second request.
// A subresource the browser must fetch breaks that on a gist proxy, in an email
// client, or from a local path. An outbound <a> link does not — following one is
// the reader's choice, not something the page needs in order to display.
if (contents[builtFile] !== null) {
  const html = contents[builtFile];
  // Elements whose src/href the browser resolves while rendering the document.
  const subresource = /\b(?:script|link|img|iframe|source|video|audio|embed|object|track|use)\b/i;

  const tags = html.matchAll(/<([a-z][a-z0-9-]*)\b([^>]*)>/gi);
  for (const [, tagName, attrs] of tags) {
    // Quoted or bare attribute values; a bare value cannot contain whitespace.
    const refs = [...attrs.matchAll(/\b(src|srcset|href|data)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)];
    for (const [, attr, dq, sq, bare] of refs) {
      const ref = (dq ?? sq ?? bare ?? "").trim();
      if (!ref || ref.startsWith("#") || /^(?:data|mailto):/i.test(ref)) continue;

      // The build links each page to its own generated siblings so agents can
      // discover the cheap representations (<link rel="alternate"> in the head,
      // <a> in the footer). Neither is fetched while rendering, so the single
      // file still displays on its own; the refs resolve wherever the artifact
      // directory ships intact, which publish-pages.mjs guarantees.
      const tag = tagName.toLowerCase();
      const isSibling = ref === "artifact.md" || ref === "artifact.json";
      if (isSibling && (tag === "a" || (tag === "link" && /\brel\s*=\s*["']?alternate\b/i.test(attrs)))) {
        continue;
      }

      // A superseded artifact links to its replacement in the same root
      // (../<slug>/). Like the sibling files, the link is navigation, not a
      // subresource — the page still renders alone — and it resolves wherever
      // the whole root ships intact.
      if (tag === "a" && /^\.\.\/[A-Za-z0-9._-]+\/$/.test(ref)) {
        continue;
      }

      if (subresource.test(tagName)) {
        errors.push(
          `${builtFile} loads an external subresource (<${tagName.toLowerCase()} ${attr.toLowerCase()}="${ref}">) and is not self-contained`,
        );
      } else if (!/^https?:\/\//i.test(ref)) {
        errors.push(`${builtFile} references a local file (${ref}) and is not self-contained`);
      } else {
        warnings.push(`${builtFile} links out to ${ref}`);
      }
    }
  }
}

for (const warning of [...new Set(warnings)]) console.warn(`WARN: ${warning}`);
for (const error of [...new Set(errors)]) console.error(`ERROR: ${error}`);

if (errors.length) process.exit(1);
console.log(`Artifact validation passed: ${target}`);
