export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;

  // Public vars (wrangler.json -> vars)
  APP_NAME: string;
  // Community this map belongs to (branding + links).
  COMMUNITY_NAME: string;
  COMMUNITY_URL: string;
  // Optional vars — deliberately NOT declared in `wrangler.json`, because the
  // "Deploy to Cloudflare" wizard turns every declared var into a field the
  // operator has to fill in before the deploy can proceed. Left undefined they
  // fall back to a sensible default (see `settings.ts`): the public base URL is
  // derived from the incoming request, and an unset Turnstile key disables the
  // widget. Both are still settable from /admin → Settings afterwards.
  PUBLIC_BASE_URL?: string;
  TURNSTILE_SITE_KEY?: string;

  // Secrets (wrangler secret put ...)
  ADMIN_PASSWORD?: string;
  SESSION_SECRET?: string;
  // Optional Cloudflare Turnstile (spam protection)
  TURNSTILE_SECRET?: string;
}

export interface MemberRow {
  id: number;
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
  created_at: number;
  updated_at: number;
  // Timestamp (ms) the member's profile image was last set. NULL when the member
  // has no image. Doubles as a cache-busting version for the image URL. The
  // image bytes themselves live in the separate `member_images` table so this
  // flag can ride along on list queries without pulling blobs.
  image_updated_at: number | null;
}

/** Fields safe to expose on the public map. */
export interface PublicMember {
  id: string;
  name: string;
  location: string;
  lat: number;
  lng: number;
  bio: string;
  contactLabel: string;
  contactUrl: string;
  createdAt: number;
  /** ms timestamp the profile image was last set, or null if none. */
  imageUpdatedAt: number | null;
}

/** Fields returned to the owner/admin when editing (includes email). */
export interface OwnerMember extends PublicMember {
  email: string | null;
  status: string;
  consentPublic: boolean;
}
