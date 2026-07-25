import type { Env } from "./types";
import { getPublicConfig } from "./settings";

/**
 * Server-side branding for the static HTML shells.
 *
 * The pages in `public/` ship with *empty* branding slots — `data-brand="…"`
 * on the element whose text is a setting, `data-brand-href="…"` on links whose
 * target is one. Nothing community-specific is hard-coded into the markup, so
 * the browser can never paint one community's name and then swap it for
 * another's a moment later.
 *
 * Instead this fills the slots in before the document leaves the Worker, and
 * inlines the whole public config into `<meta name="app-config">`. The result:
 * branding is correct in the very first paint (and in the tab title, and for
 * crawlers), and the front-end no longer has to wait on an `/api/config`
 * round trip before it can render.
 *
 * Values come from `getPublicConfig`, which is cached per isolate, so this
 * costs no database query on a warm Worker.
 */
export async function brandDocument(res: Response, env: Env): Promise<Response> {
  const cfg = await getPublicConfig(env);
  const value = (key: string): string => {
    const v = cfg[key];
    return typeof v === "string" ? v : "";
  };

  const rewritten = new HTMLRewriter()
    // Text slots: <h1 data-brand="appName"></h1>. `data-brand-prefix` /
    // `-suffix` let a page wrap the value ("Admin — {appName}") without
    // teaching this function about individual pages.
    .on("[data-brand]", {
      element(el) {
        const text = value(el.getAttribute("data-brand") ?? "");
        if (!text) return; // unknown/blank setting: leave the slot empty
        const prefix = el.getAttribute("data-brand-prefix") ?? "";
        const suffix = el.getAttribute("data-brand-suffix") ?? "";
        // setInnerContent escapes by default, so a setting containing markup
        // is rendered as text rather than injected into the page.
        el.setInnerContent(`${prefix}${text}${suffix}`);
      },
    })
    // Link slots: <a data-brand-href="communityUrl">…</a>
    .on("[data-brand-href]", {
      element(el) {
        const href = value(el.getAttribute("data-brand-href") ?? "");
        if (href) el.setAttribute("href", href);
      },
    })
    // The public config, inlined so the front-end starts with it in hand.
    .on('meta[name="app-config"]', {
      element(el) {
        el.setAttribute("content", JSON.stringify(cfg));
      },
    })
    .transform(res);

  const headers = new Headers(rewritten.headers);
  // The document now embeds settings that an admin can change at any time, so
  // it must be revalidated rather than served from a stale browser cache.
  headers.set("Cache-Control", "no-cache");
  return new Response(rewritten.body, {
    status: rewritten.status,
    statusText: rewritten.statusText,
    headers,
  });
}

/** True for asset responses that `brandDocument` should rewrite. */
export function isBrandableDocument(res: Response): boolean {
  return res.status === 200 && (res.headers.get("Content-Type") ?? "").includes("text/html");
}

/**
 * Paths served as HTML documents. Used to warm the config lookup in parallel
 * with the asset fetch, so branding adds no latency of its own.
 */
export function looksLikeDocument(pathname: string): boolean {
  return pathname.endsWith("/") || pathname.endsWith(".html") || !pathname.slice(1).includes(".");
}
