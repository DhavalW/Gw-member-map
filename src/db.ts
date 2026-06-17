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

export async function findByEmail(env: Env, email: string): Promise<MemberRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM members WHERE email = ?`,
  )
    .bind(email)
    .all<MemberRow>();
  return results;
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

// ---- Magic links (optional email flow) ----

export async function createMagicLink(
  env: Env,
  tokenHash: string,
  memberId: number,
  ttlMs: number,
): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO magic_links (token_hash, member_id, expires_at, created_at)
     VALUES (?,?,?,?)`,
  )
    .bind(tokenHash, memberId, now + ttlMs, now)
    .run();
}

export async function consumeMagicLink(
  env: Env,
  tokenHash: string,
): Promise<number | null> {
  const row = await env.DB.prepare(
    `SELECT member_id, expires_at FROM magic_links WHERE token_hash = ?`,
  )
    .bind(tokenHash)
    .first<{ member_id: number; expires_at: number }>();
  if (!row) return null;
  // Single-use: delete regardless of validity.
  await env.DB.prepare(`DELETE FROM magic_links WHERE token_hash = ?`)
    .bind(tokenHash)
    .run();
  if (row.expires_at < Date.now()) return null;
  return row.member_id;
}
