import type { Env } from "./types";
import { getResolvedConfig } from "./settings";

export interface GeocodeResult {
  label: string;
  lat: number;
  lng: number;
}

/**
 * Turn a dashboard-configurable text value into something safe to put in an
 * HTTP header. Header values are ISO-8859-1 byte strings: `fetch` throws a
 * TypeError for any character above U+00FF (curly quotes, dashes, emoji,
 * non-Latin scripts…) and for CR/LF, and admins type branding text freely —
 * so an unsanitised value here would take the whole geocoder down (this has
 * happened). Anything outside printable ASCII is collapsed to a space; an
 * empty result falls back to `fallback`.
 */
function headerSafe(value: string, fallback: string): string {
  const safe = value.replace(/[^\x20-\x7E]+/g, " ").replace(/ +/g, " ").trim();
  return safe || fallback;
}

/**
 * Forward-geocode a place name via OpenStreetMap Nominatim, used by the
 * location search boxes on the sign-up form, the member edit form, and the
 * admin CSV import (all through our proxy, so the browser never hits
 * Nominatim directly).
 *
 * Nominatim's usage policy requires an identifying User-Agent and modest
 * request rates; this proxy is for interactive lookups only.
 */
export async function geocode(
  query: string,
  env: Env,
  limit = 5,
): Promise<GeocodeResult[]> {
  // Cap the query length so the public proxy can't be used to relay huge
  // payloads upstream; real place searches are far shorter than this.
  const q = query.trim().slice(0, 200);
  if (q.length < 2) return [];

  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", q);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "0");
  url.searchParams.set("limit", String(Math.min(Math.max(limit, 1), 8)));

  // Resolved settings (dashboard → env var → default), not raw env vars, so a
  // deployment branded from the admin dashboard identifies as itself here too.
  // The values are free-form admin input and go into HTTP headers below, so
  // they MUST pass through headerSafe() — and a config-layer failure must
  // never stop the lookup itself (location search worked before it ever
  // depended on settings, and has to keep working if that dependency breaks).
  let cfg: { appName?: string; publicBaseUrl?: string } = {};
  try {
    cfg = await getResolvedConfig(env);
  } catch {
    // fall through to the defaults below
  }
  const appName = headerSafe(cfg.appName || "", "MemberMap");
  const contactUrl = headerSafe(cfg.publicBaseUrl || "", "https://workers.dev");

  const res = await fetch(url.toString(), {
    headers: {
      // Nominatim's usage policy requires a descriptive User-Agent with a way
      // to make contact; a generic one risks being blocked outright.
      "User-Agent": `${appName} member directory (+${contactUrl})`,
      "Accept-Language": "en",
      "Referer": contactUrl,
    },
    // Cache identical lookups at the edge to stay well within usage limits.
    cf: { cacheTtl: 60 * 60 * 24, cacheEverything: true },
  });

  // Surface upstream failures (e.g. 403/429 from Nominatim) to the caller so it
  // can inform the user, rather than masquerading them as "no matches".
  if (!res.ok) {
    throw new Error(`Nominatim responded ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as Array<{
    display_name: string;
    lat: string;
    lon: string;
  }>;

  return data
    .map((d) => ({
      label: d.display_name,
      lat: Number(d.lat),
      lng: Number(d.lon),
    }))
    .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng));
}
