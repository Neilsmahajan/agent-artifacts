# publish-cloudflare-artifact

An agent skill for turning plans, reviews and research into polished web pages
that you publish to your own Cloudflare Pages site, then comment on so your
agent can act on the comments.

- **Agent-written pages.** The agent writes `artifact.json`, and the skill
  builds a self-contained page for people plus a Markdown twin for agents.
  Charts, notes, project hubs, a searchable index and `llms.txt` are included.
- **Feedback that finds its block.** Comment on any paragraph, card, task or
  chart row. **Copy feedback** names each block's stable anchor, so the agent
  edits the right line of `artifact.json`.
- **Comment threads (optional).** Threads saved on the site in Cloudflare D1.
  Agents list the actionable ones, edit the page, reply, resolve and
  republish. Guests you share a page with can comment too, and their text is
  fenced as untrusted until you approve it.
- **Private by default, sharing per page (optional).** The site sits behind
  one Cloudflare Access login. You can open a single page to named people, or
  to anyone with a secret link, and revoke it within a minute.
- **Free tier.** Pages, Access (Zero Trust Free), KV and D1.

It works with Claude Code, Codex and other agents that read `SKILL.md` skills.

**Demo:** [agent-artifacts-demo.pages.dev](https://agent-artifacts-demo.pages.dev/welcome/)
is the sample root, published as a public site. Try Comment, then Copy
feedback.

## Install

```bash
npx skills add Neilsmahajan/agent-artifacts
```

Or clone it into your agent's skills folder, for example
`~/.claude/skills/publish-cloudflare-artifact`. Then tell your agent:

> Set up the publish-cloudflare-artifact skill by following its SETUP.md.

The agent asks four questions (site name, folder, public or private, sharing
and comments), creates your artifacts root from `examples/sample-root`, and
does a dry run. After you OK it, the agent creates the Pages project and
publishes a demo page. If you want sharing and comments, `scripts/setup.mjs`
then creates the KV namespace and D1 database, writes the config, and walks
you through the few dashboard steps it can't do. See [SETUP.md](SETUP.md).

Requirements: Node 22+, git, a Cloudflare account. `wrangler` runs through
`npx`.

## How it works

Everything lives in one folder, your artifacts root, ideally a git repo. The
site is generated from it on every publish.

| What | Where | URL |
|---|---|---|
| Artifact: a plan, an audit, a guide | `<slug>/artifact.json` (source), plus the built `index.html` and `artifact.md` | `/<slug>/` |
| Note: a short living fact | `notes/<project>/<topic>.md`, under about 4 KB | `/notes/<project>/<topic>/` |
| Project hub | generated on publish | `/projects/<project>/` |
| Root index | generated: everything, newest first, with search and filters | `/` |
| Taken down | `archive/`, kept in git and off the site | — |

Agents on your machine never use the website. They read the root from disk,
starting at `notes/<project>/status.md` or with
`scripts/context-index.mjs <root> <project>`. That keeps context small.

## What to say to your agent

- "Make an artifact page for X": a new page, private if the site is private.
- "…and share it with alex@example.com": that page opens for that person,
  and you get the link and a ready-made message.
- "Make a link for X" or "turn off the link for X": no-login secret link on
  or off.
- "Who can see my pages?": every shared page, with its people and links.
- "Update the status note": a note rewritten in place, then republished.
- "Archive X" (hidden but reachable), "take X down" (moved to `archive/`), or
  "this replaces X" (the old page is marked superseded).
- "Handle the comments on X": the agent lists actionable threads, edits, then
  replies and resolves.
- "Give me a gist of X": a frozen copy anyone can read, via the bundled
  [share-artifact-gist](share-artifact-gist/SKILL.md) skill. That skill needs
  no Cloudflare at all.

## Who can see what (private site)

- By default a page is only for you.
- Shared with people: they sign in with a 6-digit email code, or Google if you
  set it up, and open only that page.
- Anyone with the link: a secret `/_link/<code>/` address that opens the live
  page with no login. Turning it off takes effect within about a minute.
- Notes, project hubs and the index page are never shared. Only artifact
  pages are.
- Guest lists and link codes live only in Cloudflare, never in git.
- Every publish audits the Access rules first. It refuses to upload if a rule
  is unexpected, opens more than one page, or points at a page that's gone.
- `--require-access` refuses to upload if the site answers without the login.

## Safety rails

- Nothing is published unless you ask: building and previewing never upload,
  and creating a Pages project always needs your explicit OK.
- Publish ships a snapshot of the last commit. Another session's
  half-finished edit can't ship by accident.
- The validators refuse pages that don't match their source, pages that load
  outside resources, and obvious secrets.
- Comment text only ever reaches the page as text. Each page's CSP lets its
  script reach that page's own comments endpoint and nothing else.

Sharing and comments open parts of a private site to other people. Read
[THREAT-MODEL.md](THREAT-MODEL.md) before turning them on, if it's present.

## Layout

- `SKILL.md`: what the agent reads. `references/` has the long-form detail.
- `scripts/`: build, validate, preview (`serve-artifact.mjs`), publish,
  share, comments, and `setup.mjs` for sharing and comments.
- `assets/`: the page template, the Pages worker (sharing, `/_link/`,
  comments), the revoker cron and the D1 schema.
- `examples/sample-root/`: a starter root, with an `AGENTS.md` template, two
  notes and a demo artifact.
- `tests/`: `node --test tests/`. The browser tests need Playwright and skip
  without it:
  `mkdir -p ~/.cache/publish-cloudflare-artifact-tests && cd $_ && bun add playwright && bunx playwright install chromium webkit`

## License

MIT; see [LICENSE](LICENSE). `references/frontend-design.md` is vendored from
Anthropic's frontend-design skill under the Apache License 2.0; see
[references/frontend-design-LICENSE.txt](references/frontend-design-LICENSE.txt).
