import type { Env } from "./types";

const encoder = new TextEncoder();

/** Cryptographically random url-safe token. */
export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return base64url(buf);
}

export function base64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Constant-time string comparison. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function hmacSign(secret: string, data: string): Promise<string> {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return base64url(sig);
}

const SESSION_TTL_SECONDS = 60 * 60 * 12; // 12 hours

/** Create a signed admin session token: base64url(payload).signature */
export async function createAdminSession(secret: string): Promise<string> {
  const payload = JSON.stringify({
    role: "admin",
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
    nonce: randomToken(8),
  });
  const b64 = base64url(encoder.encode(payload));
  const sig = await hmacSign(secret, b64);
  return `${b64}.${sig}`;
}

export async function verifyAdminSession(
  token: string | undefined,
  secret: string,
): Promise<boolean> {
  const payload = await verifySigned(token, secret);
  return payload?.role === "admin";
}

const MEMBER_SESSION_TTL_SECONDS = 60 * 60; // 1 hour after magic-link click

/** Signed, member-scoped session (issued when an email magic link is used). */
export async function createMemberSession(
  secret: string,
  publicId: string,
): Promise<string> {
  const payload = JSON.stringify({
    role: "member",
    pid: publicId,
    exp: Math.floor(Date.now() / 1000) + MEMBER_SESSION_TTL_SECONDS,
    nonce: randomToken(8),
  });
  const b64 = base64url(encoder.encode(payload));
  const sig = await hmacSign(secret, b64);
  return `${b64}.${sig}`;
}

/** Returns the public_id a member-session token authorises, or null. */
export async function verifyMemberSession(
  token: string | undefined,
  secret: string,
): Promise<string | null> {
  const payload = await verifySigned(token, secret);
  if (payload?.role === "member" && typeof payload.pid === "string") {
    return payload.pid;
  }
  return null;
}

async function verifySigned(
  token: string | undefined,
  secret: string,
): Promise<Record<string, unknown> | null> {
  if (!token) return null;
  const [b64, sig] = token.split(".");
  if (!b64 || !sig) return null;
  const expected = await hmacSign(secret, b64);
  if (!timingSafeEqual(sig, expected)) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(fromBase64url(b64)));
    if (typeof payload.exp !== "number" || payload.exp <= Math.floor(Date.now() / 1000)) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

function fromBase64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export const ADMIN_COOKIE = "admin_session";

export function sessionCookie(value: string, maxAge: number): string {
  return [
    `${ADMIN_COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    `Max-Age=${maxAge}`,
  ].join("; ");
}

/**
 * For cookie-authenticated state-changing requests, require the Origin (or
 * Referer) to match the request host. This blocks cross-site request forgery.
 */
export function sameOrigin(request: Request): boolean {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  if (origin) {
    try {
      return new URL(origin).host === url.host;
    } catch {
      return false;
    }
  }
  // Fall back to Referer when Origin is absent.
  const referer = request.headers.get("Referer");
  if (referer) {
    try {
      return new URL(referer).host === url.host;
    } catch {
      return false;
    }
  }
  // No Origin/Referer on a state-changing request: reject to be safe.
  return false;
}

/** HTML-escape a string for safe interpolation into markup. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Security + caching headers applied to every response. The CSP is strict:
 * scripts/styles are same-origin only (Leaflet is vendored locally), map
 * tiles come from the OpenStreetMap tile servers, and the form may call the
 * Nominatim geocoder.
 */
export function securityHeaders(): Record<string, string> {
  const csp = [
    "default-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    // 'self' for our vendored Leaflet; challenges.cloudflare.com lets the
    // optional Turnstile anti-spam widget load without further CSP edits.
    "script-src 'self' https://challenges.cloudflare.com",
    "style-src 'self'",
    "img-src 'self' data: blob: https://*.tile.openstreetmap.org",
    "connect-src 'self' https://nominatim.openstreetmap.org",
    "frame-src https://challenges.cloudflare.com",
    "font-src 'self'",
    "upgrade-insecure-requests",
  ].join("; ");

  return {
    "Content-Security-Policy": csp,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "geolocation=(self), camera=(), microphone=(), payment=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  };
}

export function isAdminConfigured(env: Env): boolean {
  return Boolean(env.ADMIN_PASSWORD && env.SESSION_SECRET);
}
