import { api, configureLeafletIcons, contactNode, debounce, el, getConfig } from "/common.js";
import { MOCK_MEMBERS } from "/mock-data.js"; // DEMO — remove this line and the spread in loadMembers() to clean up

const L = window.L;
configureLeafletIcons(L);

let CONFIG = {};
let MEMBERS = [];
let turnstileToken = "";

const state = {
  map: null,
  cluster: null,
  markers: new Map(), // id -> marker
  pickMap: null,
  pickMarker: null,
  picked: null, // { lat, lng }
};

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

function avatarEl(name, extraClass) {
  const initials = name.trim().split(/\s+/).map((p) => p[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();
  const color = AVATAR_COLORS[nameHash(name) % AVATAR_COLORS.length];
  return el("div", { class: `avatar${extraClass ? " " + extraClass : ""}`, style: `background:${color}` }, [initials]);
}

// --- Boot -----------------------------------------------------------------
init().catch((err) => console.error(err));

async function init() {
  CONFIG = await getConfig();
  document.title = CONFIG.appName || "Member Map";
  document.getElementById("app-name").textContent = CONFIG.appName || "Member Map";

  initMap();
  await loadMembers();
  wireForm();
  wireSuccess();
}

// --- Main map -------------------------------------------------------------
function initMap() {
  const map = L.map("map", { worldCopyJump: true }).setView([20, 0], 2);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);
  const cluster = L.markerClusterGroup({ maxClusterRadius: 50 });
  map.addLayer(cluster);
  state.map = map;
  state.cluster = cluster;
}

async function loadMembers() {
  const { data } = await api("/api/members");
  const real = Array.isArray(data.members) ? data.members : [];
  MEMBERS = [
    ...real,
    ...MOCK_MEMBERS, // DEMO — remove this line to clean up
  ];
  renderMembers(MEMBERS);
}

function renderMembers(members) {
  state.cluster.clearLayers();
  state.markers.clear();

  for (const m of members) {
    const marker = L.marker([m.lat, m.lng]);
    marker.bindPopup(() => buildPopup(m));
    state.cluster.addLayer(marker);
    state.markers.set(m.id, marker);
  }

  document.getElementById("member-count").textContent =
    members.length === 1 ? "1 member" : `${members.length} members`;
  renderList(members);
}

function buildPopup(m) {
  const header = el("div", { class: "popup-header" }, [
    avatarEl(m.name, "av-lg"),
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

function renderList(members) {
  const list = document.getElementById("member-list");
  list.replaceChildren();
  if (members.length === 0) {
    list.append(el("div", { class: "empty", text: "No members yet. Be the first to add yourself!" }));
    return;
  }
  for (const m of members) {
    const item = el("button", { class: "member-item", role: "listitem", type: "button" }, [
      avatarEl(m.name, "av-sm"),
      el("div", { class: "member-info" }, [
        el("div", { class: "name", text: m.name }),
        el("div", { class: "loc", text: m.location }),
        m.bio ? el("div", { class: "bio", text: m.bio }) : null,
      ]),
    ]);
    item.addEventListener("click", () => focusMember(m));
    list.append(item);
  }
}

function focusMember(m) {
  const marker = state.markers.get(m.id);
  if (!marker) return;
  state.map.flyTo([m.lat, m.lng], Math.max(state.map.getZoom(), 6), { duration: 0.6 });
  state.cluster.zoomToShowLayer(marker, () => marker.openPopup());
}

// Sidebar search
document.getElementById("filter").addEventListener("input", (e) => {
  const q = e.target.value.trim().toLowerCase();
  const filtered = !q
    ? MEMBERS
    : MEMBERS.filter(
        (m) =>
          m.name.toLowerCase().includes(q) ||
          m.location.toLowerCase().includes(q) ||
          (m.bio || "").toLowerCase().includes(q),
      );
  renderList(filtered);
});

// --- Submission form ------------------------------------------------------
function wireForm() {
  const dialog = document.getElementById("form-dialog");
  const open = document.getElementById("open-form");
  const form = document.getElementById("member-form");

  open.addEventListener("click", () => {
    dialog.showModal();
    setTimeout(initPickMap, 50); // map needs a sized container
  });
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

  const search = debounce(async () => {
    const q = input.value.trim();
    if (q.length < 3) {
      results.classList.remove("show");
      results.replaceChildren();
      return;
    }
    const { data } = await api(`/api/geocode?q=${encodeURIComponent(q)}`);
    const items = Array.isArray(data.results) ? data.results : [];
    results.replaceChildren();
    if (items.length === 0) {
      results.classList.remove("show");
      return;
    }
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
  submitBtn.textContent = "Adding…";
  try {
    const { ok, data } = await api("/api/members", { method: "POST", body: payload });
    if (!ok) {
      if (data.fields) showFieldErrors(data.fields);
      formError.textContent = data.error || "Something went wrong. Please try again.";
      formError.style.display = "block";
      return;
    }
    document.getElementById("form-dialog").close();
    showSuccess(data);
    await loadMembers();
  } catch {
    formError.textContent = "Network error. Please try again.";
    formError.style.display = "block";
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Add me to the map";
  }
}

// --- Success dialog -------------------------------------------------------
function wireSuccess() {
  document.getElementById("close-success").addEventListener("click", () => {
    document.getElementById("success-dialog").close();
    document.getElementById("member-form").reset();
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
  const msg = document.getElementById("success-msg");
  msg.textContent = data.moderated
    ? "Thanks! Your entry will appear once an admin approves it."
    : "Thanks for joining — your pin is now on the map.";
  document.getElementById("email-note").style.display =
    document.getElementById("email").value.trim() && CONFIG.emailConfigured ? "block" : "none";
  dialog.showModal();
}

function resetPick() {
  state.picked = null;
  if (state.pickMarker) {
    state.pickMap.removeLayer(state.pickMarker);
    state.pickMarker = null;
  }
}
