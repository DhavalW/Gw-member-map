-- Optional member profile images.
--
-- Images are compressed and resized to a small, square, web-optimised avatar
-- in the browser before upload, then stored here as a BLOB. They live in a
-- separate table (keyed by the member's opaque public_id) so the member list
-- queries on the map never pull the image bytes.
--
-- `members.image_updated_at` is a lightweight "has image" flag + cache-busting
-- version that rides along on list queries without a join. It is NULL when the
-- member has no image. The image row is removed explicitly when a member is
-- deleted or merged (see src/db.ts).
--
-- Both objects are also created idempotently on first request by src/schema.ts,
-- so an auto-provisioned database initialises itself without running this.

ALTER TABLE members ADD COLUMN image_updated_at INTEGER;

CREATE TABLE IF NOT EXISTS member_images (
  -- The member's opaque public_id (matches members.public_id).
  public_id    TEXT PRIMARY KEY,
  content_type TEXT NOT NULL,
  bytes        BLOB NOT NULL,
  width        INTEGER,
  height       INTEGER,
  -- Stored byte length, for quick reporting without measuring the blob.
  size         INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
