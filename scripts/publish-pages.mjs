#!/usr/bin/env node

// Publishes an artifacts *root* — a directory of artifact subdirectories — to a
// single Cloudflare Pages project.
//
// Cloudflare Pages replaces the entire site on every deployment: it does not
// merge a new upload into the previous one. Deploying one artifact directory at
// a time to a shared project would therefore 404 every previously published
// artifact. So the root is the unit of deployment, it accumulates locally, and
// each publish re-uploads every artifact in it.
//
// The root may also hold notes/**/*.md. Notes are rendered straight into the
// staging directory here (never pre-built into the source tree), and every
// project with at least one published entry gets a hub page under /projects/.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import {
  cp,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, posix, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { groupByHub, orderHubEntries, renderHubMarkdown, renderHubPage } from "./hubs.mjs";
import { renderMarkdownHtml } from "./markdown.mjs";
import {
  createSiteIndex,
  discoverNotes,
  notePageDir,
  noteRawPath,
  parseNote,
  renderNotePage,
  sanitizeNote,
  siteLinkResolver,
  validateNote,
} from "./notes.mjs";
import { esc } from "./render.mjs";

// Scratch directories (the git snapshot, the staged site, wrangler configs)
// are removed when the process exits, however it exits; a dry run keeps its
// staged site for inspection.
const scratchDirs = [];
process.on("exit", () => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});
async function scratchDir(prefix, { keep = false } = {}) {
  const dir = await mkdtemp(resolve(tmpdir(), prefix));
  if (!keep) scratchDirs.push(dir);
  return dir;
}

function usage() {
  console.log(
    "Usage: publish-pages.mjs --root <artifacts-root> --project <name> --branch <name> --confirm-public [--new-project] [--require-access] [--working-tree]\n" +
      "       publish-pages.mjs --root <artifacts-root> --project <name> --dry-run [--working-tree]",
  );
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--root") args.root = argv[++i];
    else if (value === "--project") args.project = argv[++i];
    else if (value === "--branch") args.branch = argv[++i];
    else if (value === "--confirm-public") args.confirmPublic = true;
    else if (value === "--new-project") args.newProject = true;
    else if (value === "--require-access") args.requireAccess = true;
    else if (value === "--dry-run") args.dryRun = true;
    else if (value === "--working-tree") args.workingTree = true;
    else if (value === "--help" || value === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  usage();
  process.exit(0);
}
// A dry run stages and validates everything but never touches Cloudflare, so
// it needs no branch and no publishing confirmation. --project still matters:
// it names the site in the generated registry URLs.
for (const key of args.dryRun ? ["root", "project"] : ["root", "project", "branch"]) {
  if (!args[key]) {
    usage();
    throw new Error(`--${key} is required`);
  }
}
if (!args.confirmPublic && !args.dryRun) {
  throw new Error(
    "Refusing to publish without --confirm-public. Preview deployments are public too.",
  );
}
if (!/^[a-z0-9][a-z0-9-]{0,57}[a-z0-9]$|^[a-z0-9]$/i.test(args.project)) {
  throw new Error(
    "Project name must contain only letters, numbers, and hyphens",
  );
}
if (args.branch !== undefined && !/^[a-z0-9][a-z0-9._/-]{0,100}$/i.test(args.branch)) {
  throw new Error("Branch name contains unsupported characters");
}

const requestedRoot = resolve(args.root);

// The root is the durable source of truth for everything published to the
// project — losing it means losing the ability to update the site. A root in a
// temp or session-scoped directory defeats that, so refuse it outright; copy
// the artifact into a durable root instead of staging a throwaway one.
{
  const realRoot = await realpath(requestedRoot);
  const ephemeralPrefixes = [
    await realpath(tmpdir()).catch(() => tmpdir()),
    "/tmp",
    "/private/tmp",
    "/var/tmp",
    "/private/var/tmp",
    "/private/var/folders",
    "/var/folders",
    resolve(homedir(), "tmp"),
  ];
  // macOS firmlink alias: /System/Volumes/Data/private/... is the same tree.
  const aliasRoot = realRoot.replace(/^\/System\/Volumes\/Data(?=\/)/, "");
  for (const prefix of ephemeralPrefixes) {
    if (
      [realRoot, aliasRoot].some(
        (r) => r === prefix || r.startsWith(prefix + sep),
      )
    ) {
      throw new Error(
        `Refusing to publish from ephemeral root ${realRoot} — copy the artifact ` +
          "directories into a durable artifacts root (kept under version control) and publish that.",
      );
    }
  }
}

// Several agent sessions often write to the same root at once. Publishing the
// files on disk would ship another session's half-finished edit, or fail the
// whole publish when that edit left a build stale. So when the root is in a git
// work tree, publish a snapshot of HEAD: committed work only, which is what
// every session has already finished. A session publishes its own change by
// committing it first. --working-tree opts back into the files on disk (a
// local preview of uncommitted edits).
const root = args.workingTree ? requestedRoot : await snapshotHead(requestedRoot);

const skillDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const validator = resolve(skillDir, "scripts/validate-artifact.mjs");
const pagesRootAssets = resolve(skillDir, "assets/pages-root");

// ---- discover artifacts -----------------------------------------------------

const entries = await readdir(root, { withFileTypes: true });
const artifacts = [];
const staticArtifacts = [];
for (const entry of entries) {
  if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
  // archive/ holds un-published artifacts: kept in the repo (and git history)
  // but deliberately absent from the deployed site and its registry. Moving a
  // directory there is the supported way to take an artifact down.
  if (entry.name === "archive") continue;
  const dir = resolve(root, entry.name);
  // notes/ holds Markdown notes, rendered further down; it is never an
  // artifact directory, so it gets none of the artifact warnings. An artifact
  // marker inside it means someone tried to use the reserved name as a slug.
  if (entry.name === "notes") {
    for (const marker of ["artifact.json", "static-artifact.json"]) {
      if (await stat(resolve(dir, marker)).catch(() => null)) {
        throw new Error(
          `notes/${marker}: "notes" is reserved for Markdown notes (published at /notes/) — rename that artifact directory`,
        );
      }
    }
    continue;
  }
  try {
    await stat(resolve(dir, "index.html"));
  } catch {
    console.warn(`WARN: skipping ${entry.name} (no built index.html)`);
    continue;
  }
  // No artifact.json means this directory is not a pipeline artifact. A
  // hand-built static site can still opt in with a static-artifact.json
  // marker ({title, summary, status, updated}); the marker publishes the
  // WHOLE directory verbatim — no validation, no staging whitelist — so it
  // is an explicit choice, never a default. Without either file the
  // directory is skipped loudly. An unparseable artifact.json is a broken
  // artifact and still fails the publish: it would ship a page nobody can
  // rebuild or verify.
  let data;
  try {
    data = JSON.parse(await readFile(resolve(dir, "artifact.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      let staticData;
      try {
        staticData = JSON.parse(
          await readFile(resolve(dir, "static-artifact.json"), "utf8"),
        );
      } catch (staticError) {
        if (staticError.code === "ENOENT") {
          console.warn(
            `WARN: skipping ${entry.name} (no artifact.json — not a pipeline artifact; it will NOT be published)`,
          );
          continue;
        }
        throw new Error(
          `${entry.name}/static-artifact.json is invalid: ${staticError.message}`,
        );
      }
      for (const key of ["title", "summary", "status", "updated"]) {
        if (!staticData[key]) {
          throw new Error(
            `${entry.name}/static-artifact.json is missing required field "${key}"`,
          );
        }
      }
      staticArtifacts.push({ slug: entry.name, dir, data: staticData });
      continue;
    }
    throw new Error(`${entry.name}/artifact.json is invalid: ${error.message}`);
  }
  artifacts.push({ slug: entry.name, dir, data });
}

// sharing.config.json in the root turns on per-page sharing for one project
// (see assets/pages-worker/). It holds no secrets: the project, its KV
// namespace for link codes, the Access team domain, and the owner. The Share
// helper's API token and cookie key are Pages secrets (ACCESS_API_TOKEN,
// SHARE_COOKIE_KEY), set once by setup.mjs.
let sharing = null;
try {
  const config = JSON.parse(await readFile(resolve(root, "sharing.config.json"), "utf8"));
  if (config.project === args.project) sharing = config;
} catch (error) {
  if (error.code !== "ENOENT") throw new Error(`sharing.config.json is invalid: ${error.message}`);
}
if (sharing && !/^[0-9a-f]{32}$/.test(sharing.kvNamespaceId || ""))
  throw new Error("sharing.config.json: kvNamespaceId must be a KV namespace id");
// Page comments (D1) are on when the config names the database.
if (sharing && sharing.d1DatabaseId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(sharing.d1DatabaseId))
  throw new Error("sharing.config.json: d1DatabaseId must be a D1 database id");
if (sharing && !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(sharing.teamDomain || ""))
  throw new Error("sharing.config.json: teamDomain must be <team>.cloudflareaccess.com");
// How guests see the owner's comments labelled ("Sam"); optional.
if (sharing && sharing.ownerName !== undefined && !/^[\p{L}\p{M}][\p{L}\p{M} .'-]{0,39}$/u.test(sharing.ownerName))
  throw new Error("sharing.config.json: ownerName must be a short plain name");
// The site's name in page text ("Saved on <siteName>"; defaults to the
// project) and where agents find this root on disk (the Copy feedback Source
// line); both optional.
if (sharing && sharing.siteName !== undefined && !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/.test(sharing.siteName))
  throw new Error("sharing.config.json: siteName must be a short plain name");
if (sharing && sharing.sourceRoot !== undefined && !/^[~A-Za-z0-9._/-][A-Za-z0-9 ._/~-]{0,199}$/.test(sharing.sourceRoot))
  throw new Error("sharing.config.json: sourceRoot must be a plain path, like ~/artifacts");
const siteName = sharing ? sharing.siteName || sharing.project : "";
for (const key of ["hostname", "owner", "accountId"]) {
  if (sharing && !/^[A-Za-z0-9.@+_-]+$/.test(sharing[key] || "")) throw new Error(`sharing.config.json: ${key} is missing or malformed`);
}

// Generated content owns these top-level paths; an artifact there would be
// overwritten by (or overwrite) note pages and project hubs. Sharing paths
// start with an underscore, which a slug can never do.
const RESERVED_SLUGS = new Map([
  ["notes", "note pages"],
  ["projects", "project hub pages"],
]);
for (const { slug } of [...artifacts, ...staticArtifacts]) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    throw new Error(`Artifact directory "${slug}" is not a valid slug (lowercase letters, digits and hyphens)`);
  }
  if (RESERVED_SLUGS.has(slug)) {
    throw new Error(
      `Artifact slug "${slug}" is reserved: /${slug}/ holds generated ${RESERVED_SLUGS.get(slug)} — rename the directory`,
    );
  }
}

// ---- notes ------------------------------------------------------------------
//
// Each note file is read once; those bytes are what gets validated, rendered,
// and staged.

const today = new Date();
const { notes: foundNotes, ignored: ignoredNoteFiles } = await discoverNotes(root);
for (const { path, reason } of ignoredNoteFiles) {
  console.warn(`WARN: skipping ${path} (${reason}) — not published; only .md files with frontmatter are notes`);
}
for (const note of foundNotes) {
  note.parsed = note.text === null ? null : parseNote(note.text);
}
const notes = foundNotes;
for (const note of notes) {
  if (note.text === null) throw new Error(`${note.path} is not valid UTF-8`);
}

if (!artifacts.length && !staticArtifacts.length && !notes.length)
  throw new Error(`No built artifacts or notes found under ${root}`);

// One entry per published page, in the shape the root index, the registry, and
// the hubs all read. `data` keeps each artifact's source fields verbatim so the
// root index and registry render exactly as they did before notes existed.
const siteEntries = [
  ...artifacts.map((artifact) => artifactEntry(artifact, "artifact")),
  ...staticArtifacts.map((artifact) => artifactEntry(artifact, "static")),
  ...notes.map(noteEntry),
];
const hubs = groupByHub(siteEntries);
const publishedSlugs = new Set([...artifacts, ...staticArtifacts].map(({ slug }) => slug));
const site = createSiteIndex({
  artifactSlugs: [...publishedSlugs],
  noteIds: notes.map(({ id }) => id),
  hubSlugs: hubs.map(({ slug }) => slug),
});

let failedNotes = 0;
for (const note of notes) {
  const { errors, warnings } = validateNote({
    id: note.id,
    text: note.text,
    today,
    resolveRelative: siteLinkResolver({ id: note.id, pageDir: notePageDir(note.id), site }),
  });
  for (const warning of warnings) console.warn(`WARN: ${note.path}: ${warning}`);
  for (const error of errors) console.error(`ERROR: ${note.path}: ${error}`);
  if (errors.length) failedNotes += 1;
}
if (failedNotes) throw new Error(`${failedNotes} note(s) failed validation — fix them (validate-notes.mjs) and re-run`);

// The raw .md ships beside the page, so links the page drops (targets this
// site does not publish) are reduced to their
// text in the shipped Markdown too, and the page and hub render from that same
// sanitized body. The validation warnings above already name each dropped link.
for (const note of notes) {
  const sanitized = sanitizeNote(
    note.text,
    siteLinkResolver({ id: note.id, pageDir: notePageDir(note.id), site }),
  );
  if (sanitized.dropped.length) {
    console.warn(
      `WARN: ${note.path}: ${sanitized.dropped.length} link target(s) not on this site reduced to text in the shipped Markdown`,
    );
  }
  note.shipped = sanitized.dropped.length ? Buffer.from(sanitized.text, "utf8") : note.bytes;
  note.parsed.body = sanitized.body;
  siteEntries.find((entry) => entry.kind === "note" && entry.id === note.id).body = sanitized.body;
}

const publishedFiles = ["index.html", "artifact.json", "artifact.md"];

// Every artifact in the root ships on every deploy, so every artifact is
// re-validated — not just the one being worked on today. Record what passed so
// the staged upload can be checked against it.
for (const artifact of artifacts) {
  await run(process.execPath, [validator, artifact.dir]);
  artifact.hashes = {};
  for (const name of publishedFiles) {
    const bytes = await readFile(resolve(artifact.dir, name));
    artifact.hashes[name] = createHash("sha256").update(bytes).digest("hex");
  }
}

// ---- stage ------------------------------------------------------------------
//
// Only the built page and its source JSON are uploaded. Staging keeps stray
// local files in an artifact directory from being published by accident.

const staging = await scratchDir("artifact-publish-", { keep: args.dryRun });
for (const artifact of artifacts) {
  const dest = resolve(staging, artifact.slug);
  await mkdir(dest, { recursive: true });
  // artifact.md and artifact.json ship next to the page so an agent given the
  // artifact URL has a cheap path to the same content.
  for (const name of publishedFiles) {
    await cp(resolve(artifact.dir, name), resolve(dest, name));
  }
}

// The validator ran against the source directory. These are the bytes that will
// actually be uploaded, so confirm they are the same bytes that passed — an edit
// landing between validation and staging would otherwise ship unvalidated.
for (const artifact of artifacts) {
  for (const name of publishedFiles) {
    const staged = await readFile(resolve(staging, artifact.slug, name));
    const stagedHash = createHash("sha256").update(staged).digest("hex");
    if (stagedHash !== artifact.hashes[name]) {
      throw new Error(
        `${artifact.slug}/${name} changed after it was validated — re-run publish`,
      );
    }
  }
}

// Static artifacts ship verbatim: the whole directory, marker file included
// (it is the equivalent of artifact.json — cheap metadata for agents).
for (const artifact of staticArtifacts) {
  await cp(artifact.dir, resolve(staging, artifact.slug), { recursive: true });
}

for (const name of await readdir(pagesRootAssets)) {
  await cp(resolve(pagesRootAssets, name), resolve(staging, name));
}

// Per-page sharing (link codes, later the Share screen) runs in a Pages
// advanced-mode worker. Only roots with a sharing.config.json naming this
// project get it; _routes.json keeps every other path static, so the worker
// never sees them. /_share/pages.json lists the pages a link may serve —
// artifacts only, never notes, hubs or the root index.
// Page comments (assets/pages-worker/comments-api.js, D1) ride on sharing:
// they need the worker, and the database id lives in the same config.
const comments = Boolean(sharing && sharing.d1DatabaseId);
const commentPages = new Map();
const ARTIFACT_CSP = (await readFile(resolve(pagesRootAssets, "_headers"), "utf8")).match(/^\s*Content-Security-Policy: (.+)$/m)[1];

if (sharing) {
  // A _worker.js *directory* is uploaded as modules (never served as files),
  // so the worker can import the same access.mjs share.mjs uses.
  await cp(resolve(skillDir, "assets/pages-worker"), resolve(staging, "_worker.js"), { recursive: true });
  await writeFile(
    resolve(staging, "_routes.json"),
    JSON.stringify(
      { version: 1, include: ["/_link", "/_link/*", "/_share/api/*", ...(comments ? ["/*/_comments/*"] : [])], exclude: [] },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  const allSlugs = new Set([...artifacts, ...staticArtifacts].map(({ slug }) => slug));
  const pages = {};
  const describe = async ({ slug, dir, data }, kind) => {
    const files = kind === "static" ? await listFiles(dir) : publishedFiles;
    // Other pages this one links to: their titles are readable by a guest.
    const linksTo = new Set();
    for (const file of files.filter((f) => f.endsWith(".html"))) {
      const html = await readFile(resolve(dir, file), "utf8");
      for (const [, target] of html.matchAll(/href="(?:\.\.\/|\/|https:\/\/[^"/]+\/)([a-z0-9][a-z0-9-]*)\/?[^"]*"/g)) {
        if (target !== slug && allSlugs.has(target)) linksTo.add(target);
      }
    }
    pages[slug] = {
      kind,
      title: data.title || slug,
      project: data.project || null,
      updated: data.updated || null,
      lifecycle: data.lifecycle || "active",
      ...(data.supersededBy ? { supersededBy: data.supersededBy } : {}),
      ...(kind === "static" ? { files } : {}),
      linksTo: [...linksTo].sort(),
    };
  };
  for (const artifact of artifacts) await describe(artifact, "artifact");
  for (const artifact of staticArtifacts) await describe(artifact, "static");
  await mkdir(resolve(staging, "_share"), { recursive: true });
  for (const name of await readdir(resolve(skillDir, "assets/share-screen"))) {
    await cp(resolve(skillDir, "assets/share-screen", name), resolve(staging, "_share", name));
  }
  // With comments on, each page may fetch its own comments and nothing else:
  // connect-src names /<slug>/_comments/ (one placeholder rule rather than one
  // per page, which would pass Pages' 100-rule limit), never 'self', so no
  // page script can reach /_share/api or another page's comments. Later rules
  // detach it again for notes, hubs, /_share/ and static artifacts, which keep
  // connect-src 'none'. A placeholder can only name a real page when it's
  // a slug; any other top-level path (say /;/, which would cut the source
  // down to the whole host) is a 404, and 404.html pins connect-src 'none'
  // with its own meta policy. COOP keeps a static page or a /_link/ view
  // (neither sends it) from opening a page and scripting it, which would
  // borrow that page's comments path; static pages drop it below.
  const commentsHeaders = comments
    ? `
/:slug/*
  ! Content-Security-Policy
  Content-Security-Policy: ${ARTIFACT_CSP.replace("connect-src 'none'", `connect-src https://${sharing.hostname}/:slug/_comments/`)}
  Cross-Origin-Opener-Policy: same-origin

/notes/*
  ! Content-Security-Policy
  Content-Security-Policy: ${ARTIFACT_CSP}

/projects/*
  ! Content-Security-Policy
  Content-Security-Policy: ${ARTIFACT_CSP}
`
    : "";
  // The Share screen is the one page allowed to make requests (to its own
  // helper). COOP severs any other page's handle on a /_share/ window it
  // opens, so a script elsewhere on the site can't drive it: its value
  // differs from every other page's (pages send same-origin, static pages
  // and /_link/ views none), and a mismatch is what cuts the opener. The
  // pages' rule matches /_share/* too, so detach that first — Pages would
  // otherwise join the two into one invalid value, which browsers ignore.
  const headersPath = resolve(staging, "_headers");
  await writeFile(
    headersPath,
    (await readFile(headersPath, "utf8")) +
      commentsHeaders +
      `
/_share/*
  ! Content-Security-Policy
  ! Cross-Origin-Opener-Policy
  Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'
  Cross-Origin-Opener-Policy: same-origin-allow-popups
  Cache-Control: no-store
`,
    "utf8",
  );
  await writeFile(resolve(staging, "_share/pages.json"), JSON.stringify({ pages }, null, 2) + "\n", "utf8");

  // Every pipeline artifact page (never a static one: those run arbitrary
  // JavaScript) gets, in the staged copy only, meta tags naming the site and
  // its source root for interactive.js. With comments on, each also gets a
  // manifest the worker reads — the anchors a thread may point at — and the
  // meta tag that turns on the server part of the comment layer.
  if (comments) await mkdir(resolve(staging, "_share/comments"), { recursive: true });
  for (const artifact of artifacts) {
    const pagePath = resolve(staging, artifact.slug, "index.html");
    const html = await readFile(pagePath, "utf8");
    let meta = `<meta name="hub-site" content="${esc(siteName)}">`;
    if (sharing.sourceRoot) meta += `<meta name="hub-source-root" content="${esc(sharing.sourceRoot)}">`;
    if (comments) {
      const anchors = [...new Set([...html.matchAll(/\sdata-anchor="([^"]*)"/g)].map(([, a]) => unescapeAttr(a)))].sort();
      commentPages.set(artifact.slug, { anchors });
      await writeFile(resolve(staging, "_share/comments", `${artifact.slug}.json`), JSON.stringify({ anchors }) + "\n", "utf8");
      meta += `<meta name="hub-comments" content="https://${esc(sharing.hostname)}/${esc(artifact.slug)}/_comments/">`;
    }
    const at = html.toLowerCase().indexOf("</head>");
    if (at < 0) throw new Error(`${artifact.slug}/index.html has no </head>`);
    await writeFile(pagePath, html.slice(0, at) + meta + html.slice(at), "utf8");
  }

  // A Share button on each page, added to the *staged* copy only (after the
  // validated bytes were checked), so the source page, its gist builds and its
  // Markdown twin stay untouched. It opens the Share screen on that page; only
  // the owner gets past it (guests who click it just meet the login). Hidden
  // when the page is viewed through a /_link/ secret link.
  for (const slug of Object.keys(pages)) {
    const pagePath = resolve(staging, slug, "index.html");
    const html = await readFile(pagePath, "utf8").catch(() => null);
    if (html === null) continue;
    const button =
      `<a id="hub-share-button" href="/_share/#${esc(slug)}" title="Share this page (only ${esc(sharing.ownerName || "the owner")} can open the Share screen)" ` +
      `style="position:fixed;right:16px;bottom:16px;z-index:2147483647;font:600 13px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;` +
      `padding:9px 14px;border-radius:999px;background:#1f2937;color:#fff;text-decoration:none;opacity:.85;box-shadow:0 2px 8px rgba(0,0,0,.25)">Share</a>` +
      `<script>if(location.pathname.indexOf("/_link/")===0){var b=document.getElementById("hub-share-button");if(b)b.remove();}</script>`;
    const at = html.toLowerCase().lastIndexOf("</body>");
    await writeFile(pagePath, at < 0 ? html + button : html.slice(0, at) + button + html.slice(at), "utf8");
  }
}

function unescapeAttr(value) {
  return value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

// The root CSP assumes self-contained single-file artifacts: no subresources,
// no framing. A static artifact is a multi-file site — its pages load their own
// same-origin CSS and frame their own same-origin pages — so relax exactly
// that, per static path: everything stays same-origin and connect-src stays
// 'none', so a static page still cannot exfiltrate anything.
if (staticArtifacts.length) {
  const overrides = staticArtifacts
    .map(
      (artifact) => `
/${artifact.slug}/*
  ! Content-Security-Policy
  ! Cross-Origin-Opener-Policy
  Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-src 'self'; frame-ancestors 'self'; form-action 'none'
`,
    )
    .join("");
  const headersPath = resolve(staging, "_headers");
  await writeFile(
    headersPath,
    (await readFile(headersPath, "utf8")) + overrides,
    "utf8",
  );
}

const siteBase = `https://${args.project}.pages.dev`;

// Every generated path is built from validated names (URL-safe note path
// segments, slugified hub names); this is the backstop that keeps a write
// inside the staging directory regardless.
function stagedPath(relativePath) {
  const target = resolve(staging, relativePath);
  if (!target.startsWith(staging + sep)) throw new Error(`Refusing to stage outside the site: ${relativePath}`);
  return target;
}

// Notes ship twice: the Markdown byte-for-byte (for agents) and a rendered
// page (for people).
for (const note of notes) {
  const { fields, body } = note.parsed;
  const resolveRelative = siteLinkResolver({ id: note.id, pageDir: notePageDir(note.id), site });
  const rawDest = stagedPath(noteRawPath(note.id));
  const pageDest = stagedPath(`${notePageDir(note.id)}index.html`);
  await mkdir(dirname(rawDest), { recursive: true });
  await writeFile(rawDest, note.shipped);
  await mkdir(dirname(pageDest), { recursive: true });
  await writeFile(pageDest, renderNotePage({ id: note.id, fields, body, resolveRelative, today }), "utf8");
}

for (const hub of hubs) {
  const pageDir = `projects/${hub.slug}/`;
  const { status } = orderHubEntries(hub);
  // The status note is rendered into the hub itself, so its links are
  // re-resolved relative to the hub page rather than the note page.
  const statusHtml = status
    ? renderMarkdownHtml(status.body, {
        headingBase: 3,
        resolveRelative: siteLinkResolver({ id: status.id, pageDir, site }),
      }).html
    : "";
  await mkdir(stagedPath(pageDir), { recursive: true });
  await writeFile(
    stagedPath(`${pageDir}index.html`),
    renderHubPage(hub, { statusHtml, published: publishedSlugs, today }),
    "utf8",
  );
  await writeFile(stagedPath(`${pageDir}index.md`), renderHubMarkdown(hub, { siteBase }), "utf8");
}

await writeFile(
  resolve(staging, "index.html"),
  renderIndex(siteEntries, hubs),
  "utf8",
);

// The machine-readable registry. Generated on every publish, never
// hand-maintained — anything hand-maintained here would drift from the root.
// Agents fetch /index.json to discover documents, then read each entry's
// markdownUrl; entries whose lifecycle is superseded or archived are kept
// listed (their pages stay up) but should be skipped for current state. Notes
// share the list (kind "note") so one fetch finds everything.
const registryEntries = [...siteEntries]
  .sort((a, b) =>
    String(b.data.updated || "").localeCompare(String(a.data.updated || "")),
  )
  .map(({ kind, slug, path, markdownPath, jsonPath, noteKind, data }) => ({
    slug,
    kind,
    title: data.title || slug,
    project: data.project ?? null,
    ...(kind === "note" ? { noteKind } : {}),
    lifecycle: data.lifecycle ?? "active",
    status: data.status ?? null,
    updated: data.updated ?? null,
    summary: data.summary ?? null,
    tags: Array.isArray(data.tags) ? data.tags : [],
    url: `${siteBase}/${path}`,
    // Static artifacts have no generated Markdown/JSON twins; notes have no JSON.
    markdownUrl: markdownPath ? `${siteBase}/${markdownPath}` : null,
    jsonUrl: jsonPath ? `${siteBase}/${jsonPath}` : null,
    // Only name a replacement this site actually serves.
    ...(data.supersededBy && publishedSlugs.has(data.supersededBy)
      ? { supersededBy: data.supersededBy }
      : {}),
  }));
await writeFile(
  resolve(staging, "index.json"),
  JSON.stringify(
    {
      generated: new Date().toISOString(),
      site: siteBase,
      artifacts: registryEntries,
      hubs: hubs.map((hub) => ({
        project: hub.project,
        url: `${siteBase}/projects/${hub.slug}/`,
        markdownUrl: `${siteBase}/projects/${hub.slug}/index.md`,
      })),
    },
    null,
    2,
  ) + "\n",
  "utf8",
);

await writeFile(
  resolve(staging, "llms.txt"),
  `# ${args.project} artifacts

This site hosts durable project artifacts: implementation plans, decisions,
reports, and briefs. Each lives at /<slug>/ as a rendered page for humans, with
a token-efficient Markdown twin at /<slug>/artifact.md and lossless source at
/<slug>/artifact.json — agents should read the Markdown, not the page. The
machine-readable registry at ${siteBase}/index.json lists every published
artifact with slug, title, project, lifecycle, updated date, and summary.
Ignore entries whose lifecycle is "superseded" or "archived"; they are kept
online for history only, and superseded entries name their replacement in
supersededBy.
${
  notes.length
    ? `
Notes are short living documents (project status, references, people, a
glossary), rewritten in place so they are always current: the Markdown is at
/notes/<path>.md and the page at /notes/<path>/. Registry entries for notes
have kind "note".
`
    : ""
}
Each project has a hub page at /projects/<project>/ and a compact agent index
at /projects/<project>/index.md (status note first, one line per entry) —
start there when working on one project.

- Registry: ${siteBase}/index.json
- Index page: ${siteBase}/
${hubs.map((hub) => `- ${hub.project} hub: ${siteBase}/projects/${hub.slug}/index.md\n`).join("")}`,
  "utf8",
);

console.log(
  `Staged ${artifacts.length + staticArtifacts.length} artifact(s)${notes.length ? `, ${notes.length} note(s)` : ""} and ${hubs.length} project hub(s) from ${root}`,
);
for (const artifact of artifacts) console.log(`  /${artifact.slug}/`);
for (const artifact of staticArtifacts)
  console.log(`  /${artifact.slug}/ (static, whole directory)`);
for (const note of notes) console.log(`  /${notePageDir(note.id)} (note)`);
for (const hub of hubs) console.log(`  /projects/${hub.slug}/ (hub)`);

// ---- deploy -----------------------------------------------------------------

// A durable root should be recoverable; publishing an untracked one still
// works, but the operator should know they are one `rm -rf` from a frozen site.
try {
  await run("git", ["-C", requestedRoot, "rev-parse", "--is-inside-work-tree"], {
    quiet: true,
  });
} catch {
  console.warn(
    `WARN: ${requestedRoot} is not under version control — losing it means losing the ability to update this site.`,
  );
}

// Everything above — discovery, filtering, validation, staging — ran exactly
// as a real publish would; nothing below touches Cloudflare. The staged tree
// is kept for inspection.
if (args.dryRun) {
  console.log(`Dry run: staged site at ${staging} (nothing deployed; project check, Access probe and upload skipped)`);
  process.exit(0);
}

// One project per audience, not per document. Deploying to a name that does not
// exist yet would silently mint a new site, which is how one-off projects
// accumulate — require the intent to be explicit.
const projectListing = await capture("npx", [
  "wrangler",
  "pages",
  "project",
  "list",
  "--json",
]);
const jsonStart = projectListing.indexOf("[");
if (jsonStart < 0)
  throw new Error(
    "Could not parse `wrangler pages project list --json` output",
  );
const projectExists = JSON.parse(projectListing.slice(jsonStart)).some(
  (project) => project["Project Name"] === args.project,
);
if (!projectExists) {
  if (!args.newProject) {
    throw new Error(
      `Pages project "${args.project}" does not exist. Prefer publishing into an existing ` +
        "per-audience project; pass --new-project only with explicit authorization to create a new site.",
    );
  }
  console.log(
    `Creating new Pages project ${args.project} (production branch ${args.branch})`,
  );
  await run("npx", [
    "wrangler",
    "pages",
    "project",
    "create",
    args.project,
    "--production-branch",
    args.branch,
    // wrangler 4.13x+ otherwise delegates to Workers and fails on a Direct
    // Upload project ("Missing entry-point"); --force creates it on Pages.
    "--force",
  ]);
}

// A site meant to sit behind Cloudflare Access must already be behind it before
// anything private is uploaded: Pages serves a deployment the moment it lands.
// Check the production hostname and an arbitrary subdomain (deployment hash and
// branch aliases live at *.<project>.pages.dev) and refuse unless both answer
// with a redirect to the Access login.
if (args.requireAccess) {
  const probes = [
    `https://${args.project}.pages.dev/`,
    `https://access-probe-${Date.now().toString(36)}.${args.project}.pages.dev/`,
  ];
  for (const url of probes) {
    let response;
    try {
      response = await fetch(url, { redirect: "manual" });
    } catch (error) {
      throw new Error(`--require-access: could not reach ${url}: ${error.message}`);
    }
    const location = response.headers.get("location") || "";
    if (!(response.status >= 300 && response.status < 400 && /^https:\/\/[^/]+\.cloudflareaccess\.com\//.test(location))) {
      throw new Error(
        `--require-access: ${url} answered ${response.status} without redirecting to Cloudflare Access — ` +
          "refusing to publish. Protect the project (production hostname and *.<project>.pages.dev) first.",
      );
    }
  }
  console.log(`Access check passed: ${args.project}.pages.dev and its subdomains redirect to the Access login`);
}

// Per-page sharing fails closed: every Access rule touching the site must be
// one of the known shapes, and no rule or link code may point at a page this
// publish doesn't include (a later page with that name would inherit it).
let sharedSlugs = [];
let linkRulePresent = false;
let siteAud = null;
if (sharing) {
  const { accessClient, accessToken, auditSite } = await import("./sharing.mjs");
  const client = accessClient(sharing, await accessToken());
  const stagedTop = (await readdir(staging)).filter((name) => !["_worker.js", "_routes.json", "_headers"].includes(name));
  const { problems, pages, links, link, site: siteApp } = await auditSite({
    config: sharing,
    client,
    publishedSlugs: publishedSlugs,
    allPaths: [...stagedTop, "_link"],
  });
  if (problems.length) {
    throw new Error(`Access audit failed — refusing to publish:\n${problems.map((p) => `  ${p}`).join("\n")}\nFix with share.mjs (unshare / unlink) and re-run.`);
  }
  linkRulePresent = Boolean(link);
  siteAud = siteApp.aud;
  // A shared page's own Access rule covers /<slug>/_comments/ with its own
  // audience; the worker accepts that one too (and looks up rules made after
  // this publish).
  for (const [slug, { app }] of pages) {
    if (!commentPages.has(slug) || !app.aud) continue;
    await writeFile(resolve(staging, "_share/comments", `${slug}.json`), JSON.stringify({ ...commentPages.get(slug), aud: app.aud }) + "\n", "utf8");
  }
  sharedSlugs = [...new Set([...pages.keys(), ...links.map((l) => l.slug)])].sort();
  console.log(
    `Access audit passed: ${pages.size} page rule(s), ${links.length} link(s), /_link rule ${link ? "present" : "absent"}`,
  );
  // Comment threads follow the same rule as page rules and links: none may sit
  // on a page this publish doesn't include, or a new page with that name would
  // show them. `comments.mjs prune --confirm` archives them.
  if (comments) {
    const { orphanedThreadSlugs } = await import("./d1.mjs");
    const orphans = await orphanedThreadSlugs(sharing, new Set(artifacts.map(({ slug }) => slug)));
    if (orphans.length) {
      throw new Error(
        `Comments audit failed — refusing to publish:\n${orphans.map((o) => `  /${o.slug}/ has ${o.threads} thread(s) but is not a published page`).join("\n")}\n` +
          "Archive them with comments.mjs --root <root> prune --confirm and re-run.",
      );
    }
    console.log("Comments audit passed: every thread is on a published page");
  }
  if (sharedSlugs.length) {
    console.log(`Shared pages in this publish (their guests see these edits): ${sharedSlugs.map((s) => `/${s}/`).join(" ")}`);
  }
}

console.log(`Publishing to ${args.project} on branch ${args.branch}`);
// wrangler reads bindings from a wrangler.toml in its working directory, and a
// Pages project deployed with one takes its bindings from it. So a sharing
// deploy runs from a scratch directory holding just that file (the KV binding
// for link codes); other deploys run as before, with no config file.
let deployCwd;
if (sharing) {
  deployCwd = await scratchDir("artifact-deploy-");
  await writeFile(
    resolve(deployCwd, "wrangler.toml"),
    `name = "${args.project}"
pages_build_output_dir = "${staging}"
compatibility_date = "2026-09-01"

[[kv_namespaces]]
binding = "LINKS"
id = "${sharing.kvNamespaceId}"

${
  sharing.d1DatabaseId
    ? `[[d1_databases]]
binding = "COMMENTS"
database_name = "${args.project}-comments"
database_id = "${sharing.d1DatabaseId}"

`
    : ""
}[vars]
HOST = "${sharing.hostname}"
OWNER = "${sharing.owner}"
${sharing.ownerName ? `OWNER_NAME = ${JSON.stringify(sharing.ownerName)}\n` : ""}ACCOUNT_ID = "${sharing.accountId}"
TEAM_DOMAIN = "${sharing.teamDomain}"
SITE_AUD = "${siteAud}"
`,
    "utf8",
  );
}
await run(
  "npx",
  ["wrangler", "pages", "deploy", staging, "--project-name", args.project, "--branch", args.branch],
  { cwd: deployCwd },
);

// The revoker Worker runs the follow-up sign-outs that removing a guest queues
// (see assets/revoker-worker/). No route and no workers.dev address: it only
// has a once-a-minute cron. Redeployed with every publish so it never drifts
// from access.mjs. Its ACCESS_API_TOKEN secret is set once, by hand.
if (sharing && args.branch === "main") {
  const revokerDir = await scratchDir("artifact-revoker-");
  await cp(resolve(skillDir, "assets/revoker-worker/index.js"), resolve(revokerDir, "index.js"));
  await cp(resolve(skillDir, "assets/pages-worker/access.mjs"), resolve(revokerDir, "access.mjs"));
  await writeFile(
    resolve(revokerDir, "wrangler.toml"),
    `name = "${args.project}-revoker"
main = "index.js"
compatibility_date = "2026-09-01"
workers_dev = false
preview_urls = false

[triggers]
crons = ["* * * * *"]

[[kv_namespaces]]
binding = "LINKS"
id = "${sharing.kvNamespaceId}"

[vars]
ACCOUNT_ID = "${sharing.accountId}"
`,
    "utf8",
  );
  await run("npx", ["wrangler", "deploy"], { cwd: revokerDir });
}

// Signed out, a made-up link code must be a plain 404 from the worker: a
// static answer would mean the worker didn't deploy and /_link/ is serving
// files without a login.
if (sharing && linkRulePresent && args.branch === "main") {
  const { randomBytes } = await import("node:crypto");
  const url = `https://${sharing.hostname}/_link/${randomBytes(32).toString("base64url")}/`;
  const response = await fetch(url, { redirect: "manual" });
  const text = await response.text();
  if (!(response.status === 404 && text.startsWith("Not found. This link may have been revoked."))) {
    throw new Error(`Post-deploy check: ${url} answered ${response.status}, not the worker's 404 — check the deployment now`);
  }
  console.log("Post-deploy check passed: /_link/ is served by the worker");
}

// Signed out, a page's comments must be behind the Access login like the page.
if (comments && args.branch === "main" && artifacts.length) {
  const url = `https://${sharing.hostname}/${artifacts[0].slug}/_comments/threads`;
  const response = await fetch(url, { redirect: "manual" });
  const location = response.headers.get("location") || "";
  if (!(response.status >= 300 && response.status < 400 && /^https:\/\/[^/]+\.cloudflareaccess\.com\//.test(location))) {
    throw new Error(`Post-deploy check: ${url} answered ${response.status} without the Access login — check the deployment now`);
  }
  console.log("Post-deploy check passed: page comments are behind the Access login");
}

async function listFiles(dir, prefix = "") {
  const out = [];
  for (const entry of await readdir(resolve(dir, prefix || "."), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listFiles(dir, rel)));
    else out.push(rel);
  }
  return out.sort();
}

function artifactEntry({ slug, data }, kind) {
  return {
    kind,
    slug,
    path: `${slug}/`,
    markdownPath: kind === "artifact" ? `${slug}/artifact.md` : null,
    jsonPath: kind === "artifact" ? `${slug}/artifact.json` : null,
    data,
    title: data.title || slug,
    project: data.project || null,
    lifecycle: data.lifecycle || "active",
    updated: data.updated || null,
    summary: data.summary || null,
    supersededBy: data.supersededBy || null,
  };
}

function noteEntry(note) {
  const { fields, body } = note.parsed;
  const data = {
    title: fields.title,
    project: fields.project,
    lifecycle: "active",
    updated: fields.updated,
    summary: fields.summary || null,
  };
  return {
    kind: "note",
    slug: `notes/${note.id}`,
    id: note.id,
    path: notePageDir(note.id),
    markdownPath: noteRawPath(note.id),
    jsonPath: null,
    noteKind: fields.kind,
    body,
    data,
    title: fields.title || note.id,
    project: fields.project || null,
    lifecycle: "active",
    updated: fields.updated || null,
    summary: fields.summary || null,
    supersededBy: null,
  };
}

function renderIndex(items, hubs = []) {
  // One flat list, newest first, with client-side search and filters. Grouping
  // by project made finding one document a scroll-and-read exercise; instead
  // each entry carries a project badge and the toolbar narrows by text,
  // project, or tag. Superseded and archived entries stay published but start
  // hidden behind a toggle. Without JS the toolbar stays hidden and every
  // entry is visible (stale ones dimmed), so the page still works anywhere.
  const sorted = [...items].sort((a, b) =>
    String(b.data.updated || "").localeCompare(String(a.data.updated || "")),
  );
  const projectCounts = new Map();
  let staleCount = 0;
  for (const item of sorted) {
    const project = item.data.project || "other";
    projectCounts.set(project, (projectCounts.get(project) || 0) + 1);
    const lifecycle = item.data.lifecycle || "active";
    if (lifecycle === "superseded" || lifecycle === "archived") staleCount += 1;
  }

  const rows = sorted
    .map((item) => {
      const project = item.data.project || "other";
      const lifecycle = item.data.lifecycle || "active";
      const stale = lifecycle === "superseded" || lifecycle === "archived";
      const tags = Array.isArray(item.data.tags) ? item.data.tags : [];
      const isNote = item.kind === "note";
      const haystack = [
        item.data.title || "",
        item.slug,
        item.data.summary || "",
        project,
        item.data.status || "",
        lifecycle,
        ...tags,
        ...(isNote ? ["note", item.noteKind] : []),
      ]
        .join(" ")
        .toLowerCase();
      const badge = stale
        ? ` <em class="lifecycle">${esc(lifecycle)}${
            lifecycle === "superseded" && item.data.supersededBy && publishedSlugs.has(item.data.supersededBy)
              ? ` → <a href="./${esc(item.data.supersededBy)}/">${esc(item.data.supersededBy)}</a>`
              : ""
          }</em>`
        : "";
      const noteBadge = isNote ? ` <span class="badge note">note</span>` : "";
      const meta = isNote ? `note · ${item.noteKind}` : item.data.status || "";
      const tagMarkup = tags.length
        ? `\n        <span class="tags" hidden>${tags
            .map((tag) => `<button type="button" class="tag">${esc(tag)}</button>`)
            .join("")}</span>`
        : "";
      return `      <li${stale ? ' class="is-stale"' : ""} data-project="${esc(project)}" data-lifecycle="${esc(lifecycle)}" data-haystack="${esc(haystack)}">
        <div class="row-head">
          <a href="./${esc(item.path)}">${esc(item.data.title || item.slug)}</a>
          <span class="badge">${esc(project)}</span>${noteBadge}${badge}${
            sharing && !isNote ? ` <a class="share" href="./_share/#${esc(item.slug)}">share</a>` : ""
          }
        </div>
        <p>${esc(item.data.summary || "")}</p>
        <span class="meta">${esc(meta)}${item.data.updated ? ` · updated ${esc(item.data.updated)}` : ""}</span>${tagMarkup}
      </li>`;
    })
    .join("\n");

  const chips = [...projectCounts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([project, count]) =>
        `<button type="button" class="chip" data-project="${esc(project)}" aria-pressed="false">${esc(project)} <small>${count}</small></button>`,
    )
    .join("\n        ");

  // Hub links sit outside the JS-only toolbar so they work without script.
  const hubLinks = hubs.length
    ? `\n    <p class="hubs">Project hubs: ${hubs
        .map((hub) => `<a href="./projects/${esc(hub.slug)}/">${esc(hub.project)}</a>`)
        .join(" · ")}</p>`
    : "";
  const noteCount = items.filter((item) => item.kind === "note").length;
  const documentCount = items.length - noteCount;
  const counts = noteCount
    ? `${documentCount} published ${documentCount === 1 ? "artifact" : "artifacts"} · ${noteCount} ${noteCount === 1 ? "note" : "notes"}`
    : `${items.length} published ${items.length === 1 ? "artifact" : "artifacts"}`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow" />
    <title>Artifacts</title>
    <style>
      :root { color-scheme: light dark; }
      body {
        margin: 0 auto; padding: 48px 24px 64px; max-width: 760px;
        font: 16px/1.6 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      h1 { font-size: 1.6rem; margin-bottom: 4px; }
      .lede { opacity: 0.7; margin-top: 0; }
      .toolbar { margin-top: 24px; }
      #search {
        width: 100%; box-sizing: border-box; padding: 10px 14px;
        font: inherit; border: 1px solid rgba(128, 128, 128, 0.45);
        border-radius: 8px; background: transparent; color: inherit;
      }
      #search:focus { outline: 2px solid rgba(100, 140, 255, 0.7); outline-offset: 1px; }
      .chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; align-items: center; }
      .chip, .tag {
        font: inherit; font-size: 0.82rem; color: inherit; cursor: pointer;
        border: 1px solid rgba(128, 128, 128, 0.4); border-radius: 999px;
        background: transparent; padding: 3px 12px;
      }
      .chip small { opacity: 0.55; font-size: 0.75rem; }
      .chip:hover, .tag:hover { border-color: rgba(128, 128, 128, 0.8); }
      .chip[aria-pressed="true"] {
        border-color: currentColor;
        background: rgba(128, 128, 128, 0.16); font-weight: 600;
      }
      .stale-label { font-size: 0.82rem; opacity: 0.7; margin-left: auto; display: inline-flex; gap: 6px; align-items: center; cursor: pointer; }
      #count { font-size: 0.82rem; opacity: 0.6; display: block; margin-top: 10px; }
      ol { list-style: none; padding: 0; margin: 8px 0 0; }
      li { padding: 18px 0; border-top: 1px solid rgba(128, 128, 128, 0.3); }
      li.is-stale { opacity: 0.55; }
      .row-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 10px; }
      .row-head a { font-size: 1.05rem; font-weight: 600; text-decoration: none; }
      .row-head a:hover { text-decoration: underline; }
      .badge {
        font-size: 0.72rem; font-weight: 600; text-transform: uppercase;
        letter-spacing: 0.06em; opacity: 0.65;
        border: 1px solid rgba(128, 128, 128, 0.4); border-radius: 4px; padding: 1px 6px;
      }
      li p { margin: 6px 0; opacity: 0.8; }
      .meta { font-size: 0.85rem; opacity: 0.6; }
      .tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
      .tag { font-size: 0.75rem; padding: 1px 9px; opacity: 0.8; }
      .lifecycle { font-style: normal; font-size: 0.8rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.9; }
      .lifecycle a { font-size: 0.8rem; }
      #empty { opacity: 0.6; margin-top: 24px; }
      .hubs { margin: 8px 0 0; font-size: 0.9rem; }
      .badge.note { opacity: 0.9; border-style: dashed; }
      .row-head a.share { font-size: 0.8rem; font-weight: 400; opacity: 0.7; margin-left: auto; }
    </style>
  </head>
  <body>
    <h1>Artifacts</h1>
    <p class="lede">${counts} · <a href="./index.json">index.json</a> · <a href="./llms.txt">llms.txt</a>${sharing ? ` · <a href="./_share/">Share pages</a>` : ""}</p>${hubLinks}
    <div class="toolbar" id="toolbar" hidden>
      <input id="search" type="search" placeholder="Search title, summary, project, tag… (press /)" aria-label="Search artifacts" />
      <div class="chips">
        ${chips}
        <label class="stale-label"${staleCount ? "" : " hidden"}><input type="checkbox" id="stale-toggle" /> show superseded &amp; archived (${staleCount})</label>
      </div>
      <span id="count"></span>
    </div>
    <ol id="list">
${rows}
    </ol>
    <p id="empty" hidden>No artifacts match.</p>
    <script>
      (function () {
        var toolbar = document.getElementById("toolbar");
        var search = document.getElementById("search");
        var staleToggle = document.getElementById("stale-toggle");
        var countEl = document.getElementById("count");
        var empty = document.getElementById("empty");
        var cards = Array.prototype.slice.call(document.querySelectorAll("#list > li"));
        var chips = Array.prototype.slice.call(document.querySelectorAll(".chip"));
        var activeProject = "";

        function apply() {
          var terms = search.value.toLowerCase().split(/\\s+/).filter(Boolean);
          var showStale = staleToggle.checked;
          var shown = 0;
          cards.forEach(function (card) {
            var lifecycle = card.getAttribute("data-lifecycle");
            var stale = lifecycle === "superseded" || lifecycle === "archived";
            var haystack = card.getAttribute("data-haystack");
            var visible =
              (showStale || !stale) &&
              (!activeProject || card.getAttribute("data-project") === activeProject) &&
              terms.every(function (term) { return haystack.indexOf(term) !== -1; });
            card.hidden = !visible;
            if (visible) shown += 1;
          });
          countEl.textContent = "showing " + shown + " of " + cards.length;
          empty.hidden = shown !== 0;
          chips.forEach(function (chip) {
            chip.setAttribute("aria-pressed", String(chip.getAttribute("data-project") === activeProject));
          });
        }

        chips.forEach(function (chip) {
          chip.addEventListener("click", function () {
            var project = chip.getAttribute("data-project");
            activeProject = project === activeProject ? "" : project;
            apply();
          });
        });
        Array.prototype.forEach.call(document.querySelectorAll(".tag"), function (tag) {
          tag.addEventListener("click", function () {
            search.value = tag.textContent;
            apply();
          });
        });
        search.addEventListener("input", apply);
        staleToggle.addEventListener("change", apply);
        document.addEventListener("keydown", function (event) {
          if (event.key === "/" && document.activeElement !== search) {
            event.preventDefault();
            search.focus();
          } else if (event.key === "Escape" && document.activeElement === search) {
            search.value = "";
            apply();
            search.blur();
          }
        });

        Array.prototype.forEach.call(document.querySelectorAll(".tags"), function (tagsRow) {
          tagsRow.hidden = false;
        });
        toolbar.hidden = false;
        apply();
      })();
    </script>
  </body>
</html>
`;
}

// Returns the directory to publish from: the root itself when it is not in a
// git work tree, otherwise a fresh extract of HEAD's copy of the root. Always
// snapshotting (not only when dirty) means a file another session edits while
// this publish runs can't slip in either. `git archive` only reads the object
// store, so it takes no index lock and cannot race other sessions' commits.
async function snapshotHead(dir) {
  let top, prefix;
  try {
    [top, prefix] = (
      await capture("git", ["-C", dir, "rev-parse", "--show-toplevel", "--show-prefix"], { quietErrors: true })
    ).split("\n");
  } catch {
    return dir; // not a git work tree
  }
  const tree = `HEAD:${prefix}`;

  // git archive succeeds while silently dropping submodule contents and
  // exporting Git LFS pointer files, and an extracted symlink that points out
  // of the snapshot would read the live checkout again. Refuse all three
  // rather than deploy a quietly different site.
  const entries = (await capture("git", ["-C", top, "ls-tree", "-r", "-z", tree]))
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const [meta, path] = line.split("\t");
      const [mode, , oid] = meta.split(" ");
      return { mode, oid, path };
    });
  const refuse = (why) => {
    throw new Error(`${why} — can't publish a snapshot of ${tree}; pass --working-tree to publish the files on disk`);
  };
  for (const { mode, oid, path } of entries) {
    if (mode === "160000") refuse(`${path} is a git submodule`);
    if (mode === "120000") {
      const target = (await capture("git", ["-C", top, "cat-file", "-p", oid])).trim();
      const landing = posix.normalize(posix.join(posix.dirname(path), target));
      if (target.startsWith("/") || landing === ".." || landing.startsWith("../")) {
        refuse(`symlink ${path} -> ${target} points outside the root`);
      }
    }
  }
  const attributeFiles = entries.filter(({ path }) => posix.basename(path) === ".gitattributes");
  const rootAttributes = await capture("git", ["-C", top, "show", "HEAD:.gitattributes"], { quietErrors: true }).catch(
    () => "",
  );
  for (const text of [
    rootAttributes,
    ...(await Promise.all(attributeFiles.map(({ oid }) => capture("git", ["-C", top, "cat-file", "-p", oid])))),
  ]) {
    if (/filter=lfs/.test(text)) refuse("the root uses Git LFS");
  }

  const dirty = (
    await capture("git", ["-C", dir, "status", "--porcelain", "--untracked-files=all", "--", "."])
  )
    .split("\n")
    .filter(Boolean);
  const head = (await capture("git", ["-C", dir, "rev-parse", "--short", "HEAD"])).trim();
  const snapshot = await scratchDir("artifact-snapshot-");
  await new Promise((resolvePromise, rejectPromise) => {
    // Run from the top level: in a subdirectory, git archive filters the tree
    // to paths under the current directory and would extract nothing.
    const archive = spawn("git", ["-C", top, "archive", "--format=tar", tree], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    const tar = spawn("tar", ["-x", "-f", "-", "-C", snapshot], {
      stdio: ["pipe", "inherit", "inherit"],
    });
    archive.stdout.pipe(tar.stdin);
    let pending = 2;
    const done = (name) => (code, signal) => {
      if (code !== 0) rejectPromise(new Error(`${name} exited with ${code ?? signal}`));
      else if (--pending === 0) resolvePromise();
    };
    archive.on("error", rejectPromise);
    tar.on("error", rejectPromise);
    archive.on("exit", done("git archive"));
    tar.on("exit", done("tar"));
  });
  if (dirty.length) {
    const shown = dirty.slice(0, 8).map((line) => `  ${line}`).join("\n");
    const more = dirty.length > 8 ? `\n  …and ${dirty.length - 8} more` : "";
    console.warn(
      `NOTE: ${dir} has ${dirty.length} uncommitted change(s), left out of this publish of the last commit (${head}):\n` +
        `${shown}${more}\n` +
        "Commit your own changes before publishing, or pass --working-tree to publish the files on disk.",
    );
  } else {
    console.log(`Publishing the last commit (${head}) of ${dir}`);
  }
  return snapshot;
}

function capture(command, commandArgs, { quietErrors = false } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, commandArgs, {
      stdio: ["ignore", "pipe", quietErrors ? "ignore" : "inherit"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", rejectPromise);
    child.on("exit", (code, signal) => {
      if (code === 0) resolvePromise(output);
      else rejectPromise(new Error(`${command} exited with ${code ?? signal}`));
    });
  });
}

function run(command, commandArgs, { quiet = false, cwd } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    // stdin stays closed so a wrangler prompt (e.g. "create this project?")
    // fails fast instead of waiting for, or defaulting through, interactive input.
    const child = spawn(command, commandArgs, {
      stdio: quiet ? "ignore" : ["ignore", "inherit", "inherit"],
      cwd,
    });
    child.on("error", rejectPromise);
    child.on("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${command} exited with ${code ?? signal}`));
    });
  });
}
