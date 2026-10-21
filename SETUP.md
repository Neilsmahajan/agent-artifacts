# Setup (for the agent)

You are setting this skill up for its owner, the person you work for. Follow
these steps in order. Run every command yourself. Stop where a step says to
ask, and never create a Cloudflare project or publish anything without the
owner's explicit OK.

`<skill-dir>` is the folder this file is in.

## 1. Check the basics

- `node --version` must be 22 or newer.
- `git --version` must work.
- `npx wrangler --version` must work. It's the Cloudflare CLI, fetched by
  `npx`, so nothing is installed globally.

If any of these fail, tell the owner what's missing and stop.

## 2. Ask the owner

Ask these in one message, with the defaults shown:

1. **Your name**: how the root's `AGENTS.md` and comment labels refer to the
   owner. Use the name you already know, if you know it.
2. **Site name**: the Cloudflare Pages project, which becomes
   `<name>.pages.dev`. It must be lowercase letters, digits and dashes, and
   unique on Pages, so suggest something like `<first-name>-hub`.
3. **Folder**: where the artifacts live on disk (default `~/artifacts`). It
   must be a durable folder, never a temp folder.
4. **Public or private**: *private* (the default) puts the whole site behind a
   Cloudflare Access login, so only the owner can open it. *Public* means
   anyone with the URL can read everything published.
5. **Sharing and comments**: should pages be shareable with named people or
   by secret link, with comment threads saved on the site? Default *not yet*.
   They need extra Cloudflare resources (KV, D1, an Access API token), and
   setting them up is a separate step (section 8).

Write the answers down as `<your-name>`, `<your-hub>` (site name),
`<your-root>` (folder, expanded to an absolute path) and the two choices.

## 3. Create the root

```bash
mkdir -p <your-root>            # must be empty or new
cp -R <skill-dir>/examples/sample-root/. <your-root>/
```

Then edit `<your-root>/AGENTS.md`:

- Replace `<Your name>` / `<your name>`, `<your-hub>`, `<your-root>` and
  `<skill-dir>`. Leave the generic `<project>`, `<slug>` and `<topic>` as
  they are.
- In Publishing, keep only the block that matches public or private.
- Delete the setup comment.

Build and validate the sample:

```bash
S=<skill-dir>/scripts
node $S/build-artifact.mjs <your-root>/welcome
node $S/validate-artifact.mjs <your-root>/welcome
node $S/validate-notes.mjs <your-root>
```

Commit it, because publish ships a snapshot of the last commit:

```bash
git -C <your-root> init -b main
git -C <your-root> add -A
git -C <your-root> commit -m "Artifacts root from the publish-cloudflare-artifact sample"
```

## 4. Tell future sessions where the root is

Append this, filled in, to the owner's global agent instructions:
`~/.claude/CLAUDE.md` for Claude Code, `~/.codex/AGENTS.md` for Codex. Create
the file if it's missing, and never overwrite what's already there. Show the
text to the owner first, since it's their file:

```markdown
Published pages (the `publish-cloudflare-artifact` skill): my default root is
`<your-root>`, published to the Pages project `<your-hub>`. Use it unless a
project in scope has its own `<project>/artifacts/`, and don't invent a new
root or project. Follow `<your-root>/AGENTS.md`.
```

For a private hub, add this as well: `Never publish this root without
--require-access; a public page needs its own project and my explicit OK.`

## 5. Dry run

```bash
S=<skill-dir>/scripts
node $S/publish-pages.mjs --root <your-root> --project <your-hub> --dry-run
```

This builds and checks everything and stages the site, but contacts nothing,
so it doesn't check Access either: `--require-access` is first tested in
step 7. It must end with `Dry run: staged site at <dir>`. Fix anything it
reports, then delete `<dir>`.

## 6. Log in to Cloudflare

```bash
npx wrangler whoami
```

If no account is listed, run `npx wrangler login`, or `npx wrangler login
--device` on a remote machine. The owner has to click Authorize in their
browser. Re-run `whoami` until an account is listed. Opening the login page
doesn't count as success.

## 7. Create the site and publish (ask first)

**Stop and ask the owner** before this step. Creating a Pages project is
outward-facing, and the name is public even when the site is private.

```bash
npx wrangler pages project create <your-hub> --production-branch main --force
```

**Private**: set up Access before the first upload. Pages serves a deployment
the moment it lands, so the login has to be in place first.

1. The owner opens Cloudflare Zero Trust from the dashboard and picks a team
   name. The free plan is enough, though signing up may ask for a payment
   method.
2. Under Access, Applications, Add an application, Self-hosted, add an
   application covering `<your-hub>.pages.dev` and
   `*.<your-hub>.pages.dev`, with one Allow policy that includes only the
   owner's email address. One-time PIN login works out of the box, and Google
   login is optional.
3. Check signed out: `curl -sI https://<your-hub>.pages.dev/` must answer with
   a redirect to `<team>.cloudflareaccess.com`. A brand-new project can answer
   404 until its first deploy, so check this again after publishing.

Then publish. `--confirm-public` is required on every upload, private or not.
It confirms you know this writes to a live site:

```bash
S=<skill-dir>/scripts
# private
node $S/publish-pages.mjs --root <your-root> --project <your-hub> --branch main --confirm-public --require-access
# public
node $S/publish-pages.mjs --root <your-root> --project <your-hub> --branch main --confirm-public
```

`--require-access` refuses to upload unless the site and a random subdomain
both redirect to the Access login. If it refuses, fix Access. Never drop the
flag to get past it.

Open `https://<your-hub>.pages.dev/welcome/` (the owner signs in if the site is
private) and tell the owner it's live.

## 8. Sharing and comments (optional)

These are scripted in a later release. Until then, set them up by hand from
[references/sharing.md](references/sharing.md), and only if the owner said
yes in step 2. In outline:

- a Workers KV namespace for link codes, plus `<your-root>/sharing.config.json`
  (`project`, `hostname`, `accountId`, `kvNamespaceId`, `teamDomain`, `owner`,
  and optionally `ownerName`, `siteName` and `sourceRoot`)
- an Access-only API token: in the macOS Keychain as `cf-access-share-mac`, or
  as `CF_ACCESS_TOKEN`, and as the Pages secret `ACCESS_API_TOKEN`
- `node $S/share.mjs --root <your-root> setup-link-rule`, once, for secret links
- for comments, a D1 database `<your-hub>-comments` with
  `assets/comments/schema.sql` applied, and its id as `d1DatabaseId` in the
  config

Read [THREAT-MODEL.md](THREAT-MODEL.md), if it's present, before turning
these on: they open parts of a private site to other people.

## Done

Tell the owner:

- the site URL, and whether it's public or private
- the root folder, and that it's a git repo, so pushing it to a private remote
  keeps a backup
- a first thing to ask for, such as "Make an artifact page for <topic>"
