-- Member directory schema.
-- One row per member submission. Member-facing edits are authorised by a
-- hashed edit token; admin edits by a signed session cookie.

CREATE TABLE IF NOT EXISTS members (
  -- Internal autoincrement id (never exposed in the API).
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Opaque public identifier used in URLs and the public API.
  public_id       TEXT NOT NULL UNIQUE,

  display_name    TEXT NOT NULL,
  -- Optional; used only to (re)send the edit link. Never shown publicly.
  email           TEXT,

  location_name   TEXT NOT NULL,
  lat             REAL NOT NULL,
  lng             REAL NOT NULL,

  bio             TEXT NOT NULL DEFAULT '',
  -- A single "how to connect" value: a URL, email or handle. Shown publicly.
  contact_label   TEXT NOT NULL DEFAULT '',
  contact_url     TEXT NOT NULL DEFAULT '',

  -- Public opt-in. Entries are only ever shown publicly when this is 1.
  consent_public  INTEGER NOT NULL DEFAULT 0,

  -- 'published' | 'pending' | 'hidden'. New entries default to 'pending';
  -- only an admin can publish them.
  status          TEXT NOT NULL DEFAULT 'pending',

  -- SHA-256 hex of the member's secret edit token. The raw token is shown to
  -- the member once and never stored.
  edit_token_hash TEXT NOT NULL,

  -- SHA-256 of submitter IP, for lightweight abuse rate-limiting only.
  ip_hash         TEXT,

  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_members_public_status
  ON members (status, consent_public);
CREATE INDEX IF NOT EXISTS idx_members_email ON members (email);
CREATE INDEX IF NOT EXISTS idx_members_ip_created ON members (ip_hash, created_at);

-- Short-lived email magic links (only used when an email provider is set up).
CREATE TABLE IF NOT EXISTS magic_links (
  token_hash  TEXT PRIMARY KEY,
  member_id   INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (member_id) REFERENCES members (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_magic_expires ON magic_links (expires_at);
