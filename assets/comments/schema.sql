-- <project>-comments (Cloudflare D1): page comment threads.
--
-- Apply once, and again after any change here (every statement is idempotent):
--   npx wrangler d1 execute <project>-comments --remote --file <skill-dir>/assets/comments/schema.sql
--
-- The Pages worker (assets/pages-worker/comments-api.js) writes the owner's
-- comments from the page; scripts/comments.mjs reads, replies and resolves
-- through the D1 REST API. Bodies are plain text: nothing here is ever
-- rendered as HTML.

CREATE TABLE IF NOT EXISTS threads (
  id           TEXT PRIMARY KEY,                -- t_<time><random>
  slug         TEXT NOT NULL,                   -- page slug
  anchor_id    TEXT NOT NULL,                   -- sec-cash.p2 | chart:allocation/row:cash | page
  anchor_kind  TEXT NOT NULL,                   -- page | heading | paragraph | bullet | block | chart | chart-mark
  anchor_fp    TEXT,                            -- the block's data-fp when written
  quote        TEXT,                            -- up to 300 chars of the anchored text
  quote_prefix TEXT,                            -- selected text: a little context either side
  quote_suffix TEXT,
  page_version TEXT NOT NULL,                   -- artifact updated + build hash
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'archived')),
  created_by   TEXT NOT NULL,                   -- email, or agent:claude-code / agent:codex
  created_at   INTEGER NOT NULL,                -- epoch ms
  endorsed_at  INTEGER,                         -- when the owner approved a guest's request (what it covers: endorsements)
  resolved_by  TEXT,
  resolved_at  INTEGER,
  resolution   TEXT,                            -- e.g. 'Rewrote the cash paragraph in a1b2c3d'
  resolved_in  TEXT                             -- page_version that addressed it
);

CREATE TABLE IF NOT EXISTS comments (
  id          TEXT PRIMARY KEY,                 -- c_<time><random>
  thread_id   TEXT NOT NULL REFERENCES threads(id),
  author      TEXT NOT NULL,                    -- email or agent:<name>
  author_kind TEXT NOT NULL CHECK (author_kind IN ('owner', 'guest', 'agent')),
  body        TEXT NOT NULL,                    -- plain text, 1-4000 chars; '' once deleted
  created_at  INTEGER NOT NULL,
  deleted_at  INTEGER                           -- soft delete; the body is blanked
);

-- The owner's approval of a guest's request (comments.mjs approve): exactly
-- the guest comments saved in the thread when it ran. One row per comment,
-- so a comment that lands afterwards is never covered.
CREATE TABLE IF NOT EXISTS endorsements (
  comment_id  TEXT PRIMARY KEY REFERENCES comments(id),
  thread_id   TEXT NOT NULL REFERENCES threads(id),
  endorsed_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS threads_by_page    ON threads(slug, status);
CREATE INDEX IF NOT EXISTS comments_by_thread ON comments(thread_id, created_at);
CREATE INDEX IF NOT EXISTS comments_by_author ON comments(author, created_at);
CREATE INDEX IF NOT EXISTS endorsements_by_thread ON endorsements(thread_id);
