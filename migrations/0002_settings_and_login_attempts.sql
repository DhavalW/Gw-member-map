-- Runtime configuration + admin login hardening.
--
-- `settings`: branding and integration options a community admin can change
-- from the dashboard without a redeploy (see src/settings.ts). Each row
-- overrides the matching deployment variable / built-in default.
--
-- `login_attempts`: per-IP counters used to throttle and temporarily lock out
-- repeated failed admin sign-ins (password brute-force protection).
--
-- Both tables are also created idempotently on first request by src/schema.ts,
-- so an auto-provisioned database initialises itself without running this.

CREATE TABLE IF NOT EXISTS settings (
  -- camelCase setting key (e.g. 'communityName'), matching src/settings.ts.
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS login_attempts (
  -- Salted SHA-256 of the client IP. Stored hashed so it can't be reversed.
  ip_hash       TEXT PRIMARY KEY,
  -- Consecutive failures within the current window.
  fail_count    INTEGER NOT NULL DEFAULT 0,
  -- When the current failure window started (ms epoch).
  first_fail_at INTEGER NOT NULL,
  -- Locked out until this time (ms epoch); 0 when not locked.
  locked_until  INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL
);
