import type { Env } from "./types";

/**
 * Canonical D1 schema for the member directory, mirroring
 * `migrations/0001_init.sql`. Keeping a copy here lets the Worker initialise an
 * empty, auto-provisioned database on its own — no separate
 * `wrangler d1 migrations apply --remote` step (which needs a committed
 * `database_id`) is required. Every statement is idempotent (`IF NOT EXISTS`),
 * so applying it on a cold start is safe and cheap.
 *
 * Keep these statements in sync with the SQL migrations.
 */
const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS members (
     id              INTEGER PRIMARY KEY AUTOINCREMENT,
     public_id       TEXT NOT NULL UNIQUE,
     display_name    TEXT NOT NULL,
     email           TEXT,
     location_name   TEXT NOT NULL,
     lat             REAL NOT NULL,
     lng             REAL NOT NULL,
     bio             TEXT NOT NULL DEFAULT '',
     contact_label   TEXT NOT NULL DEFAULT '',
     contact_url     TEXT NOT NULL DEFAULT '',
     consent_public  INTEGER NOT NULL DEFAULT 0,
     status          TEXT NOT NULL DEFAULT 'pending',
     edit_token_hash TEXT NOT NULL,
     ip_hash         TEXT,
     created_at      INTEGER NOT NULL,
     updated_at      INTEGER NOT NULL,
     image_updated_at INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS idx_members_public_status ON members (status, consent_public)`,
  `CREATE INDEX IF NOT EXISTS idx_members_email ON members (email)`,
  `CREATE INDEX IF NOT EXISTS idx_members_ip_created ON members (ip_hash, created_at)`,
  // Optional profile image, one row per member, keyed by the opaque public_id.
  // Bytes are pre-compressed/resized client-side to a small web-optimised
  // avatar before upload; kept in a separate table so member list queries never
  // pull the blobs. Rows are removed explicitly when a member is deleted/merged.
  `CREATE TABLE IF NOT EXISTS member_images (
     public_id    TEXT PRIMARY KEY,
     content_type TEXT NOT NULL,
     bytes        BLOB NOT NULL,
     width        INTEGER,
     height       INTEGER,
     size         INTEGER NOT NULL,
     updated_at   INTEGER NOT NULL
   )`,
  // Runtime-configurable settings (branding + integrations) edited from the
  // admin dashboard. See src/settings.ts.
  `CREATE TABLE IF NOT EXISTS settings (
     key        TEXT PRIMARY KEY,
     value      TEXT NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  // Per-IP admin login throttling, to slow password brute-force attacks.
  `CREATE TABLE IF NOT EXISTS login_attempts (
     ip_hash       TEXT PRIMARY KEY,
     fail_count    INTEGER NOT NULL DEFAULT 0,
     first_fail_at INTEGER NOT NULL,
     locked_until  INTEGER NOT NULL DEFAULT 0,
     updated_at    INTEGER NOT NULL
   )`,
];

// Columns added after the initial schema shipped. `CREATE TABLE IF NOT EXISTS`
// never alters an existing table, so for databases provisioned before a column
// existed we run an idempotent `ALTER TABLE ADD COLUMN`. SQLite errors if the
// column is already present, so each is attempted individually and that
// specific error is ignored.
const COLUMN_ADDITIONS: { table: string; column: string; ddl: string }[] = [
  {
    table: "members",
    column: "image_updated_at",
    ddl: "ALTER TABLE members ADD COLUMN image_updated_at INTEGER",
  },
];

let schemaReady: Promise<void> | null = null;

async function applyColumnAdditions(env: Env): Promise<void> {
  for (const c of COLUMN_ADDITIONS) {
    try {
      await env.DB.prepare(c.ddl).run();
    } catch (err) {
      // "duplicate column name" simply means the column already exists — the
      // table is already up to date. Re-throw anything else.
      const msg = String((err as Error)?.message ?? err).toLowerCase();
      if (!msg.includes("duplicate column")) throw err;
    }
  }
}

/**
 * Ensure the D1 tables exist before a DB-backed request runs. The work happens
 * once per isolate and is memoised; later calls resolve immediately. If it
 * fails (e.g. a transient D1 error during the very first request) the cached
 * promise is cleared so the next request retries rather than failing forever.
 */
export function ensureSchema(env: Env): Promise<void> {
  if (!schemaReady) {
    schemaReady = env.DB.batch(SCHEMA_STATEMENTS.map((sql) => env.DB.prepare(sql)))
      .then(() => applyColumnAdditions(env))
      .then(() => undefined)
      .catch((err) => {
        schemaReady = null;
        throw err;
      });
  }
  return schemaReady;
}
