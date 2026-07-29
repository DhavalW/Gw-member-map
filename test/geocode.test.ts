// Regression guards for the location search (`geocode`), which backs the
// sign-up form, the member edit form, and the admin CSV import.
//
// History: commit 1b1f49b made the Nominatim User-Agent/Referer come from the
// dashboard-configurable branding settings. Header values are ISO-8859-1, so
// any branding text with a character above U+00FF (curly quote, em dash,
// emoji, non-Latin script) made `fetch` throw — and the route swallowed that
// into an empty result list, silently killing location search on every form.
// These tests pin the guarantee: NO configuration value may break geocoding.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { geocode } from "../src/geocode";
import { invalidateConfigCache } from "../src/settings";
import type { Env } from "../src/types";

type SettingsRow = { key: string; value: string };

/** Minimal D1 stub: serves `SELECT ... FROM settings` and accepts batches. */
function stubDb(settings: SettingsRow[]): unknown {
  return {
    prepare(sql: string) {
      const stmt = {
        bind: () => stmt,
        all: async () => ({ results: /FROM settings/i.test(sql) ? settings : [] }),
        first: async () => null,
        run: async () => ({}),
      };
      return stmt;
    },
    batch: async () => [],
  };
}

/** A D1 stub where every operation fails (database unavailable). */
function brokenDb(): unknown {
  const boom = () => {
    throw new Error("D1 unavailable");
  };
  return { prepare: boom, batch: boom, exec: boom };
}

function makeEnv(db: unknown): Env {
  return { DB: db, ASSETS: {} } as unknown as Env;
}

const NOMINATIM_BODY = JSON.stringify([
  { display_name: "Mumbai, Maharashtra, India", lat: "19.0759899", lon: "72.8773928" },
  { display_name: "Mumbai Suburban, Maharashtra, India", lat: "19.125", lon: "72.85" },
]);

interface CapturedRequest {
  url: string;
  headers: Headers;
}

let captured: CapturedRequest[];
let upstreamStatus: number;
const realFetch = globalThis.fetch;

beforeEach(() => {
  invalidateConfigCache();
  captured = [];
  upstreamStatus = 200;
  // Stand-in for the Workers runtime fetch. Constructing a real Request
  // applies the same header validation `fetch` itself performs (throws on
  // values outside ISO-8859-1 or containing CR/LF), so a regression that
  // builds an invalid header fails these tests exactly like production.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    captured.push({ url: req.url, headers: req.headers });
    return new Response(upstreamStatus === 200 ? NOMINATIM_BODY : "blocked", {
      status: upstreamStatus,
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const HEADER_SAFE = /^[\x20-\x7E]*$/;

describe("geocode", () => {
  it("resolves a typed location to labelled coordinates", async () => {
    const env = makeEnv(stubDb([]));
    const results = await geocode("Mumbai", env);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toEqual({
      label: "Mumbai, Maharashtra, India",
      lat: 19.0759899,
      lng: 72.8773928,
    });
    expect(captured[0]!.url).toContain("nominatim.openstreetmap.org/search");
  });

  // The regression this file exists for: branding text must never take the
  // geocoder down, whatever an admin types into the settings form.
  const hostileBranding: [string, string][] = [
    ["curly apostrophe", "Dhaval’s Member Map"],
    ["em dash", "Generalist World — Members"],
    ["emoji", "🌍 World Map"],
    ["Devanagari", "मेंबर मैप"],
    ["CRLF header injection", "evil\r\nX-Injected: 1"],
  ];

  for (const [name, appName] of hostileBranding) {
    it(`still resolves locations when the site title contains ${name}`, async () => {
      const env = makeEnv(stubDb([{ key: "appName", value: appName }]));
      const results = await geocode("Mumbai", env);
      expect(results.length).toBeGreaterThan(0);

      const ua = captured[0]!.headers.get("User-Agent") ?? "";
      expect(ua).toMatch(HEADER_SAFE);
      expect(ua).toContain("member directory");
      expect(captured[0]!.headers.get("X-Injected")).toBeNull();
    });
  }

  it("still resolves locations when the public base URL is not header-safe", async () => {
    const env = makeEnv(
      stubDb([{ key: "publicBaseUrl", value: "https://социум.example/карта" }]),
    );
    const results = await geocode("Mumbai", env);
    expect(results.length).toBeGreaterThan(0);
    expect(captured[0]!.headers.get("Referer") ?? "").toMatch(HEADER_SAFE);
  });

  it("still resolves locations when the settings database is unavailable", async () => {
    // The /api/geocode route is deliberately served before any schema work so
    // location search survives a DB outage — the config lookup inside geocode
    // must honour that too.
    const env = makeEnv(brokenDb());
    const results = await geocode("Mumbai", env);
    expect(results.length).toBeGreaterThan(0);
    // Falls back to the built-in defaults, which still identify the service.
    const ua = captured[0]!.headers.get("User-Agent") ?? "";
    expect(ua).toMatch(HEADER_SAFE);
    expect(ua).toContain("member directory");
  });

  it("throws on an upstream failure so the route can report it", async () => {
    upstreamStatus = 403;
    const env = makeEnv(stubDb([]));
    await expect(geocode("Mumbai", env)).rejects.toThrow(/403/);
  });

  it("returns no results for queries shorter than 2 characters without calling upstream", async () => {
    const env = makeEnv(stubDb([]));
    expect(await geocode("M", env)).toEqual([]);
    expect(captured).toHaveLength(0);
  });
});
