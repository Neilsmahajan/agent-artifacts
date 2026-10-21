#!/usr/bin/env node

// Per-page sharing on a hub site, for agents and the terminal.
//
//   share.mjs --root <root> list
//   share.mjs --root <root> share <slug> <email>...
//   share.mjs --root <root> unshare <slug> <email>...    (revokes the page's sessions)
//   share.mjs --root <root> link <slug>                  (prints the link; reuses an existing one)
//   share.mjs --root <root> unlink <slug>
//   share.mjs --root <root> reset-link <slug>
//   share.mjs --root <root> audit
//   share.mjs --root <root> setup-link-rule              (creates the /_link bypass once)
//
// <root>/sharing.config.json names the site ({project, hostname, accountId,
// kvNamespaceId, owner}). The Access API token comes from the Keychain item
// cf-access-share-mac (or CF_ACCESS_TOKEN); link codes are written to Workers
// KV with the wrangler login. Guest lists and link codes live only in
// Cloudflare — nothing here writes them to the repo.

import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

import { auditApps, linkAppBody, normalizeEmail, pageAppBody, prefixProblems, queueFollowUpRevokes } from "./access.mjs";
import {
  GENERATED_PATHS,
  accessClient,
  accessToken,
  auditSite,
  linkUrl,
  listLinks,
  loadConfig,
  pageSlugs,
  wranglerKv,
  wranglerKvStore,
} from "./sharing.mjs";

const SLUG = /^[a-z0-9][a-z0-9-]*$/;

function usage() {
  console.log(
    "Usage: share.mjs --root <root> <list | share <slug> <email>... | unshare <slug> <email>... | link <slug> | unlink <slug> | reset-link <slug> | audit | setup-link-rule>",
  );
}

const argv = process.argv.slice(2);
const rootIndex = argv.indexOf("--root");
if (rootIndex < 0 || !argv[rootIndex + 1] || argv.includes("--help") || argv.includes("-h")) {
  usage();
  process.exit(argv.includes("--help") || argv.includes("-h") ? 0 : 1);
}
const root = resolve(argv[rootIndex + 1]);
const [command, ...rest] = argv.filter((_, i) => i !== rootIndex && i !== rootIndex + 1);

async function main() {
  const config = await loadConfig(root);
  const slugs = await pageSlugs(root);
  const allPaths = [...slugs, ...GENERATED_PATHS];
  const host = config.hostname;
  const client = accessClient(config, await accessToken());
  const guestIdps = await client.guestIdps();
  const audit = async (published = slugs) => auditApps(await client.listApps(), { host, owner: config.owner, publishedSlugs: published, guestIdps });

  const requireSlug = (slug) => {
    if (!slug || !SLUG.test(slug)) throw new Error(`Give a page slug (got ${slug ?? "nothing"})`);
    if (!slugs.has(slug)) throw new Error(`/${slug} is not a published page in ${root}`);
    return slug;
  };

  switch (command) {
    case "list": {
      const { problems, pages, link } = await audit();
      const links = await listLinks(config);
      const shared = new Set([...pages.keys(), ...links.map((l) => l.slug)]);
      if (!shared.size) console.log("Nothing is shared.");
      for (const slug of [...shared].sort()) {
        const page = pages.get(slug);
        const pageLinks = links.filter((l) => l.slug === slug);
        console.log(`/${slug}/`);
        if (page) console.log(`  people: ${page.guests.join(", ") || "(none)"}`);
        for (const l of pageLinks) console.log(`  link:   ${linkUrl(config, l.code)}${link ? "" : "  (the /_link rule is missing, so it doesn't open)"}`);
      }
      for (const problem of problems) console.log(`PROBLEM: ${problem}`);
      break;
    }

    case "share": {
      const slug = requireSlug(rest[0]);
      const emails = rest.slice(1).map(normalizeEmail);
      if (!emails.length) throw new Error("Give at least one email address");
      const overlap = prefixProblems([slug], allPaths);
      if (overlap.length) throw new Error(overlap.join("\n"));
      const { problems, pages } = await audit();
      if (problems.length) throw new Error(`Fix these first:\n${problems.join("\n")}`);
      const existing = pages.get(slug);
      const guests = [...new Set([...(existing?.guests || []), ...emails])];
      const body = pageAppBody({ host, slug, owner: config.owner, guests, idps: guestIdps });
      const app = existing ? await client.updateApp(existing.app.id, body) : await client.createApp(body);
      // Read back and re-audit: what Cloudflare stored is what counts.
      const after = await audit();
      const stored = after.pages.get(slug);
      if (!stored || after.problems.length) {
        throw new Error(`Stored rule for /${slug} (${app.id}) did not pass the audit:\n${after.problems.join("\n")}`);
      }
      console.log(`/${slug}/ is shared with: ${stored.guests.join(", ")}`);
      console.log(`Link: https://${host}/${slug}/`);
      break;
    }

    case "unshare": {
      const slug = rest[0];
      if (!slug || !SLUG.test(slug)) throw new Error("Give a page slug");
      const emails = rest.slice(1).map(normalizeEmail);
      // Orphaned rules (page since deleted) must still be removable.
      const { problems, pages } = await audit(null);
      const existing = pages.get(slug);
      if (!existing) {
        // Idempotent: a retry after a partial failure still signs people out.
        for (const email of emails) await client.revokeUser(email);
        // A rule the audit rejected isn't in pages, but may still cover this one.
        if (problems.length) {
          throw new Error(`${emails.length ? "Signed the given people out, but f" : "F"}ix these first: a rule below may still share /${slug}:\n${problems.join("\n")}`);
        }
        console.log(`/${slug} is not shared with anyone${emails.length ? "; signed the given people out anyway" : ""}`);
        break;
      }
      const removed = emails.length ? emails : existing.guests;
      const remaining = existing.guests.filter((g) => !removed.includes(g));
      if (remaining.length) {
        if (remaining.length !== existing.guests.length) {
          await client.updateApp(existing.app.id, pageAppBody({ host, slug, owner: config.owner, guests: remaining, idps: guestIdps }));
        }
        // Phase 1 (Oct 1): a revoke right after the list change raced it — the
        // removed guest's 24-hour global session got a fresh page token from an
        // edge still holding the old list. So: end their global session, sign
        // the page out now, and queue more sign-outs for the revoker Worker.
        for (const email of removed) await client.revokeUser(email);
        await client.revokeTokens(existing.app.id);
        await queueFollowUpRevokes(wranglerKvStore(config), existing.app.id);
        const after = (await audit(null)).pages.get(slug);
        if (after && removed.some((e) => after.guests.includes(e))) {
          throw new Error(`Someone changed /${slug}'s list at the same time and ${removed.join(", ")} is back on it; run unshare again`);
        }
        console.log(`/${slug}/ is now shared with: ${remaining.join(", ")} (everyone was signed out of it and is again over the next few minutes; they sign in again)`);
      } else {
        // Deleting the rule hands the path back to the owner-only site rule.
        for (const email of removed) await client.revokeUser(email);
        await client.revokeTokens(existing.app.id);
        await client.deleteApp(existing.app.id);
        console.log(`/${slug}/ is no longer shared with anyone (rule deleted)`);
      }
      console.log("Seats are not freed automatically: Zero Trust → Users.");
      break;
    }

    case "link":
    case "reset-link": {
      const slug = requireSlug(rest[0]);
      const { problems, link } = await audit();
      if (problems.length) throw new Error(`Fix these first:\n${problems.join("\n")}`);
      const links = (await listLinks(config)).filter((l) => l.slug === slug);
      if (command === "link" && links.length) {
        console.log(linkUrl(config, links[0].code));
        break;
      }
      for (const l of links) await wranglerKv(config, ["key", "delete", `code:${l.code}`]);
      const code = randomBytes(32).toString("base64url");
      await wranglerKv(config, ["key", "put", `code:${code}`, slug, "--metadata", JSON.stringify({ slug })]);
      console.log(linkUrl(config, code));
      if (!link) console.log("Note: the /_link rule doesn't exist yet (setup-link-rule), so the link asks for a login.");
      break;
    }

    case "unlink": {
      const slug = rest[0];
      if (!slug || !SLUG.test(slug)) throw new Error("Give a page slug");
      const links = (await listLinks(config)).filter((l) => l.slug === slug);
      if (!links.length) throw new Error(`/${slug} has no link`);
      for (const l of links) await wranglerKv(config, ["key", "delete", `code:${l.code}`]);
      console.log(`Link for /${slug}/ revoked. It stops working shortly (usually within a minute).`);
      break;
    }

    case "audit": {
      const { problems, pages, link, links } = await auditSite({ config, client, publishedSlugs: slugs, allPaths });
      if (links.length && !link) console.log("Note: links exist but the /_link rule doesn't, so they ask for a login.");
      if (problems.length) {
        for (const problem of problems) console.log(`PROBLEM: ${problem}`);
        process.exitCode = 1;
      } else console.log(`Access audit passed: ${pages.size} page rule(s), ${links.length} link(s), /_link rule ${link ? "present" : "absent"}`);
      break;
    }

    case "setup-link-rule": {
      const { problems, link } = await audit();
      if (problems.length) throw new Error(`Fix these first:\n${problems.join("\n")}`);
      if (link) {
        console.log("The /_link rule already exists.");
        break;
      }
      await client.createApp(linkAppBody({ host }));
      const after = await audit();
      if (!after.link || after.problems.length) throw new Error(`The stored /_link rule did not pass the audit:\n${after.problems.join("\n")}`);
      console.log(`Created the /_link bypass on ${host}`);
      break;
    }

    default:
      usage();
      process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`ERROR: ${error.message}`);
  process.exit(1);
});
