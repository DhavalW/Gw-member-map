import type { Env } from "./types";

export interface GeocodeResult {
  label: string;
  lat: number;
  lng: number;
}

/**
 * Forward-geocode a place name via OpenStreetMap Nominatim. Used both by the
 * client search box (through our proxy, so the browser never hits Nominatim
 * directly) and as a server-side fallback when a submission has no map pin.
 *
 * Nominatim's usage policy requires an identifying User-Agent and modest
 * request rates; this proxy is for interactive lookups only.
 */
export async function geocode(
  query: string,
  env: Env,
  limit = 5,
): Promise<GeocodeResult[]> {
  const q = query.trim();
  if (q.length < 2) return [];

  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", q);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "0");
  url.searchParams.set("limit", String(Math.min(Math.max(limit, 1), 8)));

  const res = await fetch(url.toString(), {
    headers: {
      "User-Agent": `${env.APP_NAME || "MemberMap"} (Cloudflare Worker member directory)`,
      "Accept-Language": "en",
    },
    // Cache identical lookups at the edge to stay well within usage limits.
    cf: { cacheTtl: 60 * 60 * 24, cacheEverything: true },
  });

  if (!res.ok) return [];

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
