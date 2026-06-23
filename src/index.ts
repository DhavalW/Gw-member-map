import type { Env, MemberRow } from "./types";
import {
  ADMIN_COOKIE,
  createAdminSession,
  createMemberSession,
  escapeHtml,
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
  consumeMagicLink,
  countRecentByIp,
  createMagicLink,
  deleteMember,
  findByEmail,
  getByPublicId,
  insertMember,
  listAllMembers,
  listPublicMembers,
  toOwner,
  updateMember,
} from "./db";
import { geocode } from "./geocode";
import { emailConfigured, sendEmail } from "./email";
import { validateSubmission } from "./validate";

const SUBMIT_LIMIT = 5; // submissions per IP per hour
const SUBMIT_WINDOW_MS = 60 * 60 * 1000;
const MAGIC_TTL_MS = 30 * 60 * 1000; // 30 minutes

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
      appName: env.APP_NAME || "Member Map",
      moderationEnabled: env.MODERATION_ENABLED === "true",
      adminConfigured: isAdminConfigured(env),
      emailConfigured: emailConfigured(env),
      turnstileSiteKey: env.TURNSTILE_SITE_KEY || "",
    });
  }

  // --- Public list of members ---
  if (pathname === "/api/members" && method === "GET") {
    const members = await listPublicMembers(env);
    return json({ members });
  }

  // --- Create a submission ---
  if (pathname === "/api/members" && method === "POST") {
    return handleCreate(request, env);
  }

  // --- Geocoding proxy for the form's location search ---
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

  // --- Email magic-link request (anti-enumeration: always 200) ---
  if (pathname === "/api/request-edit-link" && method === "POST") {
    return handleRequestEditLink(request, env);
  }

  // --- Consume a magic link -> redirect into the edit page with a session ---
  if (pathname === "/api/magic" && method === "GET") {
    return handleMagicConsume(request, env, url);
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

  // If they gave an email and email is configured, also send the link.
  if (v.email && emailConfigured(env)) {
    await sendEmail(
      env,
      v.email,
      `Your ${env.APP_NAME || "Member Map"} edit link`,
      `Thanks for joining the map! Edit or remove your entry any time:\n\n${editUrl}\n\nKeep this link private — anyone with it can edit your entry.`,
      editEmailHtml(env, editUrl),
    );
  }

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

async function handleRequestEditLink(request: Request, env: Env): Promise<Response> {
  if (!sameOrigin(request)) return json({ error: "Bad origin" }, 403);
  const body = await readJson(request);
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";

  // Always respond the same way so the endpoint can't be used to test which
  // emails exist in the directory.
  const genericOk = json({
    ok: true,
    message: "If that email is on the map, we've sent an edit link.",
  });

  if (!email || !emailConfigured(env) || !env.SESSION_SECRET) return genericOk;

  const members = await findByEmail(env, email);
  for (const m of members) {
    const token = randomToken(32);
    const tokenHash = await sha256Hex(token);
    await createMagicLink(env, tokenHash, m.id, MAGIC_TTL_MS);
    const link = `${baseUrl(request, env)}/api/magic?token=${token}`;
    await sendEmail(
      env,
      email,
      `Your ${env.APP_NAME || "Member Map"} sign-in link`,
      `Click to edit your map entry (valid for 30 minutes):\n\n${link}`,
      editEmailHtml(env, link),
    );
  }
  return genericOk;
}

async function handleMagicConsume(request: Request, env: Env, url: URL): Promise<Response> {
  const token = url.searchParams.get("token");
  if (!token || !env.SESSION_SECRET) {
    return Response.redirect(`${baseUrl(request, env)}/edit?error=invalid`, 302);
  }
  const tokenHash = await sha256Hex(token);
  const memberId = await consumeMagicLink(env, tokenHash);
  if (!memberId) {
    return Response.redirect(`${baseUrl(request, env)}/edit?error=expired`, 302);
  }
  const row = await env.DB.prepare(`SELECT * FROM members WHERE id = ?`)
    .bind(memberId)
    .first<MemberRow>();
  if (!row) {
    return Response.redirect(`${baseUrl(request, env)}/edit?error=invalid`, 302);
  }
  const session = await createMemberSession(env.SESSION_SECRET, row.public_id);
  return Response.redirect(
    `${baseUrl(request, env)}/edit?id=${row.public_id}#k=${session}`,
    302,
  );
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

function editEmailHtml(env: Env, link: string): string {
  const app = escapeHtml(env.APP_NAME || "Member Map");
  const safe = escapeHtml(link);
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#1a1a1a">
    <h2 style="margin:0 0 12px">${app}</h2>
    <p>Use the button below to edit or remove your entry on the map.</p>
    <p><a href="${safe}" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Edit my entry</a></p>
    <p style="color:#666;font-size:13px">If the button doesn't work, copy this link:<br>${safe}</p>
    <p style="color:#666;font-size:13px">Keep this link private — anyone with it can edit your entry.</p>
  </body></html>`;
}
