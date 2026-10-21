# Script reference

- `scripts/create-artifact.mjs`: safe scaffold command (refuses non-empty targets).
- `scripts/build-artifact.mjs`: renders the self-contained HTML and Markdown twin.
- `scripts/render.mjs`: build-time HTML and Markdown renderers, plus
  `resolveScript` (local `interactive.js` or the template) shared by the build
  and the validator.
- `scripts/anchors.mjs`: stable anchor ids (`data-anchor`, `data-fp`), the
  authored-`id` checks, and a CLI that lists a page's anchors:
  `node anchors.mjs <artifact-dir>`.
- `scripts/charts.mjs`: `charts` schema validation, SVG chart renderer (three
  width variants per chart), and the Markdown tables.
- `scripts/validate-artifact.mjs`: structure (including the `charts` schema and
  authored ids),
  freshness, self-containment, and obvious-secret checks.
- `scripts/validate-notes.mjs`: note frontmatter, size, staleness, and secret
  checks (`notes.mjs`, `markdown.mjs`, `content-checks.mjs` hold the shared
  logic; `hubs.mjs` renders project hubs).
- `scripts/context-index.mjs`: offline project index for local agents.
- `scripts/serve-artifact.mjs`: local-only HTTP preview server.
- `scripts/publish-pages.mjs`: explicit-publication wrapper around Wrangler Pages.
  A root in git publishes from a `git archive` snapshot of `HEAD`, refusing
  submodules, Git LFS and symlinks that leave the root (`--working-tree`
  publishes the files on disk instead).
- `scripts/share.mjs`: per-page sharing helper (see [sharing.md](sharing.md)).
- `scripts/comments.mjs`: page comment threads for agents (list, show, reply,
  resolve, reopen, export, prune, audit); `scripts/d1.mjs` is its D1 REST
  client (see [sharing.md](sharing.md#page-comments)).
- `tests/`: `node --test <skill-dir>/tests/` — renderer sanitization, the
  per-page sharing helpers, the removed-`visibility` check, charts, and
  anchors (plus the template-script fallback and the comment layer's rules),
  the comments worker (`comments-api.test.mjs`, SQL run against node:sqlite
  via `d1-sqlite.mjs`), what publish stages for comments, and the browser
  tests for Copy feedback and threads.
