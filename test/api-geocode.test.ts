// Contract tests for GET /api/geocode — the endpoint every location search
// box (sign-up form, member edit form, admin CSV import) depends on. They run
// the real Worker fetch handler against a stubbed environment, so a routing
// or config change that breaks location resolution fails here instead of
// silently shipping.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { invalidateConfigCache } from "../src/settings";
import type { Env } from "../src/types";

type SettingsRow = { key: string; value: string };

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

function makeEnv(db: unknown): Env {
  return { DB: db, ASSETS: {} } as unknown as Env;
}

const NOMINATIM_BODY = JSON.stringify([
  { display_name: "Pune, Maharashtra, India", lat: "18.521428", lon: "73.8544541" },
]);

let upstreamStatus: number;
const realFetch = globalThis.fetch;

beforeEach(() => {
  invalidateConfigCache();
  upstreamStatus = 200;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    // Real Request construction applies fetch's own header validation, so
    // invalid header values fail here exactly like in the Workers runtime.
    new Request(input, init);
    return new Response(upstreamStatus === 200 ? NOMINATIM_BODY : "blocked", {
      status: upstreamStatus,
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function geocodeRequest(q: string): Request {
  return new Request(`https://map.example.com/api/geocode?q=${encodeURIComponent(q)}`);
}

describe("GET /api/geocode", () => {
  it("returns labelled coordinates for a typed location", async () => {
    const res = await worker.fetch(geocodeRequest("Pune"), makeEnv(stubDb([])));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: unknown[] };
    expect(body.results).toEqual([
      { label: "Pune, Maharashtra, India", lat: 18.521428, lng: 73.8544541 },
    ]);
  });

  it("keeps resolving locations when the dashboard branding is not header-safe", async () => {
    // Regression: after 1b1f49b the Nominatim headers came from dashboard
    // settings, and e.g. an emoji or curly quote in the site title made every
    // lookup fail. Branding must never break this endpoint.
    const env = makeEnv(
      stubDb([
        { key: "appName", value: "🌍 Dhaval’s “Member Map” — भारत" },
        { key: "publicBaseUrl", value: "https://members.example.com" },
      ]),
    );
    const res = await worker.fetch(geocodeRequest("Pune"), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: unknown[]; error?: string };
    expect(body.error).toBeUndefined();
    expect(body.results).toHaveLength(1);
  });

  it("reports upstream failure explicitly so the forms can show a hint", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    upstreamStatus = 403;
    const res = await worker.fetch(geocodeRequest("Pune"), makeEnv(stubDb([])));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: unknown[]; error?: string; detail?: string };
    expect(body.results).toEqual([]);
    // The front-ends key off this exact value to tell the user to drop a pin.
    expect(body.error).toBe("geocode_unavailable");
    // The upstream reason ships alongside, so a broken deployment can be
    // diagnosed from the browser's debug overlay without Worker log access.
    expect(body.detail).toContain("403");
  });

  it("still resolves locations when the database is unavailable", async () => {
    // The route is served before any schema/DB work on purpose; a D1 outage
    // must not take location search down with it.
    const boom = () => {
      throw new Error("D1 unavailable");
    };
    const env = makeEnv({ prepare: boom, batch: boom, exec: boom });
    const res = await worker.fetch(geocodeRequest("Pune"), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: unknown[] };
    expect(body.results).toHaveLength(1);
  });
});
