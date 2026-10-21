# Authentication, new projects, and branches

Read this when wrangler is not logged in, when a new Pages project is being
considered, or when choosing a branch.

## Authentication

Check with `npx wrangler whoami`. If not logged in, log in and wait for the
user to finish Authorize in the browser:

- Prefer `npx wrangler login --device` in remote/agent environments (prints a
  code + URL; first-time use always needs a human click).
- `npx wrangler login` (browser callback) is fine on a local desktop when the
  callback host is reachable.
- Do not treat "opened the login page" as success; re-run `whoami` until an
  account is listed.

## New projects

`publish-pages.mjs` checks that the target project already exists and refuses
to create one implicitly. Pass `--new-project` only with explicit user
authorization for a new site, and say why an existing project does not fit.

Use one Pages project per _audience or project_, not per document. A new
project per artifact leaves untracked one-off sites behind. The owner's
default (`<your-root>` → `<your-hub>`) comes from their instructions; publish
there unless the artifact belongs to a specific project's own root.

For a new Direct Upload project, create it only after explicit publishing
authorization:

```bash
npx wrangler pages project create <project-name> --production-branch main --force
```

`--force` is needed on wrangler 4.13x+: without it, `pages project create`
tries to delegate to Workers and fails ("Missing entry-point"). Only creation
needs it; later `pages deploy` runs go straight to Pages.

A brand-new project's apex `*.pages.dev` stays **404 until the first
production-branch deploy**.

## Choosing the branch for the audience

- **Stable link**: publish to the project's **production branch** so
  `https://<project>.pages.dev` updates. Check the configured production branch
  (`wrangler pages project list`) — deploying `main` to a project whose
  production branch is `master` only creates a preview and can leave the apex
  serving stale content.
- **Internal review only**: use a short preview branch such as
  `review-<short-slug>`. Cloudflare truncates long preview aliases.
- Prefer reporting the immutable deployment URL Wrangler prints
  (`https://<hash>.<project>.pages.dev`) plus the stable alias people should use.
- Who can open the page is decided by the project, not the branch; see
  [sharing.md](sharing.md).

## Verifying after publish

Verify the reported URL(s) from this environment before sharing. For public
artifacts, require HTTP 200 from `curl -I`. If apex `https://<project>.pages.dev`
404s, deploy the project's production branch (or share the hash URL). If the
hostname is intentionally behind Cloudflare Access, an anonymous `curl` will
usually get a login/challenge response — not 200; treat that challenge as
success for the protected hostname and do not "fix" it by sharing a hash URL
that bypasses Access.
