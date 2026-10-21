---
name: share-artifact-gist
description: Publish a document, plan, report, or Claude artifact as a GitHub gist that both people and other AI agents can read, returning a rendered URL for humans and a raw URL for agents. Use when asked to share something with Cursor, Codex, ChatGPT, or a coworker, to hand an artifact to another agent, or to produce a shareable link for a document that is currently trapped in a chat session.
---

# Share Artifact as Gist

Turn a document into one gist that serves two audiences: a readable page for
people, and a cheap plain-text URL for other agents. No auth beyond `gh`, no
team membership, no hosting setup.

## Gists are disposable hand-offs, not storage

Route by lifetime before anything else. A document that will be referenced
again — a plan spanning threads, a decision record, anything a future agent or
coworker will be handed — belongs in the owner's canonical artifacts root (named in their instructions,
usually published to a private hub behind a Cloudflare Access login) via
[publish-cloudflare-artifact](../SKILL.md). That
store has an index, lifecycle metadata, git history, and a registry; gists
have none of that. Local agents read it from disk. A live page can be shared per page
(`share.mjs share <slug> <email>...`) or with a secret no-login link
(`share.mjs link <slug>`); a gist is the right hand-off for a frozen copy, or
for an agent that can't log in (Codex cloud, ChatGPT). Reserve a gist
for a genuine one-off hand-off that can go stale without cost. If a canonical
artifact for the content already exists, link it
(`<your-hub>.pages.dev/<slug>/`, shared per page with `share.mjs`; local agents read `<your-root>/<slug>/artifact.md`)
instead of minting a new gist.

## Pick the format first

**Markdown** is the default. It renders natively on the gist page, costs an agent
almost nothing to read, and needs no third-party proxy.

**HTML** is worth it when the content genuinely needs layout, color, structure,
or interactivity to be understood — a plan with phases and status, a comparison
table, anything with a diagram. Build it with
[publish-cloudflare-artifact](../publish-cloudflare-artifact/SKILL.md); do not
hand-write a page here.

Choosing HTML means adding a transport dependency and a Markdown twin. If the
document reads fine as Markdown, it should be Markdown.

## Markdown workflow

1. Get the source content.
   - A Claude artifact URL (`claude.ai/code/artifact/<uuid>`) is fetchable with
     WebFetch **from Claude Code only**, using the signed-in session. `curl`
     returns an empty SPA shell, and Codex and Cursor cannot reach it at all. If
     this skill is running outside Claude Code and the source is an artifact URL,
     say so and ask for the content instead of guessing.
   - A local file or pasted text needs no fetching.
2. **Reproduce code blocks verbatim.** Everything else may be reworded to read
   well as Markdown; fenced blocks may not. Paste-ready text is usually the
   entire point of the document, and a block that gets summarized, reflowed, or
   "cleaned up" is silently destroyed. Use four-backtick fences when a block
   itself contains backticks.
3. Choose a descriptive filename. It appears in the raw URL, so it tells the
   receiving agent what it is holding before it fetches:
   `implement-feature-revision-brief.md`, not `artifact.md`.
4. Create the gist:

   ```bash
   gh gist create <file>.md --desc "<one line: what this is>"
   ```

5. Report both URLs, labeled:
   - **People:** `https://gist.github.com/<user>/<id>` — renders server-side.
   - **Agents:** `https://gist.githubusercontent.com/<user>/<id>/raw/<file>.md`

## HTML workflow

A gist stores an `.html` file but will not render it: the gist page shows
syntax-highlighted source under a logged-out header, and the raw URL serves
`text/plain`. **gist.githack.com** re-serves the exact same bytes as `text/html`,
which is what makes this work.

Put **both** files in one gist:

```bash
node <cloudflare-skill>/scripts/build-artifact.mjs <artifact-dir>
node <cloudflare-skill>/scripts/validate-artifact.mjs <artifact-dir>
node <cloudflare-skill>/scripts/build-artifact.mjs <artifact-dir> \
  --out <slug>.html --markdown <slug>.md
gh gist create <slug>.html <slug>.md --desc "<one line: what this is>"
```

**Do not skip the validator.** It is the only check for leaked secrets and for a
build that has drifted from its sources, and githack applies none of the
Cloudflare `_headers` protections — a gist-hosted artifact runs with whatever the
file itself contains. Validating requires the in-directory build first, which is
why it runs before the renamed copies.

Then report three URLs, labeled:

- **People:** `https://gist.githack.com/<user>/<id>/raw/<slug>.html` — renders.
- **Agents:** `https://gist.githubusercontent.com/<user>/<id>/raw/<slug>.md`
- **Source:** `https://gist.github.com/<user>/<id>` — the gist itself, for
  editing or for anyone who would rather read the plain text.

Send agents the `.md`. The built HTML inlines its CSS and JS, which makes it
roughly twenty times larger for the same content; an agent pays for every byte.
The HTML *is* readable — the content is pre-rendered into the markup, not fetched
at runtime — so a stray agent handed the page URL still gets the whole document.
It is just the expensive way in.

The Markdown carries every field that means something, but it is a rendering, not
the source: presentation-only keys are dropped. When an agent needs the exact
structure, add `<slug>.json` to the gist and send that instead.

## What depends on githack

`gist.githack.com` is a free third-party proxy, not a GitHub feature. Before
relying on it:

- **It sees the content.** One more party than GitHub alone. For anything
  sensitive this is disqualifying on its own.
- **The `/raw/<file>` form is its rate-limited development tier.** Fine for a
  link sent to a few coworkers; not fine for something linked from a wiki, a
  README, or anything with real traffic.
- **It can go away.** Its predecessor, rawgit, shut down. Nothing about a gist
  URL guarantees the proxy in front of it keeps working.

For a link that has to stay up — a coworker-facing doc, anything referenced from
elsewhere — publish to Cloudflare Pages instead. Say which of the two you are
handing over and why, rather than presenting a githack URL as durable hosting.

## Verify before reporting

Do not report a URL you have not fetched. `gh gist create` succeeding proves
nothing about whether the links work.

```bash
GID=<id>
RAW="https://gist.githubusercontent.com/<user>/$GID/raw/<file>"
curl -sS -o /tmp/gist-raw -w 'raw: HTTP %{http_code} %{content_type}\n' "$RAW"
```

Expect `HTTP 200` and `text/plain`. For an HTML gist also check the rendered
path:

```bash
curl -sSL -o /tmp/gist-page \
  -w 'githack: HTTP %{http_code} %{content_type}\n' \
  "https://gist.githack.com/<user>/$GID/raw/<slug>.html"
```

Expect `HTTP 200` and **`text/html`**. A `text/plain` here means the page will
show source rather than render.

Then grep both files for distinctive strings from the source — a heading, an
exact line from each code block — and confirm section and table counts look
right. Conversion failures are quiet: the gist is created, the URL resolves, and
the content is subtly wrong.

If `grep` reports `Binary file ... matches` instead of a count, do not reach for
`grep -a` and move on — a built artifact is UTF-8 text, so that message means a
control character reached the output. Find it (`tr -d '\000' | wc -c` against the
raw size) before publishing.

Run this without ambient credentials, so the check reflects what a recipient
sees. `env -u` can fail under a sandbox; a subshell works either way:

```bash
(unset GITHUB_TOKEN GH_TOKEN; curl -sS -w '\n%{http_code} %{content_type}\n' "$RAW" | tail -3)
```

## Privacy

`gh gist create` defaults to **secret**, which means unlisted, not private.
Anyone with the link can read it, with no GitHub account. The link is the
permission, so forwarding it grants access. githack serves secret gists too —
being unlisted protects nothing.

Before publishing, check for credentials, tokens, customer data, and private
repository detail. Say plainly what the gist exposes when the content references
private repos or internal systems, and offer to delete it when the recipient is
done. For anything that needs real access control, a gist is the wrong tool —
Cloudflare Access is the only option in this pair that can gate a reader.

## Updating and cleanup

```bash
gh gist edit <id> --add <file>       # add a file
gh gist edit <id> --filename <name>  # replace a file's content
gh gist delete <id> --yes            # remove it
gh gist list --limit 20              # find old ones
```

`/raw/<filename>` tracks the latest revision, so links keep working after an
edit. Both GitHub's raw CDN and githack cache aggressively, so a fresh edit can
take a few minutes to appear — do not conclude an edit failed from one stale
fetch. After deleting, the raw URL can still return 200 for up to five minutes;
`gh api gists/<id>` is authoritative.

When an HTML gist changes, rebuild **both** files and update both in the gist. A
gist whose `.md` and `.html` disagree hands two audiences two different
documents.

## Requirements

`gh` must be authenticated with the **`gist`** scope — `repo` alone is not
enough. Check with `gh auth status`; a session whose token lacks it (some cloud
and CI environments) cannot create gists at all, and no workaround in this skill
changes that.
