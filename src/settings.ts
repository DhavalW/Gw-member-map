import type { Env } from "./types";
import { ensureSchema } from "./schema";
import { loadSettings, upsertSettings } from "./db";
import { isAdminConfigured } from "./security";

/**
 * Runtime-configurable settings.
 *
 * Every community that deploys this map can rebrand it and tweak its
 * integrations from the admin dashboard — no redeploy required. Each setting
 * resolves in this order:
 *
 *   1. the value saved in the `settings` D1 table (set from the dashboard);
 *   2. the matching deployment variable / secret in `wrangler.json` / Wrangler
 *      secrets (a fresh deploy's starting point);
 *   3. the hard-coded default below (ships as Midhrami Studios).
 *
 * The admin password and session secret are deliberately NOT in this list:
 * they are authentication secrets and must stay as encrypted deployment
 * secrets, never editable from (or readable by) the dashboard.
 */
export type SettingType = "text" | "url" | "secret";

export interface SettingDef {
  /** camelCase key used in the API and as the `settings` table primary key. */
  key: string;
  /** Deployment variable/secret used as the fallback when nothing is saved. */
  envVar: keyof Env;
  label: string;
  description: string;
  type: SettingType;
  /** Exposed to the public front-end via `/api/config`. Never true for secrets. */
  public: boolean;
  /** Must be non-empty when saved. */
  required: boolean;
  default: string;
  maxLength: number;
}

export const SETTING_DEFS: SettingDef[] = [
  {
    key: "appName",
    envVar: "APP_NAME",
    label: "Site title",
    description:
      "Shown in the browser tab and as the main heading on the map page.",
    type: "text",
    public: true,
    required: true,
    default: "Midhrami Studios Member Map",
    maxLength: 120,
  },
  {
    key: "communityName",
    envVar: "COMMUNITY_NAME",
    label: "Community name",
    description:
      "Your community's name. Used for branding, the header link, and the export filename.",
    type: "text",
    public: true,
    required: true,
    default: "Midhrami Studios",
    maxLength: 80,
  },
  {
    key: "communityUrl",
    envVar: "COMMUNITY_URL",
    label: "Community website",
    description:
      "The link behind your community name in the header. Must be a full https:// URL.",
    type: "url",
    public: true,
    required: true,
    default: "https://midhrami.com",
    maxLength: 300,
  },
  {
    key: "publicBaseUrl",
    envVar: "PUBLIC_BASE_URL",
    label: "Public base URL",
    description:
      "Absolute origin used to build members' edit links (e.g. https://members.example.com). Leave blank to use the address the site is served from — only set this if the map sits behind a different public hostname.",
    type: "url",
    public: false,
    required: false,
    default: "",
    maxLength: 300,
  },
  {
    key: "turnstileSiteKey",
    envVar: "TURNSTILE_SITE_KEY",
    label: "Turnstile site key",
    description:
      "Public Cloudflare Turnstile key. When set (together with the secret below) an anti-spam widget is shown on the sign-up form. Leave blank to disable it.",
    type: "text",
    public: true,
    required: false,
    default: "",
    maxLength: 100,
  },
  {
    key: "turnstileSecret",
    envVar: "TURNSTILE_SECRET",
    label: "Turnstile secret",
    description:
      "Secret half of the Turnstile key pair, used to verify submissions server-side. Stored in the database and never shown again — leave blank to keep the current value, or tick “Clear” to remove it.",
    type: "secret",
    public: false,
    required: false,
    default: "",
    maxLength: 200,
  },
];

const DEF_BY_KEY = new Map(SETTING_DEFS.map((d) => [d.key, d]));

/**
 * Load the saved overrides from D1. Never throws: if the database is briefly
 * unavailable (or the table doesn't exist yet) we fall back to env/defaults so
 * the public config endpoint keeps working.
 */
async function loadOverrides(env: Env): Promise<Record<string, string>> {
  try {
    await ensureSchema(env);
    return await loadSettings(env);
  } catch {
    return {};
  }
}

function resolveValue(def: SettingDef, overrides: Record<string, string>, env: Env): string {
  const saved = overrides[def.key];
  if (saved !== undefined) return saved;
  const envVal = env[def.envVar];
  if (typeof envVal === "string" && envVal !== "") return envVal;
  return def.default;
}

export interface ResolvedConfig {
  appName: string;
  communityName: string;
  communityUrl: string;
  publicBaseUrl: string;
  turnstileSiteKey: string;
  turnstileSecret: string;
}

/** Fully resolved settings, for server-side use (turnstile, edit links, …). */
export async function getResolvedConfig(env: Env): Promise<ResolvedConfig> {
  const overrides = await loadOverrides(env);
  const out: Record<string, string> = {};
  for (const def of SETTING_DEFS) out[def.key] = resolveValue(def, overrides, env);
  return out as unknown as ResolvedConfig;
}

/** The subset of settings safe to expose to the public front-end. */
export async function getPublicConfig(env: Env): Promise<Record<string, unknown>> {
  const cfg = await getResolvedConfig(env);
  return {
    appName: cfg.appName,
    communityName: cfg.communityName,
    communityUrl: cfg.communityUrl,
    // Moderation is always on: every member submission is held as "pending"
    // until an admin publishes it. (The legacy MODERATION_ENABLED toggle no
    // longer disables this.)
    moderationEnabled: true,
    adminConfigured: isAdminConfigured(env),
    turnstileSiteKey: cfg.turnstileSiteKey,
  };
}

export interface AdminSettingView {
  key: string;
  label: string;
  description: string;
  type: SettingType;
  required: boolean;
  /** Where the effective value currently comes from. */
  source: "dashboard" | "deployment" | "default";
  /** Resolved value for editable (non-secret) fields. Empty string for secrets. */
  value: string;
  /** Secrets only: whether a value is currently configured. */
  isSet?: boolean;
}

/**
 * The settings the dashboard renders. Secret values are never returned — only
 * whether one is set — so they can't leak back to the browser.
 */
export async function getAdminSettings(env: Env): Promise<AdminSettingView[]> {
  const overrides = await loadOverrides(env);
  return SETTING_DEFS.map((def) => {
    const resolved = resolveValue(def, overrides, env);
    const source: AdminSettingView["source"] =
      overrides[def.key] !== undefined
        ? "dashboard"
        : typeof env[def.envVar] === "string" && env[def.envVar]
          ? "deployment"
          : "default";
    if (def.type === "secret") {
      return {
        key: def.key,
        label: def.label,
        description: def.description,
        type: def.type,
        required: def.required,
        source,
        value: "",
        isSet: resolved !== "",
      };
    }
    return {
      key: def.key,
      label: def.label,
      description: def.description,
      type: def.type,
      required: def.required,
      source,
      value: resolved,
    };
  });
}

export interface SaveSettingsResult {
  ok: boolean;
  errors?: Record<string, string>;
}

/**
 * Validate and persist dashboard setting changes.
 *
 * - `values`: key -> new value. For secret fields a blank value is ignored
 *   (so saving the form doesn't wipe a secret the admin didn't retype).
 * - `clear`: keys to remove from the DB, reverting them to the env/default.
 */
export async function saveSettings(
  env: Env,
  values: Record<string, unknown>,
  clear: string[] = [],
): Promise<SaveSettingsResult> {
  const errors: Record<string, string> = {};
  const upserts: { key: string; value: string }[] = [];
  const deletes: string[] = [];

  for (const key of clear) {
    if (DEF_BY_KEY.has(key)) deletes.push(key);
  }
  const clearing = new Set(deletes);

  for (const def of SETTING_DEFS) {
    if (clearing.has(def.key)) continue; // cleared values win over submitted ones
    if (!(def.key in values)) continue; // field not submitted
    const raw = typeof values[def.key] === "string" ? (values[def.key] as string).trim() : "";

    // Blank secret = "leave unchanged" (use the Clear list to remove one).
    if (def.type === "secret" && raw === "") continue;

    if (def.required && raw === "") {
      errors[def.key] = `${def.label} is required.`;
      continue;
    }
    if (raw.length > def.maxLength) {
      errors[def.key] = `${def.label} must be ${def.maxLength} characters or fewer.`;
      continue;
    }
    if (def.type === "url" && raw !== "") {
      let valid = false;
      try {
        const u = new URL(raw);
        valid = u.protocol === "http:" || u.protocol === "https:";
      } catch {
        valid = false;
      }
      if (!valid) {
        errors[def.key] = `${def.label} must be a valid http(s) URL.`;
        continue;
      }
    }
    upserts.push({ key: def.key, value: raw });
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  await upsertSettings(env, upserts, deletes);
  return { ok: true };
}
