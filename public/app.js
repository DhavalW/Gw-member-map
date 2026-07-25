import { api, configureLeafletIcons, contactNode, createPhotoField, debounce, debugToggle, el, getConfig, installDebugOverlay, memberImageUrl, uploadMemberImage } from "/common.js";
import { MOCK_MEMBERS } from "/mock-data.js"; // DEMO — sample pins, hidden unless toggled on in the debug panel

const L = window.L;
configureLeafletIcons(L);
const overlay = installDebugOverlay(); // on-screen logs for devices without a dev console

const DEMO_KEY = "member-map-show-demo-data";
let showDemo = localStorage.getItem(DEMO_KEY) === "1"; // off by default

let CONFIG = {};
let MEMBERS = [];
let turnstileToken = "";
let photoField = null; // profile-photo picker for the sign-up form

// Debug-panel switch to overlay sample/demo pins. Off by default; persists.
overlay.addControl(
  debugToggle({
    label: "Show demo data",
    key: DEMO_KEY,
    onChange: (on) => {
      showDemo = on;
      loadMembers();
    },
  }),
);

const state = {
  map: null,
  cluster: null,
  markers: new Map(), // id -> marker
  pickMap: null,
  pickMarker: null,
  picked: null, // { lat, lng }
  setSheetOpen: () => {}, // mobile bottom-sheet control, bound in wireSheet()
};

const mobileQuery = window.matchMedia("(max-width: 720px)");
const isMobile = () => mobileQuery.matches;

// How many list rows are rendered per chunk. Large communities would otherwise
// stall the main thread building thousands of DOM nodes at once; instead the
// list grows as you scroll (an IntersectionObserver watches a sentinel row).
const LIST_CHUNK = 60;
const listState = { items: [], rendered: 0, observer: null };

// --- Avatar helpers -------------------------------------------------------
const AVATAR_COLORS = [
  "#4f46e5", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444",
  "#8b5cf6", "#ec4899", "#14b8a6", "#f97316", "#6366f1",
];

function nameHash(name) {
  let h = 0;
  for (const c of name) h = ((h * 31) + c.charCodeAt(0)) >>> 0;
  return h;
}

function avatarEl(m, extraClass) {
  const name = (m && m.name) || "";
  const cls = `avatar${extraClass ? " " + extraClass : ""}`;
  const url = memberImageUrl(m);
  if (url) {
    return el("div", { class: `${cls} has-img` }, [
      el("img", { src: url, alt: name, loading: "lazy" }),
    ]);
  }
  const initials = name.trim().split(/\s+/).map((p) => p[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();
  const color = AVATAR_COLORS[nameHash(name) % AVATAR_COLORS.length];
  return el("div", { class: cls, style: `background:${color}` }, [initials]);
}

// --- Boot -----------------------------------------------------------------
init().catch((err) => console.error("init failed", err));

async function init() {
  CONFIG = await getConfig();
  applyBranding();

  initMap();
  wireCredit();
  wireSheet();
  wireForm();
  wireSuccess();
  await loadMembers();
}

/**
 * Apply the community branding to the page chrome.
 *
 * The Worker already rendered these values into the HTML, so this is normally
 * a no-op that re-sets identical text. It stays as the fallback for a document
 * served without that step, and never substitutes a placeholder name: a slot
 * with no configured value is left blank rather than showing someone else's
 * branding.
 */
function applyBranding() {
  if (CONFIG.appName) {
    document.title = CONFIG.appName;
    document.getElementById("app-name").textContent = CONFIG.appName;
  }
  const community = document.getElementById("community-link");
  if (!community) return;
  if (CONFIG.communityUrl) community.href = CONFIG.communityUrl;
  if (CONFIG.communityName) community.textContent = CONFIG.communityName;
}

// --- Main map -------------------------------------------------------------
function initMap() {
  const map = L.map("map", {
    worldCopyJump: true,
    // On phones the bottom sheet covers Leaflet's default (bottom-right)
    // attribution, so surface it top-right instead.
    attributionControl: false,
  }).setView([20, 0], 2);
  L.control
    .attribution({ position: isMobile() ? "topright" : "bottomright" })
    .addTo(map);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);
  // chunkedLoading spreads marker insertion over animation frames, so adding
  // thousands of pins doesn't freeze the page.
  const cluster = L.markerClusterGroup({ maxClusterRadius: 50, chunkedLoading: true });
  map.addLayer(cluster);
  state.map = map;
  state.cluster = cluster;
}

function setLoading(on) {
  document.getElementById("map-loading").classList.toggle("hidden", !on);
  if (on) {
    document.getElementById("member-count").textContent = "Loading…";
    renderListSkeleton();
  }
}

/** Placeholder rows shown in the member list while the fetch is in flight. */
function renderListSkeleton(count = 7) {
  const list = document.getElementById("member-list");
  list.replaceChildren();
  for (let i = 0; i < count; i++) {
    list.append(
      el("div", { class: "member-item skel", "aria-hidden": "true" }, [
        el("div", { class: "skel-avatar" }),
        el("div", { class: "member-info" }, [
          el("div", { class: "skel-line w60" }),
          el("div", { class: "skel-line w85" }),
        ]),
      ]),
    );
  }
}

async function loadMembers() {
  setLoading(true);
  try {
    const { ok, data } = await api("/api/members");
    if (!ok || !Array.isArray(data.members)) throw new Error("bad response");
    // Demo pins are appended only when the debug-panel toggle is on.
    MEMBERS = showDemo ? [...data.members, ...MOCK_MEMBERS] : data.members;
    renderMembers(MEMBERS);
  } catch (err) {
    console.error("loading members failed", err);
    showLoadError();
  } finally {
    setLoading(false);
  }
}

/** Fetch failed: say so in the list and offer a retry. */
function showLoadError() {
  document.getElementById("member-count").textContent = "";
  const retry = el("button", { class: "btn small", type: "button", text: "Try again" });
  retry.addEventListener("click", () => loadMembers());
  document.getElementById("member-list").replaceChildren(
    el("div", { class: "list-error" }, [
      el("div", { text: "Couldn’t load the member list." }),
      retry,
    ]),
  );
}

function renderMembers(members) {
  state.cluster.clearLayers();
  state.markers.clear();

  const markers = [];
  for (const m of members) {
    const marker = L.marker([m.lat, m.lng]);
    marker.bindPopup(() => buildPopup(m));
    markers.push(marker);
    state.markers.set(m.id, marker);
  }
  // One bulk insert (paired with chunkedLoading) is far faster than adding
  // markers to the cluster one at a time.
  state.cluster.addLayers(markers);

  document.getElementById("member-count").textContent =
    members.length === 1 ? "1 member" : `${members.length} members`;
  renderList(members);
}

function buildPopup(m) {
  const header = el("div", { class: "popup-header" }, [
    avatarEl(m, "av-lg"),
    el("div", { class: "popup-meta" }, [
      el("div", { class: "name", text: m.name }),
      el("div", { class: "loc", text: m.location }),
    ]),
  ]);
  const node = el("div", { class: "popup" }, [header]);
  if (m.bio) node.append(el("div", { class: "bio", text: m.bio }));
  const c = contactNode(m.contactLabel, m.contactUrl);
  if (c) node.append(el("div", { class: "contact" }, [c]));
  return node;
}

function memberItem(m) {
  const item = el("button", { class: "member-item", role: "listitem", type: "button" }, [
    avatarEl(m, "av-sm"),
    el("div", { class: "member-info" }, [
      el("div", { class: "name", text: m.name }),
      el("div", { class: "loc", text: m.location }),
      m.bio ? el("div", { class: "bio", text: m.bio }) : null,
    ]),
  ]);
  item.addEventListener("click", () => focusMember(m));
  return item;
}

function renderList(members) {
  const list = document.getElementById("member-list");
  if (listState.observer) {
    listState.observer.disconnect();
    listState.observer = null;
  }
  list.replaceChildren();
  listState.items = members;
  listState.rendered = 0;

  if (members.length === 0) {
    list.append(el("div", { class: "empty", text: "No members yet. Be the first to add yourself!" }));
    return;
  }

  appendListChunk(list);
  if (listState.rendered < members.length) {
    // Grow the list as the sentinel scrolls into view.
    const sentinel = el("div", { class: "list-sentinel", "aria-hidden": "true" });
    list.append(sentinel);
    listState.observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        appendListChunk(list, sentinel);
        if (listState.rendered >= listState.items.length) {
          listState.observer.disconnect();
          listState.observer = null;
          sentinel.remove();
        }
      },
      { root: list, rootMargin: "300px" },
    );
    listState.observer.observe(sentinel);
  }
}

/** Append the next chunk of rows (before the sentinel when one exists). */
function appendListChunk(list, sentinel = null) {
  const end = Math.min(listState.rendered + LIST_CHUNK, listState.items.length);
  const frag = document.createDocumentFragment();
  for (let i = listState.rendered; i < end; i++) frag.append(memberItem(listState.items[i]));
  listState.rendered = end;
  if (sentinel) list.insertBefore(frag, sentinel);
  else list.append(frag);
}

function focusMember(m) {
  const marker = state.markers.get(m.id);
  if (!marker) return;
  // On phones the list sits over the map — tuck it away so the pin is visible.
  if (isMobile()) state.setSheetOpen(false);
  state.map.flyTo([m.lat, m.lng], Math.max(state.map.getZoom(), 6), { duration: 0.6 });
  state.cluster.zoomToShowLayer(marker, () => marker.openPopup());
}

// Sidebar search (debounced: filtering + re-rendering a large list every
// keystroke makes typing feel sluggish).
const applyFilter = debounce((value) => {
  const q = value.trim().toLowerCase();
  const filtered = !q
    ? MEMBERS
    : MEMBERS.filter(
        (m) =>
          m.name.toLowerCase().includes(q) ||
          m.location.toLowerCase().includes(q) ||
          (m.bio || "").toLowerCase().includes(q),
      );
  renderList(filtered);
}, 120);
document.getElementById("filter").addEventListener("input", (e) => applyFilter(e.target.value));

// --- Maker credit dialog --------------------------------------------------
function wireCredit() {
  const dialog = document.getElementById("credit-dialog");
  document.getElementById("credit-open").addEventListener("click", () => dialog.showModal());
  document.getElementById("credit-close").addEventListener("click", () => dialog.close());
  // Tapping the backdrop closes it (there's nothing to lose in this dialog).
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });
}

// --- Mobile bottom sheet --------------------------------------------------
const SHEET_PEEK = 118; // keep in sync with --sheet-peek in styles.css

function wireSheet() {
  const sheet = document.querySelector("aside.sidebar");
  const handle = document.getElementById("sheet-handle");
  const filter = document.getElementById("filter");

  const setOpen = (open) => {
    sheet.classList.toggle("open", open);
    sheet.classList.remove("dragging");
    sheet.style.transform = ""; // return control to the CSS classes
    handle.setAttribute("aria-expanded", String(open));
    if (!open) filter.blur();
  };
  state.setSheetOpen = setOpen;

  let suppressClick = false;
  handle.addEventListener("click", () => {
    if (suppressClick) { suppressClick = false; return; }
    if (isMobile()) setOpen(!sheet.classList.contains("open"));
  });
  filter.addEventListener("focus", () => { if (isMobile()) setOpen(true); });

  // Drag-to-open/close on the grab handle.
  let startY = 0;
  let baseOffset = 0;
  let travel = 0;
  let delta = 0;
  let dragging = false;

  handle.addEventListener("touchstart", (e) => {
    if (!isMobile()) return;
    dragging = true;
    delta = 0;
    startY = e.touches[0].clientY;
    travel = Math.max(sheet.offsetHeight - SHEET_PEEK, 0);
    baseOffset = sheet.classList.contains("open") ? 0 : travel;
    sheet.classList.add("dragging");
  }, { passive: true });

  handle.addEventListener("touchmove", (e) => {
    if (!dragging) return;
    delta = e.touches[0].clientY - startY;
    const off = Math.min(Math.max(baseOffset + delta, 0), travel);
    sheet.style.transform = `translateY(${off}px)`;
  }, { passive: true });

  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    suppressClick = Math.abs(delta) > 8;
    const off = Math.min(Math.max(baseOffset + delta, 0), travel);
    // A decisive flick wins; otherwise snap to the nearer state.
    const open = Math.abs(delta) > 50 ? delta < 0 : off < travel / 2;
    setOpen(open);
  };
  handle.addEventListener("touchend", endDrag);
  handle.addEventListener("touchcancel", endDrag);

  // Leaving mobile layout: clear any sheet state so desktop renders normally.
  mobileQuery.addEventListener("change", () => { if (!isMobile()) setOpen(false); });
}

// --- Submission form ------------------------------------------------------
function wireForm() {
  const dialog = document.getElementById("form-dialog");
  const open = document.getElementById("open-form");
  const form = document.getElementById("member-form");

  // Profile-photo picker (optional). Processed (resized + compressed) in the
  // browser; uploaded after the entry is created, once we have its edit token.
  photoField = createPhotoField({ hint: "Square works best. JPG, PNG or WebP — resized automatically." });
  photoField.onError((msg) => showFormError(msg));
  document.getElementById("photo-holder").append(photoField.element);

  const openDialog = () => {
    resetFormErrors(); // never reopen with a stale (or blank) error showing
    dialog.showModal();
    setTimeout(initPickMap, 50); // map needs a sized container
  };
  open.addEventListener("click", openDialog);
  // Mobile floating action button mirrors the header CTA.
  document.getElementById("open-form-fab").addEventListener("click", openDialog);
  document.getElementById("close-form").addEventListener("click", () => dialog.close());
  document.getElementById("cancel-form").addEventListener("click", () => dialog.close());

  wireGeocode();
  maybeLoadTurnstile();

  form.addEventListener("submit", onSubmit);
}

function initPickMap() {
  if (state.pickMap) {
    state.pickMap.invalidateSize();
    return;
  }
  const map = L.map("pickmap", { worldCopyJump: true }).setView([20, 0], 1);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);
  map.on("click", (e) => setPick(e.latlng.lat, e.latlng.lng));
  state.pickMap = map;
  // The container was hidden until the dialog opened, so Leaflet may have
  // measured it at zero size; recompute once layout settles or tiles won't load.
  setTimeout(() => map.invalidateSize(), 0);
}

function setPick(lat, lng, recenter = false) {
  state.picked = { lat, lng };
  if (!state.pickMarker) {
    state.pickMarker = L.marker([lat, lng], { draggable: true }).addTo(state.pickMap);
    state.pickMarker.on("dragend", () => {
      const ll = state.pickMarker.getLatLng();
      state.picked = { lat: ll.lat, lng: ll.lng };
    });
  } else {
    state.pickMarker.setLatLng([lat, lng]);
  }
  if (recenter) state.pickMap.setView([lat, lng], 9);
  clearError("location_name");
}

function wireGeocode() {
  const input = document.getElementById("location_name");
  const results = document.getElementById("geo-results");
  const hint = document.querySelector("#f-location_name .hint");
  const defaultHint = hint ? hint.textContent : "";
  const setHint = (msg) => { if (hint) hint.textContent = msg || defaultHint; };
  const PIN_HINT = "Couldn’t search locations right now — click the map below to drop your pin.";

  const search = debounce(async () => {
    const q = input.value.trim();
    if (q.length < 3) {
      results.classList.remove("show");
      results.replaceChildren();
      setHint("");
      return;
    }
    setHint("Searching…");

    let resp;
    try {
      resp = await api(`/api/geocode?q=${encodeURIComponent(q)}`);
    } catch (err) {
      console.error("geocode request failed", err);
      results.classList.remove("show");
      setHint(PIN_HINT);
      return;
    }

    const { ok, status, data } = resp;
    results.replaceChildren();

    // Endpoint reachable but the upstream lookup failed (or returned non-JSON):
    // tell the user instead of silently showing nothing.
    if (!ok || data.error || !Array.isArray(data.results)) {
      console.warn("geocode unavailable", { status, error: data.error });
      results.classList.remove("show");
      setHint(PIN_HINT);
      return;
    }

    const items = data.results;
    if (items.length === 0) {
      results.classList.remove("show");
      setHint("No matches — try a different spelling, or click the map to drop your pin.");
      return;
    }

    setHint("");
    for (const r of items) {
      const btn = el("button", { type: "button", text: r.label });
      btn.addEventListener("click", () => {
        input.value = r.label;
        setPick(r.lat, r.lng, true);
        results.classList.remove("show");
      });
      results.append(el("li", { role: "option" }, [btn]));
    }
    results.classList.add("show");
  }, 350);

  input.addEventListener("input", search);
}

function maybeLoadTurnstile() {
  if (!CONFIG.turnstileSiteKey) return;
  const holder = document.getElementById("turnstile-holder");
  const widget = el("div", { class: "cf-turnstile field" });
  widget.dataset.sitekey = CONFIG.turnstileSiteKey;
  holder.append(widget);

  window.onTurnstileSuccess = (token) => { turnstileToken = token; };
  widget.setAttribute("data-callback", "onTurnstileSuccess");

  const s = document.createElement("script");
  s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
  s.async = true;
  s.defer = true;
  document.head.append(s);
}

function clearError(field) {
  const wrap = document.getElementById(`f-${field}`);
  if (wrap) wrap.classList.remove("has-error");
}

/** Clear every error surface in the form (called when the dialog opens). */
function resetFormErrors() {
  const formError = document.getElementById("form-error");
  formError.textContent = "";
  formError.style.display = "none";
  document.getElementById("consent-err").style.display = "none";
  document.querySelectorAll("#member-form .field.has-error")
    .forEach((n) => n.classList.remove("has-error"));
}

/** Show the top-of-form error bar, but never as an empty red strip. */
function showFormError(msg) {
  const formError = document.getElementById("form-error");
  formError.textContent = msg || "Something went wrong. Please try again.";
  formError.style.display = "block";
}

function showFieldErrors(fields) {
  for (const [name, msg] of Object.entries(fields || {})) {
    const wrap = document.getElementById(`f-${name}`);
    if (!wrap) continue;
    wrap.classList.add("has-error");
    const errEl = wrap.querySelector("[data-err]");
    if (errEl) errEl.textContent = msg;
  }
}

async function onSubmit(e) {
  e.preventDefault();
  const submitBtn = document.getElementById("submit-form");
  const formError = document.getElementById("form-error");
  const consentErr = document.getElementById("consent-err");
  formError.style.display = "none";
  consentErr.style.display = "none";
  document.querySelectorAll(".field.has-error").forEach((n) => n.classList.remove("has-error"));

  const consent = document.getElementById("consent_public").checked;
  if (!consent) {
    consentErr.style.display = "block";
    return;
  }
  if (!state.picked) {
    showFieldErrors({ location_name: "Pick your location on the map or choose a search result." });
    return;
  }

  const payload = {
    display_name: document.getElementById("display_name").value,
    location_name: document.getElementById("location_name").value,
    bio: document.getElementById("bio").value,
    contact: document.getElementById("contact").value,
    email: document.getElementById("email").value,
    website: document.getElementById("website").value, // honeypot
    consent_public: consent,
    lat: state.picked.lat,
    lng: state.picked.lng,
    turnstileToken,
  };

  submitBtn.disabled = true;
  submitBtn.classList.add("loading");
  submitBtn.textContent = "Adding…";
  try {
    const { ok, data } = await api("/api/members", { method: "POST", body: payload });
    if (!ok) {
      if (data.fields) showFieldErrors(data.fields);
      console.warn("submit rejected", data);
      showFormError(data.error);
      return;
    }

    // Upload the optional photo now that we have the entry's edit token. A
    // failed upload shouldn't lose the (already created) entry — just warn.
    const photo = photoField ? photoField.getState() : null;
    if (photo && photo.blob && data.id && data.editToken) {
      submitBtn.textContent = "Uploading photo…";
      try {
        const up = await uploadMemberImage(data.id, photo.blob, {
          editToken: data.editToken,
          width: photo.width,
          height: photo.height,
        });
        if (!up.ok) console.warn("photo upload rejected", up.data);
      } catch (err) {
        console.error("photo upload failed", err);
      }
    }

    document.getElementById("form-dialog").close();
    showSuccess(data);
    await loadMembers();
  } catch (err) {
    console.error("submit failed", err);
    showFormError("Network error. Please try again.");
  } finally {
    submitBtn.disabled = false;
    submitBtn.classList.remove("loading");
    submitBtn.textContent = "Add me to the map";
  }
}

// --- Success dialog -------------------------------------------------------
function wireSuccess() {
  document.getElementById("close-success").addEventListener("click", () => {
    document.getElementById("success-dialog").close();
    document.getElementById("member-form").reset();
    if (photoField) photoField.reset();
    resetPick();
  });
  document.getElementById("copy-link").addEventListener("click", async () => {
    const input = document.getElementById("edit-link");
    try {
      await navigator.clipboard.writeText(input.value);
      const btn = document.getElementById("copy-link");
      btn.textContent = "Copied!";
      setTimeout(() => (btn.textContent = "Copy"), 1500);
    } catch {
      input.select();
    }
  });
}

function showSuccess(data) {
  const dialog = document.getElementById("success-dialog");
  document.getElementById("edit-link").value = data.editUrl || "";
  document.getElementById("goto-edit").href = data.editUrl || "#";
  const title = document.getElementById("success-title");
  const msg = document.getElementById("success-msg");
  if (data.moderated) {
    title.textContent = "Thanks — you're almost there! 🎉";
    msg.textContent =
      "Your entry has been submitted for review and will appear on the map once an admin approves it.";
  } else {
    title.textContent = "You're on the map! 🎉";
    msg.textContent = "Thanks for joining — your pin is now on the map.";
  }
  dialog.showModal();
}

function resetPick() {
  state.picked = null;
  if (state.pickMarker) {
    state.pickMap.removeLayer(state.pickMarker);
    state.pickMarker = null;
  }
}
