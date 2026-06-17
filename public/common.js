// Shared helpers. No inline scripts anywhere (strict CSP: script-src 'self').

/** Safe text node helper. */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "html") throw new Error("Do not set raw HTML");
    else if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2), v);
    } else if (v !== null && v !== undefined) {
      node.setAttribute(k, v);
    }
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

export async function api(path, options = {}) {
  const opts = { credentials: "same-origin", ...options };
  opts.headers = { ...(opts.headers || {}) };
  if (opts.body && typeof opts.body !== "string") {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, opts);
  let data = null;
  try { data = await res.json(); } catch { /* non-json */ }
  return { ok: res.ok, status: res.status, data: data || {} };
}

export function getConfig() {
  return api("/api/config").then((r) => r.data);
}

/** Render a member's contact as a safe link or plain text. */
export function contactNode(label, url) {
  if (!label) return null;
  if (url) {
    const a = el("a", { href: url, rel: "noopener noreferrer nofollow", target: "_blank", text: label });
    return a;
  }
  return el("span", { text: label });
}

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/** Read the credential the edit page was opened with (#k=... in the URL). */
export function readEditCredential() {
  const hash = location.hash.startsWith("#") ? location.hash.slice(1) : "";
  const params = new URLSearchParams(hash);
  return params.get("k") || "";
}

/** Configure Leaflet's default marker icons to use our vendored images. */
export function configureLeafletIcons(L) {
  delete L.Icon.Default.prototype._getIconUrl;
  L.Icon.Default.mergeOptions({
    iconRetinaUrl: "/vendor/images/marker-icon-2x.png",
    iconUrl: "/vendor/images/marker-icon.png",
    shadowUrl: "/vendor/images/marker-shadow.png",
  });
}
