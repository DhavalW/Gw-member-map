import type { Env, MemberRow } from "./types";
import {
  ADMIN_COOKIE,
  createAdminSession,
  isAdminConfigured,
  parseCookies,
  randomToken,
  sameOrigin,
  securityHeaders,
  sessionCookie,
  sha256Hex,
  timingSafeEqual,
  verifyAdminSession,
  verifyMemberSession,
} from "./security";
import {
  adminUpdateMember,
  bulkDeleteMembers,
  bulkInsertMembers,
  bulkSetConsent,
  bulkSetStatus,
  countRecentByIp,
  deleteMember,
  getByPublicId,
  insertMember,
  listAllMembers,
  listPublicMembers,
  setEditTokenHash,
  toOwner,
  updateMember,
} from "./db";
import type { InsertMember } from "./db";
import { geocode } from "./geocode";
import { ensureSchema } from "./schema";
import { validateSubmission } from "./validate";

const SUBMIT_LIMIT = 5; // submissions per IP per hour
const SUBMIT_WINDOW_MS = 60 * 60 * 1000;
// Largest bulk import accepted in a single request, and the per-batch chunk
// size (D1 limits how many statements one batch() may contain).
const IMPORT_MAX_ROWS = 5000;
const IMPORT_CHUNK = 50;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (url.pathname.startsWith("/api/")) {
        const res = await handleApi(request, env, url);
        return withHeaders(res);
      }
      // Everything else is a static asset (SPA pages, vendored Leaflet, css).
      const asset = await env.ASSETS.fetch(request);
      return withHeaders(asset);
    } catch (err) {
      console.error("Unhandled error", err);
      return withHeaders(json({ error: "Internal error" }, 500));
    }
  },
} satisfies ExportedHandler<Env>;

function withHeaders(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(securityHeaders())) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extra,
    },
  });
}

// ---------------------------------------------------------------------------
// API router
// ---------------------------------------------------------------------------

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  const { pathname } = url;
  const method = request.method.toUpperCase();

  // --- Public config (drives the front-end) ---
  if (pathname === "/api/config" && method === "GET") {
    return json({
      appName: env.APP_NAME || "Generalist World Member Map",
      communityName: env.COMMUNITY_NAME || "Generalist World",
      communityUrl: env.COMMUNITY_URL || "https://generalist.world/",
      moderationEnabled: env.MODERATION_ENABLED === "true",
      adminConfigured: isAdminConfigured(env),
      turnstileSiteKey: env.TURNSTILE_SITE_KEY || "",
    });
  }

  // --- Geocoding proxy for the form's location search ---
  // Handled before the DB-backed routes (and before ensureSchema) so location
  // search keeps working even if the database is briefly unavailable.
  if (pathname === "/api/geocode" && method === "GET") {
    const q = url.searchParams.get("q") ?? "";
    try {
      const results = await geocode(q, env);
      return json({ results }, 200, { "Cache-Control": "public, max-age=3600" });
    } catch (err) {
      // Upstream (Nominatim) failed or was rate-limited. Tell the client so it
      // can prompt the user to drop a pin on the map instead of silently
      // showing no results.
      console.error("Geocode failed", err);
      return json({ results: [], error: "geocode_unavailable" }, 200);
    }
  }

  // Everything below this point reads or writes D1. Make sure the tables exist
  // first: this lets a freshly auto-provisioned database initialise itself on
  // the first request, so no separate "migrations apply" step is needed.
  await ensureSchema(env);

  // --- Public list of members ---
  if (pathname === "/api/members" && method === "GET") {
    const members = await listPublicMembers(env);
    return json({ members });
  }

  // --- Create a submission ---
  if (pathname === "/api/members" && method === "POST") {
    return handleCreate(request, env);
  }

  // --- Member by id: GET (load for edit) / PUT (update) / DELETE ---
  const memberMatch = pathname.match(/^\/api\/members\/([A-Za-z0-9_-]+)$/);
  if (memberMatch) {
    const publicId = memberMatch[1]!;
    if (method === "GET") return handleGetOne(request, env, publicId);
    if (method === "PUT") return handleUpdate(request, env, publicId);
    if (method === "DELETE") return handleDelete(request, env, publicId);
    return json({ error: "Method not allowed" }, 405);
  }

  // --- Admin ---
  if (pathname === "/api/admin/login" && method === "POST") {
    return handleAdminLogin(request, env);
  }
  if (pathname === "/api/admin/logout" && method === "POST") {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Set-Cookie": sessionCookie("", 0),
        "Cache-Control": "no-store",
      },
    });
  }
  if (pathname === "/api/admin/me" && method === "GET") {
    return json({ admin: await isAdmin(request, env) });
  }
  if (pathname === "/api/admin/members" && method === "GET") {
    if (!(await isAdmin(request, env))) return json({ error: "Unauthorized" }, 401);
    const members = await listAllMembers(env);
    return json({ members });
  }
  // --- Admin: mint a fresh, shareable edit link for one member ---
  const editLinkMatch = pathname.match(
    /^\/api\/admin\/members\/([A-Za-z0-9_-]+)\/edit-link$/,
  );
  if (editLinkMatch && method === "POST") {
    return handleAdminEditLink(request, env, editLinkMatch[1]!);
  }
  // --- Admin: bulk status/consent/delete on many members ---
  if (pathname === "/api/admin/bulk" && method === "POST") {
    return handleAdminBulk(request, env);
  }
  // --- Admin: CSV import (rows already geocoded client-side) ---
  if (pathname === "/api/admin/import" && method === "POST") {
    return handleAdminImport(request, env);
  }

  return json({ error: "Not found" }, 404);
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

async function isAdmin(request: Request, env: Env): Promise<boolean> {
  if (!env.SESSION_SECRET) return false;
  const cookies = parseCookies(request.headers.get("Cookie"));
  return verifyAdminSession(cookies[ADMIN_COOKIE], env.SESSION_SECRET);
}

/** Extract the member credential from header or query string. */
function memberCredential(request: Request, url: URL): string | null {
  return request.headers.get("X-Edit-Token") || url.searchParams.get("token") || null;
}

/**
 * Authorise a member-level action on `row`. Allowed when the caller is admin,
 * presents a valid member-session token (from a magic link) for this id, or
 * presents the raw edit token whose hash matches.
 */
async function authorizeMember(
  request: Request,
  env: Env,
  url: URL,
  row: MemberRow,
): Promise<{ ok: boolean; admin: boolean }> {
  if (await isAdmin(request, env)) return { ok: true, admin: true };

  const cred = memberCredential(request, url);
  if (!cred) return { ok: false, admin: false };

  // Signed member session (contains a dot) issued by the magic-link flow.
  if (cred.includes(".") && env.SESSION_SECRET) {
    const pid = await verifyMemberSession(cred, env.SESSION_SECRET);
    if (pid && pid === row.public_id) return { ok: true, admin: false };
  }

  // Raw edit token: compare hashes in constant time.
  const hash = await sha256Hex(cred);
  if (timingSafeEqual(hash, row.edit_token_hash)) return { ok: true, admin: false };

  return { ok: false, admin: false };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  const ct = request.headers.get("Content-Type") || "";
  if (!ct.includes("application/json")) return null;
  try {
    const body = await request.json();
    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function verifyTurnstile(env: Env, token: unknown, ip: string | null): Promise<boolean> {
  // Only enforced when a secret is configured.
  if (!env.TURNSTILE_SECRET) return true;
  if (typeof token !== "string" || !token) return false;
  const form = new FormData();
  form.set("secret", env.TURNSTILE_SECRET);
  form.set("response", token);
  if (ip) form.set("remoteip", ip);
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: form,
    });
    const data = (await res.json()) as { success: boolean };
    return data.success === true;
  } catch {
    return false;
  }
}

function baseUrl(request: Request, env: Env): string {
  if (env.PUBLIC_BASE_URL) return env.PUBLIC_BASE_URL.replace(/\/$/, "");
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

async function handleCreate(request: Request, env: Env): Promise<Response> {
  if (!sameOrigin(request)) return json({ error: "Bad origin" }, 403);

  const body = await readJson(request);
  if (!body) return json({ error: "Invalid request body" }, 400);

  // Honeypot: bots fill hidden fields a human never sees.
  if (typeof body.website === "string" && body.website.trim() !== "") {
    return json({ ok: true, id: "skipped" }); // silently accept + drop
  }

  const ip = request.headers.get("CF-Connecting-IP");
  if (!(await verifyTurnstile(env, body.turnstileToken, ip))) {
    return json({ error: "Spam check failed. Please try again." }, 400);
  }

  // Salt the IP with the deployment secret so the stored value can't be
  // reversed via a precomputed table. Used only for rate limiting.
  const ipHash = ip ? await sha256Hex(`${env.SESSION_SECRET ?? "ip-salt"}:${ip}`) : null;
  if (ipHash) {
    const recent = await countRecentByIp(env, ipHash, Date.now() - SUBMIT_WINDOW_MS);
    if (recent >= SUBMIT_LIMIT) {
      return json({ error: "Too many submissions. Please try again later." }, 429);
    }
  }

  const result = validateSubmission(body);
  if (!result.ok || !result.value) {
    return json({ error: "Validation failed", fields: result.errors }, 400);
  }
  const v = result.value;

  const publicId = randomToken(9);
  const editToken = randomToken(32);
  const editTokenHash = await sha256Hex(editToken);
  const status = env.MODERATION_ENABLED === "true" ? "pending" : "published";

  await insertMember(env, {
    public_id: publicId,
    display_name: v.display_name,
    email: v.email,
    location_name: v.location_name,
    lat: v.lat,
    lng: v.lng,
    bio: v.bio,
    contact_label: v.contact_label,
    contact_url: v.contact_url,
    consent_public: v.consent_public ? 1 : 0,
    status,
    edit_token_hash: editTokenHash,
    ip_hash: ipHash,
  });

  const editUrl = `${baseUrl(request, env)}/edit?id=${publicId}#k=${editToken}`;

  return json({
    ok: true,
    id: publicId,
    editToken,
    editUrl,
    status,
    moderated: status === "pending",
  });
}

async function handleGetOne(request: Request, env: Env, publicId: string): Promise<Response> {
  const row = await getByPublicId(env, publicId);
  if (!row) return json({ error: "Not found" }, 404);

  const url = new URL(request.url);
  const auth = await authorizeMember(request, env, url, row);
  if (!auth.ok) return json({ error: "Unauthorized" }, 401);

  return json({ member: toOwner(row) });
}

async function handleUpdate(request: Request, env: Env, publicId: string): Promise<Response> {
  if (!sameOrigin(request)) return json({ error: "Bad origin" }, 403);

  const row = await getByPublicId(env, publicId);
  if (!row) return json({ error: "Not found" }, 404);

  const url = new URL(request.url);
  const auth = await authorizeMember(request, env, url, row);
  if (!auth.ok) return json({ error: "Unauthorized" }, 401);

  const body = await readJson(request);
  if (!body) return json({ error: "Invalid request body" }, 400);

  // Edits don't force the opt-in: a member may untick it to hide themselves.
  const result = validateSubmission(body, { requireConsent: false });
  if (!result.ok || !result.value) {
    return json({ error: "Validation failed", fields: result.errors }, 400);
  }
  const v = result.value;

  if (auth.admin) {
    // Admins may also change moderation status + consent.
    const status = ["published", "pending", "hidden"].includes(String(body.status))
      ? String(body.status)
      : row.status;
    await adminUpdateMember(env, publicId, {
      display_name: v.display_name,
      email: v.email,
      location_name: v.location_name,
      lat: v.lat,
      lng: v.lng,
      bio: v.bio,
      contact_label: v.contact_label,
      contact_url: v.contact_url,
      status,
      consent_public: v.consent_public ? 1 : 0,
    });
  } else {
    await updateMember(env, publicId, {
      display_name: v.display_name,
      email: v.email,
      location_name: v.location_name,
      lat: v.lat,
      lng: v.lng,
      bio: v.bio,
      contact_label: v.contact_label,
      contact_url: v.contact_url,
      consent_public: v.consent_public ? 1 : 0,
    });
  }

  const updated = await getByPublicId(env, publicId);
  return json({ ok: true, member: updated ? toOwner(updated) : null });
}

async function handleDelete(request: Request, env: Env, publicId: string): Promise<Response> {
  if (!sameOrigin(request)) return json({ error: "Bad origin" }, 403);

  const row = await getByPublicId(env, publicId);
  if (!row) return json({ error: "Not found" }, 404);

  const url = new URL(request.url);
  const auth = await authorizeMember(request, env, url, row);
  if (!auth.ok) return json({ error: "Unauthorized" }, 401);

  await deleteMember(env, publicId);
  return json({ ok: true });
}

/**
 * Admin: mint a fresh edit link for a member. We only ever store the hash of
 * the edit token, so the original can't be recovered — instead we generate a
 * new token, store its hash (invalidating any previous link), and hand the
 * full URL back to the admin to pass on to the member.
 */
async function handleAdminEditLink(
  request: Request,
  env: Env,
  publicId: string,
): Promise<Response> {
  if (!sameOrigin(request)) return json({ error: "Bad origin" }, 403);
  if (!(await isAdmin(request, env))) return json({ error: "Unauthorized" }, 401);

  const row = await getByPublicId(env, publicId);
  if (!row) return json({ error: "Not found" }, 404);

  const editToken = randomToken(32);
  await setEditTokenHash(env, publicId, await sha256Hex(editToken));
  const editUrl = `${baseUrl(request, env)}/edit?id=${publicId}#k=${editToken}`;
  return json({ ok: true, editUrl });
}

/** Admin: apply a status/consent/delete action across many members. */
async function handleAdminBulk(request: Request, env: Env): Promise<Response> {
  if (!sameOrigin(request)) return json({ error: "Bad origin" }, 403);
  if (!(await isAdmin(request, env))) return json({ error: "Unauthorized" }, 401);

  const body = await readJson(request);
  const ids = Array.isArray(body?.ids)
    ? body!.ids.filter((x): x is string => typeof x === "string")
    : [];
  const action = typeof body?.action === "string" ? body.action : "";
  if (ids.length === 0) return json({ error: "No members selected." }, 400);

  switch (action) {
    case "publish":
      await bulkSetStatus(env, ids, "published");
      break;
    case "hide":
      await bulkSetStatus(env, ids, "hidden");
      break;
    case "pending":
      await bulkSetStatus(env, ids, "pending");
      break;
    case "consent_on":
      await bulkSetConsent(env, ids, 1);
      break;
    case "consent_off":
      await bulkSetConsent(env, ids, 0);
      break;
    case "delete":
      await bulkDeleteMembers(env, ids);
      break;
    default:
      return json({ error: "Unknown action." }, 400);
  }
  return json({ ok: true, count: ids.length });
}

/**
 * Admin: bulk CSV import. Rows arrive already geocoded by the admin UI (which
 * resolves each free-text location to lat/lng through the geocode proxy and
 * lets the admin review/fix matches first), so the Worker just validates and
 * inserts. Each row gets a fresh public id + edit-token hash.
 */
async function handleAdminImport(request: Request, env: Env): Promise<Response> {
  if (!sameOrigin(request)) return json({ error: "Bad origin" }, 403);
  if (!(await isAdmin(request, env))) return json({ error: "Unauthorized" }, 401);

  const body = await readJson(request);
  const rows = Array.isArray(body?.members) ? body!.members : null;
  if (!rows) return json({ error: "Expected a members array." }, 400);
  if (rows.length > IMPORT_MAX_ROWS) {
    return json({ error: `Too many rows (max ${IMPORT_MAX_ROWS}).` }, 400);
  }

  const prepared: InsertMember[] = [];
  const skipped: { row: number; reason: string }[] = [];

  for (let i = 0; i < rows.length; i++) {
    const r = (rows[i] ?? {}) as Record<string, unknown>;
    const result = validateSubmission(
      {
        display_name: r.display_name ?? r.name,
        location_name: r.location_name ?? r.location,
        bio: r.bio,
        contact: r.contact ?? r.contactLabel,
        email: r.email,
        lat: r.lat,
        lng: r.lng,
        consent_public: true,
      },
      { requireConsent: false },
    );
    if (!result.ok || !result.value) {
      skipped.push({ row: i + 1, reason: Object.values(result.errors)[0] || "Invalid row" });
      continue;
    }
    const v = result.value;
    // Contact may arrive pre-split (label + url) from our own export.
    const contactLabel =
      typeof r.contactLabel === "string" && r.contactLabel ? r.contactLabel : v.contact_label;
    const contactUrl =
      typeof r.contactUrl === "string" ? r.contactUrl : v.contact_url;
    const status = ["published", "pending", "hidden"].includes(String(r.status))
      ? String(r.status)
      : "published";
    const consent = r.consent_public === false || r.consentPublic === false ? 0 : 1;

    prepared.push({
      public_id: randomToken(9),
      display_name: v.display_name,
      email: v.email,
      location_name: v.location_name,
      lat: v.lat,
      lng: v.lng,
      bio: v.bio,
      contact_label: contactLabel,
      contact_url: contactUrl,
      consent_public: consent,
      status,
      edit_token_hash: await sha256Hex(randomToken(32)),
      ip_hash: null,
    });
  }

  for (let i = 0; i < prepared.length; i += IMPORT_CHUNK) {
    await bulkInsertMembers(env, prepared.slice(i, i + IMPORT_CHUNK));
  }

  return json({ ok: true, imported: prepared.length, skipped });
}

async function handleAdminLogin(request: Request, env: Env): Promise<Response> {
  if (!sameOrigin(request)) return json({ error: "Bad origin" }, 403);
  if (!isAdminConfigured(env)) {
    return json({ error: "Admin is not configured on this deployment." }, 503);
  }
  const body = await readJson(request);
  const password = typeof body?.password === "string" ? body.password : "";

  // Constant-time compare against the configured admin password.
  const a = await sha256Hex(password);
  const b = await sha256Hex(env.ADMIN_PASSWORD!);
  if (!timingSafeEqual(a, b)) {
    return json({ error: "Incorrect password." }, 401);
  }

  const token = await createAdminSession(env.SESSION_SECRET!);
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": sessionCookie(token, 60 * 60 * 12),
      "Cache-Control": "no-store",
    },
  });
}
