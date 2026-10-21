// Run: node --test <skill-dir>/tests/
//
// `visibility` belonged to the retired share site. A stale field must fail
// validation (artifacts and notes) and point at per-page sharing.
//
// Scratch dirs live under ~/.cache because the scripts refuse temp roots.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { validateNote } from "../scripts/notes.mjs";

const skillDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = (name) => resolve(skillDir, "scripts", name);
const scratchParent = process.env.PUBLISH_TEST_SCRATCH || resolve(homedir(), ".cache", "publish-cloudflare-artifact-tests");

let scratch;

before(async () => {
  await mkdir(scratchParent, { recursive: true });
  scratch = await mkdtemp(resolve(scratchParent, "vis-"));
});

after(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

async function makeArtifact(dir, extra) {
  const created = spawnSync(process.execPath, [script("create-artifact.mjs"), "--output", dir], { encoding: "utf8" });
  assert.equal(created.status, 0, created.stderr);
  const data = {
    title: "Visibility fixture",
    summary: "Fixture.",
    status: "Test fixture",
    updated: "2026-09-20",
    lifecycle: "active",
    project: "alpha",
    sections: [{ title: "Body", paragraphs: ["Body."] }],
    ...extra,
  };
  await writeFile(resolve(dir, "artifact.json"), `${JSON.stringify(data, null, 2)}\n`);
  const built = spawnSync(process.execPath, [script("build-artifact.mjs"), dir], { encoding: "utf8" });
  assert.equal(built.status, 0, built.stderr);
  return spawnSync(process.execPath, [script("validate-artifact.mjs"), dir], { encoding: "utf8" });
}

test("an artifact with a visibility field fails validation", async () => {
  const ok = await makeArtifact(resolve(scratch, "plain"), {});
  assert.equal(ok.status, 0, `${ok.stdout}\n${ok.stderr}`);
  const bad = await makeArtifact(resolve(scratch, "stale"), { visibility: "shared" });
  assert.notEqual(bad.status, 0);
  assert.match(`${bad.stdout}\n${bad.stderr}`, /visibility was removed.*share\.mjs/);
});

test("a note with a visibility field fails validation", () => {
  const today = new Date().toISOString().slice(0, 10);
  const note = (extra) => `---\ntitle: T\nproject: p\nupdated: ${today}\nkind: reference\n${extra}---\n\nBody\n`;
  assert.deepEqual(validateNote({ text: note("") }).errors, []);
  for (const value of ["shared", "private"]) {
    const { errors } = validateNote({ text: note(`visibility: ${value}\n`) });
    assert.ok(errors.some((e) => /visibility was removed.*share\.mjs/.test(e)), errors.join("; "));
  }
});
