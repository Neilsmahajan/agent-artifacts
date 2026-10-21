# Cloudflare Pages publishing reference

Use this reference only when hosting or access control is in scope. Verify commands against current official Cloudflare documentation if Wrangler reports a changed interface.

## Direct Upload

Direct Upload publishes a prebuilt directory through Wrangler:

```bash
npx wrangler pages project create <project-name> --production-branch main
npx wrangler pages deploy <directory> --project-name <project-name> --branch <branch>
```

A Direct Upload project cannot later be converted to Git integration. Create a separate Git-integrated Pages project if automatic repository builds become important.

## Deployments replace, they do not merge

Each `pages deploy` publishes the uploaded directory as the **complete** site for
that branch. Files present in an earlier deployment but absent from the current
upload stop resolving on the branch alias — they survive only at that older
deployment's immutable hash URL.

This is why `publish-pages.mjs` takes an artifacts **root** and re-uploads every
artifact under it. Deploying one artifact directory at a time into a shared
project would take down every previously published artifact on the alias.

Consequences worth stating to the user:

- The local root is the source of truth. If it is lost, previously published
  artifacts cannot be updated or re-deployed — only read at their hash URLs.
- Deleting an artifact directory from the root un-publishes it on the next deploy.
- Cloudflare's Free plan allows up to 100 Pages projects and 500 deployments per
  month, so consolidation is about keeping things tidy and updatable, not about
  quota. See https://developers.cloudflare.com/pages/platform/limits/

Official documentation:

- https://developers.cloudflare.com/pages/get-started/direct-upload/
- https://developers.cloudflare.com/pages/configuration/preview-deployments/
- https://developers.cloudflare.com/pages/framework-guides/deploy-anything/

## URL and privacy model

- Production commonly uses `<project>.pages.dev`.
- Branch previews commonly use `<branch>.<project>.pages.dev`.
- Individual deployments can also receive immutable hash-based URLs (`https://<hash>.<project>.pages.dev`). Prefer these when a preview alias looks wrong.
- A new Direct Upload project’s apex `https://<project>.pages.dev` returns **404 until the first deploy to the production branch** (`main` by default when created with this skill). Preview-only deploys do not populate that apex URL.
- Reusing an existing Pages project: deploy to **that project’s configured production branch**, not blindly `main`. A mismatch publishes a preview while apex can keep serving an older production deployment.
- Cloudflare may **truncate long preview branch aliases**. Keep review branch names short (roughly under ~28 characters) or share the hash deployment URL.
- When verifying Access-protected hosts, an anonymous `curl` challenge/redirect is expected; do not require anonymous HTTP 200 in that case.
- Preview deployments normally send `X-Robots-Tag: noindex`. This discourages indexing but does not authenticate visitors.
- Anyone who can reach an unprotected URL can read its content.
- First-time Wrangler auth always requires a human Authorize click. In agent/remote shells prefer `wrangler login --device`, then confirm with `wrangler whoami`.

Use Cloudflare Access as an identity-aware proxy when a hosted artifact must be restricted:

- https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/
- https://developers.cloudflare.com/cloudflare-one/access-controls/policies/

Do not claim Access is active until the protected hostname has been tested in a signed-out browser.

## Content-Security-Policy and inlining

`assets/pages-root/_headers` allows `'unsafe-inline'` for `script-src` and
`style-src`. That is deliberate, not an oversight: a built artifact inlines its
own CSS and JS so a single file renders from a gist proxy, an email attachment,
or a local path with no second request. `script-src 'self'` is incompatible with
that.

The rest of the policy is tightened to compensate. `default-src 'none'` blocks
every subresource type not explicitly listed, and `connect-src 'none'` blocks
fetch, XHR, WebSocket, and beacons — so an inline script cannot exfiltrate what
it reads. Same-origin `img-src` and `font-src` remain allowed for artifacts that
grow to need them, and CSP does not restrict ordinary link navigation. Content is
escaped at build time by `scripts/render.mjs`, and the artifact loads no
third-party code.

If a future artifact must satisfy a strict CSP, the fix is per-file
`'sha256-...'` script hashes computed at build time and written into `_headers`,
not switching back to a runtime-fetched shell.

## Pages versus Workers Static Assets

Use Pages for simple static artifacts, branch preview URLs, and straightforward Direct Upload. Consider Workers Static Assets when the project needs Worker APIs, Durable Objects, cron triggers, or broader application infrastructure:

- https://developers.cloudflare.com/workers/static-assets/
- https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/

Keep this skill on Pages unless the user explicitly chooses Workers.
