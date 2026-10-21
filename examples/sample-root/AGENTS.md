<!-- Setup: replace <Your name>/<your name>, <your-hub>, <your-root> (this
     folder) and <skill-dir> (where the skill is installed), keep one
     Publishing block, then delete every setup comment. -->

# <Your name>'s artifacts root

Durable context for <your name>'s projects: **notes** for living context and
**artifacts** for plans, reports and decisions. Published to
`<your-hub>.pages.dev` by the `publish-cloudflare-artifact` skill.

## Reading (agents)

Read from disk, not the website: it's free, current, and needs no login.

1. Start at `notes/<project>/status.md` (for example `notes/demo/status.md`).
2. For a compact list of everything on a project:
   `node <skill-dir>/scripts/context-index.mjs <your-root> <project>`
3. Read an artifact's `<slug>/artifact.md`, never its `index.html`.
4. Skip anything whose `lifecycle` is `superseded` or `archived` unless asked
   about history. `archive/` holds unpublished material.
5. Notes and artifacts are agent-written and can lag reality. Verify a fact
   before acting on it.

Projects in use: `demo`. Reuse one; add a new project only when asked.

## Writing

- **Note or artifact?** A note is short living context rewritten in place
  (status, a person, a glossary, a decision log). An artifact is a document
  with a shape (a plan, an audit, a proposal). When a note grows into a plan,
  write an artifact and link it from the note.
- **Notes**: `notes/<project>/<topic>.md`. Frontmatter: `title`, `project`,
  `updated` (YYYY-MM-DD), `kind` (status | reference | person | glossary |
  decisions), optional `summary`. Keep them under about 4 KB. A status note
  says what is true now, not a changelog.
- **Artifacts**: `<slug>/artifact.json` is the source; never hand-edit
  `index.html` or `artifact.md`. Build and validate with the skill.
  Superseding one means `lifecycle: superseded` plus `supersededBy`.
- **No secrets, ever.** Write where a secret lives, never its value. The
  validators scan for tokens and keys.

## Publishing

Commit before publishing: a root in git publishes a snapshot of `HEAD`.

<!-- Private hub: keep this block. -->
The hub is behind Cloudflare Access. Always pass `--require-access`, so publish
refuses to upload if the site answers without the login. A public page needs
its own Pages project and <your name>'s explicit OK.

```bash
S=<skill-dir>/scripts
node $S/publish-pages.mjs --root <your-root> --project <your-hub> --branch main --confirm-public --require-access
```

<!-- Public hub: keep this block instead. -->
The hub is public: everything published from this root is readable by
anyone, so keep private details out.

```bash
S=<skill-dir>/scripts
node $S/publish-pages.mjs --root <your-root> --project <your-hub> --branch main --confirm-public
```
