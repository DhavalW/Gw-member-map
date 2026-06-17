import { api, configureLeafletIcons, el, getConfig } from "/common.js";

const L = window.L;
configureLeafletIcons(L);

let CONFIG = {};
let MEMBERS = [];
let editing = null; // currently edited member id
const pick = { map: null, marker: null, picked: null };

init().catch((err) => console.error(err));

async function init() {
  CONFIG = await getConfig();
  if (!CONFIG.adminConfigured) {
    show("not-configured");
    return;
  }
  const { data } = await api("/api/admin/me");
  if (data.admin) {
    await loadDashboard();
  } else {
    showLogin();
  }
}

function show(id) {
  for (const v of ["login-view", "not-configured", "loading-view", "dash-view"]) {
    const node = document.getElementById(v);
    if (node) node.style.display = v === id ? (v === "login-view" ? "block" : "block") : "none";
  }
}

function showLogin() {
  show("login-view");
  document.getElementById("login-form").addEventListener("submit", onLogin);
}

async function onLogin(e) {
  e.preventDefault();
  const errBox = document.getElementById("login-error");
  errBox.style.display = "none";
  const password = document.getElementById("password").value;
  const { ok, data } = await api("/api/admin/login", { method: "POST", body: { password } });
  if (!ok) {
    errBox.textContent = data.error || "Login failed.";
    errBox.style.display = "block";
    return;
  }
  await loadDashboard();
}

async function loadDashboard() {
  show("dash-view");
  const { ok, data } = await api("/api/admin/members");
  if (!ok) {
    showLogin();
    return;
  }
  MEMBERS = Array.isArray(data.members) ? data.members : [];
  renderRows(MEMBERS);
  document.getElementById("logout-btn").addEventListener("click", onLogout);
  document.getElementById("admin-filter").addEventListener("input", (e) => {
    const q = e.target.value.trim().toLowerCase();
    renderRows(
      !q ? MEMBERS : MEMBERS.filter((m) =>
        [m.name, m.location, m.email, m.contactLabel].some((f) => (f || "").toLowerCase().includes(q)),
      ),
    );
  });
  wireEditDialog();
}

async function onLogout() {
  await api("/api/admin/logout", { method: "POST" });
  location.reload();
}

function renderRows(members) {
  const tbody = document.getElementById("admin-rows");
  tbody.replaceChildren();
  document.getElementById("admin-count").textContent = `${members.length} entries`;
  for (const m of members) {
    const statusBadge = el("span", { class: `badge ${m.status}`, text: m.status });
    const editBtn = el("button", { class: "btn small", type: "button", text: "Edit" });
    editBtn.addEventListener("click", () => openEdit(m));
    const row = el("tr", {}, [
      el("td", {}, [el("strong", { text: m.name })]),
      el("td", { text: m.location }),
      el("td", { text: m.contactLabel || "—" }),
      el("td", { text: m.email || "—" }),
      el("td", {}, [statusBadge, m.consentPublic ? null : el("div", { class: "muted", text: "opted out" })]),
      el("td", { text: new Date(m.createdAt).toLocaleDateString() }),
      el("td", {}, [editBtn]),
    ]);
    tbody.append(row);
  }
}

// --- Edit dialog ----------------------------------------------------------
function wireEditDialog() {
  const dialog = document.getElementById("edit-dialog");
  document.getElementById("close-edit").addEventListener("click", () => dialog.close());
  document.getElementById("admin-cancel").addEventListener("click", () => dialog.close());
  document.getElementById("admin-edit-form").addEventListener("submit", onSave);
  document.getElementById("admin-delete").addEventListener("click", onDelete);
}

function openEdit(m) {
  editing = m.id;
  document.getElementById("a-name").value = m.name || "";
  document.getElementById("a-loc").value = m.location || "";
  document.getElementById("a-lat").value = m.lat;
  document.getElementById("a-lng").value = m.lng;
  document.getElementById("a-bio").value = m.bio || "";
  document.getElementById("a-contact").value = m.contactLabel || "";
  document.getElementById("a-email").value = m.email || "";
  document.getElementById("a-status").value = m.status;
  document.getElementById("a-consent").checked = !!m.consentPublic;
  document.getElementById("admin-edit-error").style.display = "none";
  document.querySelectorAll("#edit-dialog .field.has-error").forEach((n) => n.classList.remove("has-error"));

  document.getElementById("edit-dialog").showModal();
  setTimeout(() => initPickMap(m.lat, m.lng), 50);
}

function initPickMap(lat, lng) {
  if (!pick.map) {
    const map = L.map("admin-pickmap", { worldCopyJump: true }).setView([lat, lng], 5);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(map);
    map.on("click", (e) => setLatLng(e.latlng.lat, e.latlng.lng));
    pick.map = map;
  } else {
    pick.map.invalidateSize();
    pick.map.setView([lat, lng], 5);
  }
  setLatLng(lat, lng);
}

function setLatLng(lat, lng) {
  document.getElementById("a-lat").value = lat.toFixed(6);
  document.getElementById("a-lng").value = lng.toFixed(6);
  if (!pick.marker) {
    pick.marker = L.marker([lat, lng], { draggable: true }).addTo(pick.map);
    pick.marker.on("dragend", () => {
      const ll = pick.marker.getLatLng();
      document.getElementById("a-lat").value = ll.lat.toFixed(6);
      document.getElementById("a-lng").value = ll.lng.toFixed(6);
    });
  } else {
    pick.marker.setLatLng([lat, lng]);
  }
}

function showFieldErrors(fields) {
  document.querySelectorAll("#edit-dialog .field.has-error").forEach((n) => n.classList.remove("has-error"));
  for (const [name, msg] of Object.entries(fields || {})) {
    const wrap = document.getElementById(`f-${name}`);
    if (!wrap) continue;
    wrap.classList.add("has-error");
    const e = wrap.querySelector("[data-err]");
    if (e) e.textContent = msg;
  }
}

async function onSave(e) {
  e.preventDefault();
  const errBox = document.getElementById("admin-edit-error");
  errBox.style.display = "none";
  const payload = {
    display_name: document.getElementById("a-name").value,
    location_name: document.getElementById("a-loc").value,
    lat: Number(document.getElementById("a-lat").value),
    lng: Number(document.getElementById("a-lng").value),
    bio: document.getElementById("a-bio").value,
    contact: document.getElementById("a-contact").value,
    email: document.getElementById("a-email").value,
    consent_public: document.getElementById("a-consent").checked,
    status: document.getElementById("a-status").value,
  };
  const { ok, data } = await api(`/api/members/${encodeURIComponent(editing)}`, {
    method: "PUT",
    body: payload,
  });
  if (!ok) {
    if (data.fields) showFieldErrors(data.fields);
    errBox.textContent = data.error || "Could not save.";
    errBox.style.display = "block";
    return;
  }
  document.getElementById("edit-dialog").close();
  await refresh();
}

async function onDelete() {
  if (!confirm("Permanently delete this entry?")) return;
  const { ok } = await api(`/api/members/${encodeURIComponent(editing)}`, { method: "DELETE" });
  if (ok) {
    document.getElementById("edit-dialog").close();
    await refresh();
  }
}

async function refresh() {
  const { data } = await api("/api/admin/members");
  MEMBERS = Array.isArray(data.members) ? data.members : [];
  const q = document.getElementById("admin-filter").value.trim().toLowerCase();
  renderRows(!q ? MEMBERS : MEMBERS.filter((m) =>
    [m.name, m.location, m.email, m.contactLabel].some((f) => (f || "").toLowerCase().includes(q))));
}
