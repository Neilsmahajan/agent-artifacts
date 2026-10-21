# One project, one accumulating root; notes and hubs

Detail behind SKILL.md's publishing summary. Read it when publishing, taking an
artifact down, superseding one, adding a static site, or working with notes and
project hubs.

## One project, one accumulating root

**Cloudflare Pages replaces the entire site on every deployment.** It does not
merge an upload into the previous one. Deploying a single artifact directory to
a shared project therefore 404s every artifact published before it.

So the **root** is the unit of deployment, not the artifact:

- Keep every artifact for a given project as a subdirectory of one durable root.
  That root — not the live site — is the source of truth. Never try to
  reconstruct it by scraping what is deployed.
- `publish-pages.mjs` re-validates and re-uploads every artifact in the root on
  each publish, and generates the root `index.html` — a flat newest-first list
  with client-side search, per-`project` filter chips, clickable `tags`, and
  superseded/archived entries hidden behind a toggle (all entries visible,
  stale ones dimmed, when JS is unavailable) — plus two registry files:
  `index.json` (slug, kind — `artifact`, `static` or `note` — title, project,
  lifecycle, updated, summary, tags, Markdown and JSON URLs, supersededBy, plus
  a `hubs` list) and `llms.txt` (a paragraph explaining the system plus the
  registry and hub URLs). Never hand-maintain any of these — they are
  regenerated on every publish, and it also ships a real `404.html` so bogus
  paths return 404 instead of the index.
- To take an artifact down, move its directory into `archive/` at the repo
  root — never delete it. `publish-pages.mjs` skips `archive/`, so the next
  publish drops it from the live site while git keeps it recoverable.
- When a new artifact replaces an old one, set the old artifact's
  `lifecycle: "superseded"` and `supersededBy: "<new-slug>"`, rebuild it, and
  ship both in the same publish — never leave a replaced plan looking live.
- A hand-built static site (a gallery, a multi-page microsite) can join the
  root without the pipeline: add a `static-artifact.json` marker with `title`,
  `summary`, `status`, `updated`. The whole directory then ships verbatim (no
  validator, no three-file whitelist — the marker is the explicit opt-in), it
  appears in the root index, and its path gets a same-origin CSP override so
  its own stylesheets and iframes work; `connect-src` stays `'none'`, so it
  still cannot phone home. Directories with neither marker are skipped loudly.
- Use one Pages project per _audience or project_, not per document (see
  [first-deploy.md](first-deploy.md) for new-project rules).
- If the root is not under version control, say so before publishing: losing it
  means losing the ability to update anything already published.

## Root choice details

Prefer `<project>/artifacts/` when a project is in scope; otherwise use the
owner's default root named in their instructions (`<your-root>`, published to
`<your-hub>`; see [sharing.md](sharing.md)) — do not invent a new root or
project.
Each artifact is a `<slug>/` directory inside it. The root must be durable:
never `/tmp`, `~/tmp`, or a session-scoped output folder (`publish-pages.mjs`
refuses temp roots). To publish an artifact authored elsewhere, copy its
directory into the durable root rather than staging a throwaway root around it.

## Build outputs deploy together

Because the content is pre-rendered rather than fetched at runtime, one URL
works for everyone. All three built files deploy together, and the page links to
its own siblings (`<link rel="alternate">` in the head, footer links), so an
agent handed only the page URL can discover the cheap representations.

## Notes: rendering and hubs

- Never build notes: nothing generated is committed beside them. Publishing
  renders each into `/notes/<path>/` (page) and ships `/notes/<path>.md`
  as-is, except that links to anything the site does not publish are reduced
  to their text in both. Only `.md` files that open with a `---` frontmatter
  line are notes; other files under `notes/` are skipped with a warning.
- `publish-pages.mjs` runs the same checks as `validate-notes.mjs` on every
  note it ships. The artifact validator's secret patterns run on notes, and
  status notes older than 60 days warn.
- Link relative to the `.md` file (`../people/alex.md`, `../../<slug>/`), so
  links work on disk and on the site. Raw HTML is escaped; only http(s),
  mailto, relative, and `#` links survive.

Every project with a published entry gets a hub at `/projects/<project>/` —
the status note rendered first, other notes grouped by kind, live artifacts
newest first, superseded/archived collapsed — plus `/projects/<project>/index.md`,
one line per entry, for agents. The root index links the hubs and lists
notes with a "note" badge. `notes` and `projects` are reserved: an artifact
with either slug fails the publish, as do two spellings of one project that
map to the same hub URL.

## Copy-for-agent state

Check-off state is saved per browser, keyed by a signature of the task titles;
a rebuild that renames, adds, or reorders tasks drops stale saved state rather
than applying it to the wrong task. The state is local to each reader and does
not change what anyone else sees. The Copy button stays hidden until the inline
script has wired it, and if every clipboard path fails the payload is shown on
screen for manual selection.

Comment-mode notes are saved the same way: per browser, under
`artifact-notes:<slug>`, until the reader clears them. They hold the anchor,
its fingerprint and a quote, so a note written before a rebuild is flagged as
outdated (fingerprint changed) or orphaned (anchor gone) in the copied block
rather than silently pointing at the wrong text.
