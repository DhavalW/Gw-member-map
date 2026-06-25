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
     status          TEXT NOT NULL DEFAULT 'published',
     edit_token_hash TEXT NOT NULL,
     ip_hash         TEXT,
     created_at      INTEGER NOT NULL,
     updated_at      INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_members_public_status ON members (status, consent_public)`,
  `CREATE INDEX IF NOT EXISTS idx_members_email ON members (email)`,
  `CREATE INDEX IF NOT EXISTS idx_members_ip_created ON members (ip_hash, created_at)`,
];

let schemaReady: Promise<void> | null = null;

/**
 * Ensure the D1 tables exist before a DB-backed request runs. The work happens
 * once per isolate and is memoised; later calls resolve immediately. If it
 * fails (e.g. a transient D1 error during the very first request) the cached
 * promise is cleared so the next request retries rather than failing forever.
 */
export function ensureSchema(env: Env): Promise<void> {
  if (!schemaReady) {
    schemaReady = env.DB.batch(SCHEMA_STATEMENTS.map((sql) => env.DB.prepare(sql)))
      .then(() => undefined)
      .catch((err) => {
        schemaReady = null;
        throw err;
      });
  }
  return schemaReady;
}
