-- Covering index for the public member list: filter on (status, consent_public)
-- plus ORDER BY created_at DESC, so the map's main query never scans + sorts.
-- Mirrored in src/schema.ts for auto-provisioned databases.
CREATE INDEX IF NOT EXISTS idx_members_public_created
  ON members (status, consent_public, created_at DESC);
