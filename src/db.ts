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
  await env.DB.prepare(`DELETE FROM members WHERE public_id = ?`)
    .bind(publicId)
    .run();
}

/**
 * Merge several records into one (admin de-duplication). The `primaryId` record
 * is updated with the chosen merged values and kept (its public_id + edit token
 * survive); every id in `sourceIds` is deleted. Both steps run in a single
 * `batch()` so the merge is atomic — callers must ensure `sourceIds` excludes
 * the primary id.
 */
export async function mergeMembers(
  env: Env,
  primaryId: string,
  sourceIds: string[],
  m: UpdateMember & { status: string; consent_public: number },
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
  if (sourceIds.length > 0) {
    stmts.push(
      env.DB.prepare(
        `DELETE FROM members WHERE public_id IN (${placeholders(sourceIds.length)})`,
      ).bind(...sourceIds),
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

/** Delete many members at once. */
export async function bulkDeleteMembers(
  env: Env,
  publicIds: string[],
): Promise<void> {
  if (publicIds.length === 0) return;
  await env.DB.prepare(
    `DELETE FROM members WHERE public_id IN (${placeholders(publicIds.length)})`,
  )
    .bind(...publicIds)
    .run();
}
