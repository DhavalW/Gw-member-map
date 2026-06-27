import type { Env, MemberRow, OwnerMember, PublicMember } from "./types";

export function toPublic(row: MemberRow): PublicMember {
  return {
    id: row.public_id,
    name: row.display_name,
    location: row.location_name,
    lat: row.lat,
    lng: row.lng,
    bio: row.bio,
    contactLabel: row.contact_label,
    contactUrl: row.contact_url,
    createdAt: row.created_at,
    imageUpdatedAt: row.image_updated_at ?? null,
  };
}

export function toOwner(row: MemberRow): OwnerMember {
  return {
    ...toPublic(row),
    email: row.email,
    status: row.status,
    consentPublic: row.consent_public === 1,
  };
}

/** Publicly visible members: opted-in and published. */
export async function listPublicMembers(env: Env): Promise<PublicMember[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM members
       WHERE status = 'published' AND consent_public = 1
       ORDER BY created_at DESC`,
  ).all<MemberRow>();
  return results.map(toPublic);
}

/** Every member, for the admin dashboard. */
export async function listAllMembers(env: Env): Promise<OwnerMember[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM members ORDER BY created_at DESC`,
  ).all<MemberRow>();
  return results.map(toOwner);
}

export async function getByPublicId(
  env: Env,
  publicId: string,
): Promise<MemberRow | null> {
  return env.DB.prepare(`SELECT * FROM members WHERE public_id = ?`)
    .bind(publicId)
    .first<MemberRow>();
}

export async function getById(env: Env, id: number): Promise<MemberRow | null> {
  return env.DB.prepare(`SELECT * FROM members WHERE id = ?`)
    .bind(id)
    .first<MemberRow>();
}

/** Count submissions from one IP in the trailing window (abuse limiting). */
export async function countRecentByIp(
  env: Env,
  ipHash: string,
  sinceMs: number,
): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM members WHERE ip_hash = ? AND created_at >= ?`,
  )
    .bind(ipHash, sinceMs)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export interface InsertMember {
  public_id: string;
  display_name: string;
  email: string | null;
  location_name: string;
  lat: number;
  lng: number;
  bio: string;
  contact_label: string;
  contact_url: string;
  consent_public: number;
  status: string;
  edit_token_hash: string;
  ip_hash: string | null;
}

export async function insertMember(env: Env, m: InsertMember): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO members
      (public_id, display_name, email, location_name, lat, lng, bio,
       contact_label, contact_url, consent_public, status, edit_token_hash,
       ip_hash, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      m.public_id,
      m.display_name,
      m.email,
      m.location_name,
      m.lat,
      m.lng,
      m.bio,
      m.contact_label,
      m.contact_url,
      m.consent_public,
      m.status,
      m.edit_token_hash,
      m.ip_hash,
      now,
      now,
    )
    .run();
}

export interface UpdateMember {
  display_name: string;
  email: string | null;
  location_name: string;
  lat: number;
  lng: number;
  bio: string;
  contact_label: string;
  contact_url: string;
}

/**
 * Member self-edit. Members may toggle their own public visibility
 * (consent_public) but cannot change the moderation status field.
 */
export async function updateMember(
  env: Env,
  publicId: string,
  m: UpdateMember & { consent_public: number },
): Promise<void> {
  await env.DB.prepare(
    `UPDATE members SET
       display_name = ?, email = ?, location_name = ?, lat = ?, lng = ?,
       bio = ?, contact_label = ?, contact_url = ?, consent_public = ?,
       updated_at = ?
     WHERE public_id = ?`,
  )
    .bind(
      m.display_name,
      m.email,
      m.location_name,
      m.lat,
      m.lng,
      m.bio,
      m.contact_label,
      m.contact_url,
      m.consent_public,
      Date.now(),
      publicId,
    )
    .run();
}

/** Admin edit: may also change moderation status + consent. */
export async function adminUpdateMember(
  env: Env,
  publicId: string,
  m: UpdateMember & { status: string; consent_public: number },
): Promise<void> {
  await env.DB.prepare(
    `UPDATE members SET
       display_name = ?, email = ?, location_name = ?, lat = ?, lng = ?,
       bio = ?, contact_label = ?, contact_url = ?, status = ?,
       consent_public = ?, updated_at = ?
     WHERE public_id = ?`,
  )
    .bind(
      m.display_name,
      m.email,
      m.location_name,
      m.lat,
      m.lng,
      m.bio,
      m.contact_label,
      m.contact_url,
      m.status,
      m.consent_public,
      Date.now(),
      publicId,
    )
    .run();
}

export async function deleteMember(env: Env, publicId: string): Promise<void> {
  // Remove the member's profile image alongside the record so deleting an entry
  // never leaves an orphaned blob behind.
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM member_images WHERE public_id = ?`).bind(publicId),
    env.DB.prepare(`DELETE FROM members WHERE public_id = ?`).bind(publicId),
  ]);
}

// ---- Member profile images ----

export interface MemberImageRow {
  content_type: string;
  // D1 returns BLOB columns as a number[] (not an ArrayBuffer); callers must
  // normalise before use (see `blobToBytes` in src/index.ts).
  bytes: ArrayBuffer | number[];
  updated_at: number;
}

/** Fetch the stored image bytes for a member (or null when none). */
export async function getMemberImage(
  env: Env,
  publicId: string,
): Promise<MemberImageRow | null> {
  return env.DB.prepare(
    `SELECT content_type, bytes, updated_at FROM member_images WHERE public_id = ?`,
  )
    .bind(publicId)
    .first<MemberImageRow>();
}

export interface PutImage {
  content_type: string;
  bytes: ArrayBuffer;
  width: number | null;
  height: number | null;
  size: number;
}

/**
 * Upsert a member's image and stamp `members.image_updated_at`. Returns the new
 * version timestamp so callers can build a fresh, cache-busted image URL.
 */
export async function putMemberImage(
  env: Env,
  publicId: string,
  img: PutImage,
): Promise<number> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO member_images (public_id, content_type, bytes, width, height, size, updated_at)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(public_id) DO UPDATE SET
           content_type = excluded.content_type, bytes = excluded.bytes,
           width = excluded.width, height = excluded.height,
           size = excluded.size, updated_at = excluded.updated_at`,
    ).bind(publicId, img.content_type, img.bytes, img.width, img.height, img.size, now),
    env.DB.prepare(
      `UPDATE members SET image_updated_at = ?, updated_at = ? WHERE public_id = ?`,
    ).bind(now, now, publicId),
  ]);
  return now;
}

/** Remove a member's image and clear the `image_updated_at` flag. */
export async function deleteMemberImage(env: Env, publicId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM member_images WHERE public_id = ?`).bind(publicId),
    env.DB.prepare(
      `UPDATE members SET image_updated_at = NULL, updated_at = ? WHERE public_id = ?`,
    ).bind(Date.now(), publicId),
  ]);
}

/** Which of the given public ids currently have a stored image. */
export async function imagesPresent(
  env: Env,
  publicIds: string[],
): Promise<Set<string>> {
  if (publicIds.length === 0) return new Set();
  const { results } = await env.DB.prepare(
    `SELECT public_id FROM member_images WHERE public_id IN (${placeholders(publicIds.length)})`,
  )
    .bind(...publicIds)
    .all<{ public_id: string }>();
  return new Set(results.map((r) => r.public_id));
}

/**
 * Merge several records into one (admin de-duplication). The `primaryId` record
 * is updated with the chosen merged values and kept (its public_id + edit token
 * survive); every id in `sourceIds` is deleted. Both steps run in a single
 * `batch()` so the merge is atomic — callers must ensure `sourceIds` excludes
 * the primary id.
 */
/**
 * How the kept record's profile image is resolved during a merge:
 * - `"keep"`   — leave the primary's existing image untouched;
 * - `"remove"` — delete the primary's image (admin chose "no photo");
 * - `{ copyFrom }` — copy a source record's image onto the primary.
 */
export type MergeImagePlan = "keep" | "remove" | { copyFrom: string };

export async function mergeMembers(
  env: Env,
  primaryId: string,
  sourceIds: string[],
  m: UpdateMember & { status: string; consent_public: number },
  image: MergeImagePlan = "keep",
): Promise<void> {
  const now = Date.now();
  const stmts = [
    env.DB.prepare(
      `UPDATE members SET
         display_name = ?, email = ?, location_name = ?, lat = ?, lng = ?,
         bio = ?, contact_label = ?, contact_url = ?, status = ?,
         consent_public = ?, updated_at = ?
       WHERE public_id = ?`,
    ).bind(
      m.display_name,
      m.email,
      m.location_name,
      m.lat,
      m.lng,
      m.bio,
      m.contact_label,
      m.contact_url,
      m.status,
      m.consent_public,
      now,
      primaryId,
    ),
  ];

  // Resolve the image onto the primary BEFORE the source rows (and their image
  // rows) are deleted below, so a copy-from-source still has bytes to read.
  if (image === "remove") {
    stmts.push(
      env.DB.prepare(`DELETE FROM member_images WHERE public_id = ?`).bind(primaryId),
      env.DB.prepare(
        `UPDATE members SET image_updated_at = NULL WHERE public_id = ?`,
      ).bind(primaryId),
    );
  } else if (typeof image === "object" && image.copyFrom && image.copyFrom !== primaryId) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO member_images (public_id, content_type, bytes, width, height, size, updated_at)
           SELECT ?, content_type, bytes, width, height, size, ?
             FROM member_images WHERE public_id = ?
           ON CONFLICT(public_id) DO UPDATE SET
             content_type = excluded.content_type, bytes = excluded.bytes,
             width = excluded.width, height = excluded.height,
             size = excluded.size, updated_at = excluded.updated_at`,
      ).bind(primaryId, now, image.copyFrom),
      env.DB.prepare(
        `UPDATE members SET image_updated_at = ? WHERE public_id = ?`,
      ).bind(now, primaryId),
    );
  }

  if (sourceIds.length > 0) {
    const ph = placeholders(sourceIds.length);
    stmts.push(
      env.DB.prepare(`DELETE FROM member_images WHERE public_id IN (${ph})`).bind(...sourceIds),
      env.DB.prepare(`DELETE FROM members WHERE public_id IN (${ph})`).bind(...sourceIds),
    );
  }
  await env.DB.batch(stmts);
}

/**
 * Replace a member's edit-token hash. Used by the admin "copy edit link"
 * action to mint a fresh, shareable edit link without ever storing the raw
 * token. The previous link stops working once a new one is generated.
 */
export async function setEditTokenHash(
  env: Env,
  publicId: string,
  editTokenHash: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE members SET edit_token_hash = ?, updated_at = ? WHERE public_id = ?`,
  )
    .bind(editTokenHash, Date.now(), publicId)
    .run();
}

// ---- Bulk admin operations (CSV import / batch edits) ----

/**
 * Insert many members in one go (admin CSV import). D1 caps the size of a
 * single batch, so callers should chunk large imports; this helper inserts
 * exactly what it's given in a single `batch()` round-trip.
 */
export async function bulkInsertMembers(
  env: Env,
  rows: InsertMember[],
): Promise<void> {
  if (rows.length === 0) return;
  const now = Date.now();
  const stmt = env.DB.prepare(
    `INSERT INTO members
      (public_id, display_name, email, location_name, lat, lng, bio,
       contact_label, contact_url, consent_public, status, edit_token_hash,
       ip_hash, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  await env.DB.batch(
    rows.map((m) =>
      stmt.bind(
        m.public_id,
        m.display_name,
        m.email,
        m.location_name,
        m.lat,
        m.lng,
        m.bio,
        m.contact_label,
        m.contact_url,
        m.consent_public,
        m.status,
        m.edit_token_hash,
        m.ip_hash,
        now,
        now,
      ),
    ),
  );
}

function placeholders(n: number): string {
  return new Array(n).fill("?").join(",");
}

// ---- Runtime settings (dashboard-configurable branding + integrations) ----

/** Read every saved setting override into a `key -> value` map. */
export async function loadSettings(env: Env): Promise<Record<string, string>> {
  const { results } = await env.DB.prepare(
    `SELECT key, value FROM settings`,
  ).all<{ key: string; value: string }>();
  const out: Record<string, string> = {};
  for (const r of results) out[r.key] = r.value;
  return out;
}

/**
 * Apply a batch of setting changes atomically: upsert each `{key, value}` and
 * delete each key in `deletes` (reverting it to the env/default).
 */
export async function upsertSettings(
  env: Env,
  upserts: { key: string; value: string }[],
  deletes: string[] = [],
): Promise<void> {
  const now = Date.now();
  const stmts = [
    ...upserts.map((u) =>
      env.DB.prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ).bind(u.key, u.value, now),
    ),
    ...deletes.map((k) => env.DB.prepare(`DELETE FROM settings WHERE key = ?`).bind(k)),
  ];
  if (stmts.length) await env.DB.batch(stmts);
}

// ---- Admin login throttling (brute-force protection) ----

export interface LoginAttempt {
  ip_hash: string;
  fail_count: number;
  first_fail_at: number;
  locked_until: number;
  updated_at: number;
}

export async function getLoginAttempt(
  env: Env,
  ipHash: string,
): Promise<LoginAttempt | null> {
  return env.DB.prepare(`SELECT * FROM login_attempts WHERE ip_hash = ?`)
    .bind(ipHash)
    .first<LoginAttempt>();
}

/** Record (or update) the failure counters for an IP after a bad password. */
export async function recordLoginFailure(
  env: Env,
  ipHash: string,
  a: { fail_count: number; first_fail_at: number; locked_until: number },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO login_attempts (ip_hash, fail_count, first_fail_at, locked_until, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(ip_hash) DO UPDATE SET
         fail_count = excluded.fail_count,
         first_fail_at = excluded.first_fail_at,
         locked_until = excluded.locked_until,
         updated_at = excluded.updated_at`,
  )
    .bind(ipHash, a.fail_count, a.first_fail_at, a.locked_until, Date.now())
    .run();
}

/** Clear an IP's failure record (called on a successful sign-in). */
export async function clearLoginAttempts(env: Env, ipHash: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM login_attempts WHERE ip_hash = ?`)
    .bind(ipHash)
    .run();
}

/** Set the moderation status on many members at once. */
export async function bulkSetStatus(
  env: Env,
  publicIds: string[],
  status: string,
): Promise<void> {
  if (publicIds.length === 0) return;
  await env.DB.prepare(
    `UPDATE members SET status = ?, updated_at = ?
       WHERE public_id IN (${placeholders(publicIds.length)})`,
  )
    .bind(status, Date.now(), ...publicIds)
    .run();
}

/** Toggle public consent on many members at once. */
export async function bulkSetConsent(
  env: Env,
  publicIds: string[],
  consent: number,
): Promise<void> {
  if (publicIds.length === 0) return;
  await env.DB.prepare(
    `UPDATE members SET consent_public = ?, updated_at = ?
       WHERE public_id IN (${placeholders(publicIds.length)})`,
  )
    .bind(consent, Date.now(), ...publicIds)
    .run();
}

/** Delete many members at once, including any stored profile images. */
export async function bulkDeleteMembers(
  env: Env,
  publicIds: string[],
): Promise<void> {
  if (publicIds.length === 0) return;
  const ph = placeholders(publicIds.length);
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM member_images WHERE public_id IN (${ph})`).bind(...publicIds),
    env.DB.prepare(`DELETE FROM members WHERE public_id IN (${ph})`).bind(...publicIds),
  ]);
}
