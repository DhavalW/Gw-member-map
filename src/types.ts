export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;

  // Public vars (wrangler.json -> vars)
  APP_NAME: string;
  PUBLIC_BASE_URL: string;
  MODERATION_ENABLED: string;
  // Public Turnstile site key (safe to expose). Empty disables the widget.
  TURNSTILE_SITE_KEY: string;

  // Secrets (wrangler secret put ...)
  ADMIN_PASSWORD?: string;
  SESSION_SECRET?: string;
  // Optional Cloudflare Turnstile (spam protection)
  TURNSTILE_SECRET?: string;
  // Optional Resend-compatible email provider for magic links
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
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
}

/** Fields returned to the owner/admin when editing (includes email). */
export interface OwnerMember extends PublicMember {
  email: string | null;
  status: string;
  consentPublic: boolean;
}
