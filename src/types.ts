export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;

  // Deployment vars. None are declared in `wrangler.json` — deliberately, for
  // two reasons. First, a var declared there is re-applied on every deploy and
  // silently overwrites whatever value the operator set in the Cloudflare
  // dashboard (`keep_vars: true` only preserves vars the config file does NOT
  // declare), so a rebranded deployment would snap back to the shipped
  // defaults on the next push or daily auto-sync. Second, the "Deploy to
  // Cloudflare" wizard turns every declared var into a field the operator has
  // to fill in before the deploy can proceed. Set vars in the dashboard
  // (Settings → Variables and Secrets, type "Text") or from /admin → Settings;
  // left undefined they fall back to the defaults in `settings.ts`.
  APP_NAME?: string;
  // Community this map belongs to (branding + links).
  COMMUNITY_NAME?: string;
  COMMUNITY_URL?: string;
  // The public base URL is derived from the incoming request when unset; an
  // unset Turnstile key disables the anti-spam widget.
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
