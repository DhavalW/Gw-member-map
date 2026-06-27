// Shared helpers. No inline scripts anywhere (strict CSP: script-src 'self').

/** Safe text node helper. */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "html") throw new Error("Do not set raw HTML");
    // Apply styles via the CSSOM, not a `style=` attribute: the strict CSP
    // (`style-src 'self'`) blocks inline style attributes, but CSSOM writes are
    // allowed. Routing `style` here keeps callers terse and CSP-clean.
    else if (k === "style") node.style.cssText = v;
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

/**
 * On-screen debug log. Some devices (e.g. iPad browsers) have no usable dev
 * console, so this captures console.error/warn, uncaught errors and rejected
 * promises into a toggleable overlay. Tap the floating "Debug" button to view.
 * It stays out of the way until something is logged, then highlights itself.
 */
export function installDebugOverlay() {
  if (window.__debugOverlay) return window.__debugOverlay;

  const lines = [];
  const controls = []; // custom control nodes added by pages (e.g. demo toggle)
  let panel = null;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = "Debug";
  btn.style.cssText =
    "position:fixed;bottom:12px;left:12px;z-index:99999;background:#1a1d21;color:#fff;" +
    "border:none;border-radius:999px;padding:8px 14px;font:600 12px system-ui;" +
    "box-shadow:0 2px 10px rgba(0,0,0,.3);cursor:pointer;opacity:.85";

  function render() {
    if (!panel) return;
    panel.querySelector("[data-log]").textContent =
      lines.length ? lines.join("\n") : "No messages logged yet.";
  }

  function toggle() {
    if (panel) {
      panel.remove();
      panel = null;
      return;
    }
    panel = document.createElement("div");
    panel.style.cssText =
      "position:fixed;inset:auto 12px 56px 12px;max-height:50vh;z-index:99999;" +
      "background:#0b0d10;color:#e6edf3;border-radius:12px;padding:12px;" +
      "box-shadow:0 8px 30px rgba(0,0,0,.5);font:12px ui-monospace,monospace;" +
      "overflow:auto;white-space:pre-wrap;word-break:break-word";

    // Custom controls (e.g. the "Show demo data" toggle) sit above the log.
    if (controls.length) {
      const ctrlBar = document.createElement("div");
      ctrlBar.style.cssText =
        "display:flex;flex-wrap:wrap;gap:10px;margin-bottom:10px;padding-bottom:10px;" +
        "border-bottom:1px solid #21262d";
      for (const c of controls) ctrlBar.append(c);
      panel.append(ctrlBar);
    }

    const bar = document.createElement("div");
    bar.style.cssText = "display:flex;gap:8px;margin-bottom:8px";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = "Copy";
    copy.style.cssText = "background:#2563eb;color:#fff;border:none;border-radius:8px;padding:4px 10px;font:600 12px system-ui;cursor:pointer";
    copy.addEventListener("click", () => navigator.clipboard?.writeText(lines.join("\n")));
    const clear = document.createElement("button");
    clear.type = "button";
    clear.textContent = "Clear";
    clear.style.cssText = copy.style.cssText.replace("#2563eb", "#374151");
    clear.addEventListener("click", () => { lines.length = 0; render(); btn.style.background = "#1a1d21"; });
    bar.append(copy, clear);
    const log = document.createElement("pre");
    log.setAttribute("data-log", "");
    log.style.cssText = "margin:0;white-space:pre-wrap;word-break:break-word";
    panel.append(bar, log);
    document.body.append(panel);
    render();
  }

  function add(kind, args) {
    const stamp = new Date().toISOString().slice(11, 19);
    const text = args.map((a) =>
      a instanceof Error ? `${a.message}\n${a.stack || ""}`
        : typeof a === "object" ? safeStringify(a)
        : String(a),
    ).join(" ");
    lines.push(`[${stamp}] ${kind}: ${text}`);
    if (lines.length > 200) lines.shift();
    btn.style.background = kind === "ERROR" ? "#b42318" : "#92400e";
    render();
  }

  const origError = console.error.bind(console);
  const origWarn = console.warn.bind(console);
  console.error = (...a) => { add("ERROR", a); origError(...a); };
  console.warn = (...a) => { add("WARN", a); origWarn(...a); };
  window.addEventListener("error", (e) => add("ERROR", [e.message, e.filename + ":" + e.lineno]));
  window.addEventListener("unhandledrejection", (e) => add("ERROR", [e.reason]));

  btn.addEventListener("click", toggle);
  const mount = () => document.body && document.body.append(btn);
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount);

  /**
   * Register a custom control node shown at the top of the debug panel.
   * Pages use this to add their own switches (e.g. the demo-data toggle)
   * without baking page-specific logic into the shared overlay.
   */
  function addControl(node) {
    controls.push(node);
    return node;
  }

  window.__debugOverlay = { log: (...a) => add("LOG", a), addControl };
  return window.__debugOverlay;
}

/**
 * A small labelled on/off switch for the debug panel. Returns the element;
 * `onChange(checked)` fires on toggle. Persists to localStorage when `key`
 * is given (default off).
 */
export function debugToggle({ label, key, onChange }) {
  const initial = key ? localStorage.getItem(key) === "1" : false;
  // Style via the CSSOM (element.style), not a `style=` attribute, so this
  // works under the strict `style-src 'self'` CSP (which blocks inline styles).
  const wrap = document.createElement("label");
  wrap.style.cssText =
    "display:flex;align-items:center;gap:8px;cursor:pointer;color:#e6edf3;font:600 12px system-ui";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = initial;
  input.style.cssText = "width:16px;height:16px;cursor:pointer";
  input.addEventListener("change", () => {
    if (key) localStorage.setItem(key, input.checked ? "1" : "0");
    onChange?.(input.checked);
  });
  wrap.append(input, document.createTextNode(label));
  // Expose the initial state so callers can sync without re-reading storage.
  wrap.checked = initial;
  return wrap;
}

/** Trigger a client-side file download (used for CSV export). */
export function downloadFile(filename, text, type = "text/csv;charset=utf-8") {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Copy text to the clipboard, returning true on success. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function safeStringify(o) {
  try { return JSON.stringify(o); } catch { return String(o); }
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
