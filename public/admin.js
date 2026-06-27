import { api, compressImageToBlob, configureLeafletIcons, copyText, createPhotoField, deleteMemberImage, downloadBlob, downloadFile, el, getConfig, memberImageUrl, uploadMemberImage } from "/common.js";
import { mapHeaders, parseCsvObjects, toCsv } from "/csv.js";
import { buildZip, readZip } from "/zip.js";

const L = window.L;
configureLeafletIcons(L);

let CONFIG = {};
let MEMBERS = [];
let editing = null; // currently edited member id
let editPhoto = null; // profile-photo picker in the edit dialog
const selected = new Set(); // selected public ids (persists across filtering)
const pick = { map: null, marker: null };

init().catch((err) => console.error(err));

async function init() {
  CONFIG = await getConfig();
  applyBranding();
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

/** Apply the (configurable) community branding to the page chrome. */
function applyBranding() {
  const name = CONFIG.communityName || "Midhrami Studios";
  document.title = `Admin — ${CONFIG.appName || name + " Member Map"}`;
  const community = document.getElementById("community-link");
  if (community) {
    if (CONFIG.communityUrl) community.href = CONFIG.communityUrl;
    community.textContent = name;
  }
}

function show(id) {
  for (const v of ["login-view", "not-configured", "loading-view", "dash-view"]) {
    const node = document.getElementById(v);
    if (node) node.style.display = v === id ? "block" : "none";
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
  render();

  document.getElementById("logout-btn").addEventListener("click", onLogout);
  document.getElementById("admin-filter").addEventListener("input", render);
  document.getElementById("filter-status").addEventListener("change", render);
  document.getElementById("filter-consent").addEventListener("change", render);
  document.getElementById("filter-location").addEventListener("change", render);
  document.getElementById("filter-clear").addEventListener("click", clearFilters);
  document.getElementById("export-btn").addEventListener("click", (e) => exportCsv(MEMBERS, e.currentTarget));
  document.getElementById("bulk-export").addEventListener("click", exportSelected);
  document.getElementById("select-all").addEventListener("change", onSelectAll);
  document.getElementById("bulk-clear").addEventListener("click", clearSelection);
  document.querySelectorAll("[data-bulk]").forEach((b) =>
    b.addEventListener("click", () => onBulk(b.dataset.bulk)));
  wireEditDialog();
  wireImport();
  wireMerge();
  wireSettings();
}

async function onLogout() {
  await api("/api/admin/logout", { method: "POST" });
  location.reload();
}

// --- Rendering ------------------------------------------------------------
/** Small round thumbnail (photo or initial) for the admin table name cell. */
function thumbEl(m) {
  const url = memberImageUrl(m);
  if (url) {
    return el("span", { class: "admin-thumb" }, [el("img", { src: url, alt: "", loading: "lazy" })]);
  }
  const initial = (m.name || "?").trim().charAt(0).toUpperCase() || "?";
  return el("span", { class: "admin-thumb" }, [el("span", { class: "ph", text: initial })]);
}

// A member is treated as "needs location" when it sits on the placeholder pin
// (0,0) used for unresolved imports.
const needsLocation = (m) => Number(m.lat) === 0 && Number(m.lng) === 0;

function filteredMembers() {
  const q = document.getElementById("admin-filter").value.trim().toLowerCase();
  const status = document.getElementById("filter-status").value;
  const consent = document.getElementById("filter-consent").value;
  const location = document.getElementById("filter-location").value;

  return MEMBERS.filter((m) => {
    if (status && m.status !== status) return false;
    if (consent === "on" && !m.consentPublic) return false;
    if (consent === "off" && m.consentPublic) return false;
    if (location === "missing" && !needsLocation(m)) return false;
    if (location === "has" && needsLocation(m)) return false;
    if (q && ![m.name, m.location, m.email, m.contactLabel].some((f) => (f || "").toLowerCase().includes(q)))
      return false;
    return true;
  });
}

function anyFilterActive() {
  return Boolean(
    document.getElementById("admin-filter").value.trim() ||
    document.getElementById("filter-status").value ||
    document.getElementById("filter-consent").value ||
    document.getElementById("filter-location").value,
  );
}

function clearFilters() {
  document.getElementById("admin-filter").value = "";
  document.getElementById("filter-status").value = "";
  document.getElementById("filter-consent").value = "";
  document.getElementById("filter-location").value = "";
  render();
}

function render() {
  const members = filteredMembers();
  const tbody = document.getElementById("admin-rows");
  tbody.replaceChildren();

  for (const m of members) {
    const check = el("input", { type: "checkbox", class: "row-check" });
    check.checked = selected.has(m.id);
    check.addEventListener("change", () => {
      if (check.checked) selected.add(m.id);
      else selected.delete(m.id);
      syncSelectionUi();
    });

    const statusBadge = el("span", { class: `badge ${m.status}`, text: m.status });
    const editBtn = el("button", { class: "btn small", type: "button", text: "Edit" });
    editBtn.addEventListener("click", () => openEdit(m));
    const linkBtn = el("button", { class: "btn small ghost", type: "button", text: "Copy link" });
    linkBtn.addEventListener("click", () => copyEditLink(m, linkBtn));

    const row = el("tr", {}, [
      el("td", { class: "col-check" }, [check]),
      el("td", {}, [el("div", { class: "admin-name" }, [thumbEl(m), el("strong", { text: m.name })])]),
      el("td", { text: m.location }),
      el("td", { text: m.contactLabel || "—" }),
      el("td", { text: m.email || "—" }),
      el("td", {}, [statusBadge, m.consentPublic ? null : el("div", { class: "muted", text: "off map" })]),
      el("td", { text: new Date(m.createdAt).toLocaleDateString() }),
      el("td", { class: "col-actions" }, [el("div", { class: "row-actions" }, [editBtn, linkBtn])]),
    ]);
    if (selected.has(m.id)) row.classList.add("selected");
    tbody.append(row);
  }

  const active = anyFilterActive();
  document.getElementById("admin-empty").textContent = active
    ? "No entries match these filters."
    : "No entries yet.";
  document.getElementById("admin-empty").style.display = members.length ? "none" : "block";
  document.getElementById("admin-count").textContent = active
    ? `${members.length} shown · ${MEMBERS.length} total`
    : `${MEMBERS.length} total`;
  document.getElementById("filter-clear").style.display = active ? "inline-flex" : "none";
  syncSelectionUi();
}

function syncSelectionUi() {
  const visible = filteredMembers();
  const visibleSelected = visible.filter((m) => selected.has(m.id)).length;
  const all = document.getElementById("select-all");
  all.checked = visible.length > 0 && visibleSelected === visible.length;
  all.indeterminate = visibleSelected > 0 && visibleSelected < visible.length;

  const bar = document.getElementById("bulkbar");
  bar.style.display = selected.size ? "flex" : "none";
  document.getElementById("bulk-count").textContent =
    `${selected.size} selected`;

  // Merge needs at least two records to combine.
  const mergeBtn = document.getElementById("bulk-merge");
  if (mergeBtn) {
    mergeBtn.disabled = selected.size < 2;
    mergeBtn.title = selected.size < 2
      ? "Select two or more records to merge"
      : "Combine the selected records into one";
  }

  // Keep row highlight + checkbox state in sync.
  document.querySelectorAll("#admin-rows tr").forEach((tr, i) => {
    const m = visible[i];
    if (!m) return;
    tr.classList.toggle("selected", selected.has(m.id));
  });
}

function onSelectAll(e) {
  const visible = filteredMembers();
  if (e.target.checked) visible.forEach((m) => selected.add(m.id));
  else visible.forEach((m) => selected.delete(m.id));
  render();
}

function clearSelection() {
  selected.clear();
  render();
}

// --- Bulk actions ---------------------------------------------------------
const BULK_LABELS = {
  publish: "publish", pending: "mark pending", hide: "hide",
  consent_on: "show on map", consent_off: "remove from map", delete: "delete",
};

async function onBulk(action) {
  const ids = [...selected];
  if (!ids.length) return;
  if (action === "delete" &&
      !confirm(`Permanently delete ${ids.length} ${ids.length === 1 ? "entry" : "entries"}? This cannot be undone.`)) {
    return;
  }
  const { ok, data } = await api("/api/admin/bulk", { method: "POST", body: { ids, action } });
  if (!ok) {
    flash("dash-error", data.error || "Bulk action failed.");
    return;
  }
  selected.clear();
  await refresh();
  flash("dash-ok", `Done: ${BULK_LABELS[action] || action} applied to ${data.count} ${data.count === 1 ? "entry" : "entries"}.`);
}

// --- Per-member edit link -------------------------------------------------
async function copyEditLink(m, btn) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "…";
  const { ok, data } = await api(`/api/admin/members/${encodeURIComponent(m.id)}/edit-link`, { method: "POST" });
  btn.disabled = false;
  if (!ok || !data.editUrl) {
    btn.textContent = "Failed";
    setTimeout(() => (btn.textContent = original), 1500);
    return;
  }
  const copied = await copyText(data.editUrl);
  btn.textContent = copied ? "Copied!" : "Copy failed";
  if (!copied) prompt("Copy this edit link:", data.editUrl);
  setTimeout(() => (btn.textContent = original), 1500);
}

// --- Edit dialog ----------------------------------------------------------
function wireEditDialog() {
  const dialog = document.getElementById("edit-dialog");
  document.getElementById("close-edit").addEventListener("click", () => dialog.close());
  document.getElementById("admin-cancel").addEventListener("click", () => dialog.close());
  document.getElementById("admin-edit-form").addEventListener("submit", onSave);
  document.getElementById("admin-delete").addEventListener("click", onDelete);
  document.getElementById("a-genlink").addEventListener("click", onGenerateLink);
  document.getElementById("a-copylink").addEventListener("click", onCopyDialogLink);

  editPhoto = createPhotoField({ hint: "Square works best. JPG, PNG or WebP — resized automatically." });
  editPhoto.onError(showEditError);
  document.getElementById("admin-photo-holder").append(editPhoto.element);
}

function showEditError(msg) {
  const box = document.getElementById("admin-edit-error");
  box.textContent = msg;
  box.style.display = "block";
}

function openEdit(m) {
  editing = m.id;
  if (editPhoto) editPhoto.setExisting(memberImageUrl(m));
  document.getElementById("a-name").value = m.name || "";
  document.getElementById("a-loc").value = m.location || "";
  document.getElementById("a-lat").value = m.lat;
  document.getElementById("a-lng").value = m.lng;
  document.getElementById("a-bio").value = m.bio || "";
  document.getElementById("a-contact").value = m.contactLabel || "";
  document.getElementById("a-email").value = m.email || "";
  document.getElementById("a-status").value = m.status;
  document.getElementById("a-consent").checked = !!m.consentPublic;
  document.getElementById("a-editlink").value = "";
  document.getElementById("admin-edit-error").style.display = "none";
  document.querySelectorAll("#edit-dialog .field.has-error").forEach((n) => n.classList.remove("has-error"));

  document.getElementById("edit-dialog").showModal();
  setTimeout(() => initPickMap(m.lat, m.lng), 50);
}

async function onGenerateLink() {
  const btn = document.getElementById("a-genlink");
  btn.disabled = true;
  btn.textContent = "…";
  const { ok, data } = await api(`/api/admin/members/${encodeURIComponent(editing)}/edit-link`, { method: "POST" });
  btn.disabled = false;
  btn.textContent = "Generate";
  if (ok && data.editUrl) {
    document.getElementById("a-editlink").value = data.editUrl;
  } else {
    flash("admin-edit-error", data.error || "Could not generate a link.");
  }
}

async function onCopyDialogLink() {
  const input = document.getElementById("a-editlink");
  if (!input.value) {
    await onGenerateLink();
  }
  if (!input.value) return;
  const btn = document.getElementById("a-copylink");
  const copied = await copyText(input.value);
  btn.textContent = copied ? "Copied!" : "Copy";
  if (!copied) input.select();
  setTimeout(() => (btn.textContent = "Copy"), 1500);
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

  // Persist any profile-photo change (admin is cookie-authenticated).
  const photo = editPhoto ? editPhoto.getState() : null;
  if (photo && (photo.blob || photo.removed)) {
    try {
      if (photo.blob) {
        const up = await uploadMemberImage(editing, photo.blob, { width: photo.width, height: photo.height });
        if (!up.ok) throw new Error(up.data.error || "photo upload failed");
      } else if (photo.removed) {
        await deleteMemberImage(editing);
      }
    } catch (err) {
      console.error("photo save failed", err);
      errBox.textContent = "Saved, but the photo couldn’t be updated. Please try again.";
      errBox.style.display = "block";
      await refresh();
      return;
    }
  }

  document.getElementById("edit-dialog").close();
  await refresh();
}

async function onDelete() {
  if (!confirm("Permanently delete this entry?")) return;
  const { ok } = await api(`/api/members/${encodeURIComponent(editing)}`, { method: "DELETE" });
  if (ok) {
    document.getElementById("edit-dialog").close();
    selected.delete(editing);
    await refresh();
  }
}

async function refresh() {
  const { data } = await api("/api/admin/members");
  MEMBERS = Array.isArray(data.members) ? data.members : [];
  // Drop selections that no longer exist.
  const ids = new Set(MEMBERS.map((m) => m.id));
  for (const id of [...selected]) if (!ids.has(id)) selected.delete(id);
  render();
}

function flash(id, message) {
  const others = ["dash-ok", "dash-error"].filter((x) => x !== id);
  others.forEach((x) => (document.getElementById(x).style.display = "none"));
  const box = document.getElementById(id);
  box.textContent = message;
  box.style.display = "block";
  setTimeout(() => { box.style.display = "none"; }, 5000);
}

// --- CSV export -----------------------------------------------------------
const EXPORT_COLUMNS = [
  "Name", "Location", "Contact", "Email", "Bio",
  "Latitude", "Longitude", "Status", "Consent", "PublicId",
];

const IMAGE_EXT = { "image/webp": "webp", "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif" };

function exportBaseName() {
  const slug = (CONFIG.communityName || "members")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "members";
  return `${slug}-members-${new Date().toISOString().slice(0, 10)}`;
}

function exportRow(m, imageName) {
  const row = {
    Name: m.name,
    Location: m.location,
    Contact: m.contactLabel || "",
    Email: m.email || "",
    Bio: m.bio || "",
    Latitude: m.lat,
    Longitude: m.lng,
    Status: m.status,
    Consent: m.consentPublic ? "Yes" : "No",
    PublicId: m.id,
  };
  if (imageName !== undefined) row.Image = imageName;
  return row;
}

async function exportCsv(members, btn) {
  const withPhotos = document.getElementById("export-photos")?.checked;
  const base = exportBaseName();

  if (!withPhotos) {
    downloadFile(`${base}.csv`, toCsv(EXPORT_COLUMNS, members.map((m) => exportRow(m))));
    return;
  }

  // Bundle the CSV + an images/ folder into a single .zip. Each member with a
  // photo gets a file named "<PublicId>.<ext>" referenced by the CSV's Image
  // column, so the same zip can be re-imported.
  const label = btn ? btn.textContent : "";
  if (btn) { btn.disabled = true; }
  try {
    const files = [];
    const rows = [];
    const photoMembers = members.filter((m) => m.imageUpdatedAt != null);
    let done = 0;
    const imageByMember = new Map();

    for (const m of photoMembers) {
      if (btn) btn.textContent = `Fetching photos… ${++done}/${photoMembers.length}`;
      try {
        const res = await fetch(memberImageUrl(m), { credentials: "same-origin" });
        if (!res.ok) continue;
        const type = res.headers.get("Content-Type") || "image/jpeg";
        const ext = IMAGE_EXT[type.split(";")[0].trim()] || "jpg";
        const name = `${m.id}.${ext}`;
        const bytes = new Uint8Array(await res.arrayBuffer());
        files.push({ name: `images/${name}`, data: bytes });
        imageByMember.set(m.id, name);
      } catch (err) {
        console.warn("export photo failed", m.id, err);
      }
    }

    for (const m of members) rows.push(exportRow(m, imageByMember.get(m.id) || ""));
    const csv = toCsv([...EXPORT_COLUMNS, "Image"], rows);
    files.unshift({ name: "members.csv", data: new TextEncoder().encode(csv) });

    if (btn) btn.textContent = "Building zip…";
    downloadBlob(`${base}.zip`, buildZip(files));
    flash("dash-ok", `Exported ${members.length} member${members.length === 1 ? "" : "s"} with ${files.length - 1} photo${files.length - 1 === 1 ? "" : "s"}.`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = label; }
  }
}

function exportSelected(e) {
  const members = MEMBERS.filter((m) => selected.has(m.id));
  if (members.length) exportCsv(members, e && e.currentTarget);
}

// --- CSV import (2-step wizard) -------------------------------------------
const importState = {
  rows: [], // { include, name, location, contact, email, status, consentPublic, lat, lng, state, matchedLabel, imageName }
  geocoding: false,
  cancelled: false,
  images: null, // Map<filename, Uint8Array> from the optional photos zip
  csvText: "", // raw text of the chosen CSV
  csvName: "", // chosen CSV filename (for the picker label)
  parsed: false, // whether csvText has been parsed into rows for review
  step: 1,
};

function wireImport() {
  document.getElementById("import-btn").addEventListener("click", openImport);
  document.getElementById("close-import").addEventListener("click", closeImport);
  document.getElementById("import-cancel").addEventListener("click", closeImport);
  document.getElementById("csv-file").addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) onCsvChosen(f);
  });
  document.getElementById("import-continue").addEventListener("click", onContinue);
  document.getElementById("import-back").addEventListener("click", () => goStep(1));
  document.getElementById("import-confirm").addEventListener("click", confirmImport);
  document.getElementById("zip-file").addEventListener("change", onZipChosen);
  document.getElementById("imp-all").addEventListener("click", () => setAllInclude(() => true));
  document.getElementById("imp-none").addEventListener("click", () => setAllInclude(() => false));
  document.getElementById("imp-matched").addEventListener("click", () =>
    setAllInclude((r) => r.state === "matched"));

  const drop = document.getElementById("filedrop");
  ["dragover", "dragenter"].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) =>
    drop.addEventListener(ev, () => drop.classList.remove("over")));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (file) onCsvChosen(file);
  });
}

function openImport() {
  importState.rows = [];
  importState.cancelled = false;
  importState.images = null;
  importState.csvText = "";
  importState.csvName = "";
  importState.parsed = false;
  document.getElementById("import-error").style.display = "none";
  document.getElementById("import-confirm").disabled = true;
  document.getElementById("import-continue").disabled = true;
  document.getElementById("csv-file").value = "";
  document.getElementById("zip-file").value = "";
  document.getElementById("csv-drop-label").textContent = "Choose a CSV file";
  document.getElementById("filedrop").classList.remove("chosen");
  resetZipStatus();
  goStep(1);
  document.getElementById("import-dialog").showModal();
}

/** Switch the wizard between step 1 (files) and step 2 (review). */
function goStep(n) {
  importState.step = n;
  document.getElementById("import-pick").style.display = n === 1 ? "block" : "none";
  document.getElementById("import-review").style.display = n === 2 ? "block" : "none";
  document.getElementById("import-back").classList.toggle("hidden", n !== 2);
  document.getElementById("import-continue").classList.toggle("hidden", n !== 1);
  document.getElementById("import-confirm").classList.toggle("hidden", n !== 2);
  document.querySelectorAll("#import-steps .wstep").forEach((li) => {
    const s = Number(li.dataset.step);
    li.classList.toggle("active", s === n);
    li.classList.toggle("done", s < n);
  });
}

function resetZipStatus() {
  document.getElementById("zip-status").replaceChildren(
    "Attach a ", el("code", { text: ".zip" }),
    " of images named by an ", el("strong", { text: "Image" }), " column in the CSV.",
  );
}

/** Step 1: a CSV was chosen (picker or drop). Read it; don't advance yet. */
function onCsvChosen(file) {
  const reader = new FileReader();
  reader.onload = () => {
    importState.csvText = String(reader.result || "");
    importState.csvName = file.name || "members.csv";
    importState.parsed = false;
    importState.rows = [];
    importState.cancelled = true; // stop any geocoding still running from a prior file
    document.getElementById("import-error").style.display = "none";
    document.getElementById("csv-drop-label").textContent = `✓ ${importState.csvName}`;
    document.getElementById("filedrop").classList.add("chosen");
    document.getElementById("import-continue").disabled = false;
  };
  reader.onerror = () => importError("Could not read that file.");
  reader.readAsText(file);
}

async function onZipChosen(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const status = document.getElementById("zip-status");
  status.textContent = "Reading zip…";
  try {
    importState.images = await readZip(await file.arrayBuffer());
    const n = importState.images.size;
    status.textContent = `✓ ${n} image${n === 1 ? "" : "s"} found — matched to the CSV’s Image column on the next step.`;
    if (importState.parsed) renderImportRows(); // refresh 📷 badges if already reviewed
  } catch (err) {
    console.error("zip read failed", err);
    importState.images = null;
    status.textContent = "Couldn’t read that zip file.";
  }
}

/** Step 1 → 2: parse the CSV (first time) and reveal the review table. */
function onContinue() {
  if (!importState.csvText) return;
  if (!importState.parsed) {
    const res = buildRows(importState.csvText);
    if (!res.ok) { importError(res.error); return; }
    importState.parsed = true;
    importState.cancelled = false;
    document.getElementById("import-error").style.display = "none";
    renderImportRows();
    goStep(2);
    geocodeAll();
    return;
  }
  // Returning from Back with rows already built: just reflect any zip change.
  renderImportRows();
  goStep(2);
}

function closeImport() {
  importState.cancelled = true;
  document.getElementById("import-dialog").close();
}

function importError(msg) {
  const box = document.getElementById("import-error");
  box.textContent = msg;
  box.style.display = "block";
}

/** Parse CSV text into review rows. Returns { ok, error? }. */
function buildRows(text) {
  let parsed;
  try {
    parsed = parseCsvObjects(text);
  } catch {
    return { ok: false, error: "That doesn't look like a valid CSV file." };
  }
  const map = mapHeaders(parsed.headers); // header -> field
  const byField = {};
  for (const [header, field] of Object.entries(map)) byField[field] = header;

  if (!byField.name && !byField.location) {
    return { ok: false, error: "Couldn't find name or location columns in that CSV." };
  }

  importState.rows = parsed.rows.map((r) => {
    const name = byField.name ? r[byField.name] : "";
    const location = byField.location ? r[byField.location] : "";
    const lat = byField.lat ? Number(r[byField.lat]) : NaN;
    const lng = byField.lng ? Number(r[byField.lng]) : NaN;
    const hasCoords = Number.isFinite(lat) && Number.isFinite(lng);
    return {
      include: hasCoords, // rows with coordinates are ready to import immediately
      name: (name || "").trim(),
      location: (location || "").trim(),
      contact: byField.contact ? (r[byField.contact] || "").trim() : "",
      email: byField.email ? (r[byField.email] || "").trim() : "",
      status: byField.status ? (r[byField.status] || "").trim().toLowerCase() : "published",
      consentPublic: byField.consent ? /^y|^true|^1/i.test(r[byField.consent] || "Yes") : true,
      lat: hasCoords ? lat : null,
      lng: hasCoords ? lng : null,
      matchedLabel: hasCoords ? "From CSV coordinates" : "",
      state: hasCoords ? "matched" : "pending",
      imageName: byField.image ? (r[byField.image] || "").trim() : "",
    };
  }).filter((r) => r.name || r.location);

  return { ok: true };
}

/** Build the "Resolved pin" cell for an import row. */
function pinCell(r) {
  if (r.state === "matched")
    return el("span", { class: "pin-ok", text: r.matchedLabel || `${r.lat.toFixed(3)}, ${r.lng.toFixed(3)}` });
  if (r.state === "pending")
    return el("span", { class: "muted", text: "…" });
  // review / error: importable as a pending draft the member can fix via their link.
  const reason = r.state === "error" ? "Lookup failed" : "No confident match";
  return el("span", { class: "pin-warn", text: `${reason} — imports as pending` });
}

/** A small "photo" badge for an import row that references an image filename. */
function photoBadge(r) {
  if (!r.imageName) return null;
  const found = importState.images && importState.images.has(r.imageName.split("/").pop());
  return el("span", {
    class: "pin-photo",
    title: found ? `Photo: ${r.imageName}` : `Photo "${r.imageName}" not found in the zip`,
    text: found ? " 📷" : " 📷⚠️",
  });
}

function renderImportRows() {
  const tbody = document.getElementById("import-rows");
  tbody.replaceChildren();
  importState.rows.forEach((r, i) => {
    const check = el("input", { type: "checkbox", class: "row-check" });
    check.checked = r.include;
    // Every row is selectable: unresolved ones import as a pending draft so an
    // admin can send the member their edit link to set a location manually.
    check.disabled = r.state === "pending"; // only while geocoding is in flight
    check.addEventListener("change", () => { r.include = check.checked; updateImportSummary(); });

    tbody.append(el("tr", { "data-i": i }, [
      el("td", { class: "col-check" }, [check]),
      el("td", {}, [r.name || "—", photoBadge(r)]),
      el("td", { text: r.location || "—" }),
      el("td", {}, [pinCell(r)]),
    ]));
  });
  updateImportSummary();
}

function updateImportRow(i) {
  const r = importState.rows[i];
  const tr = document.querySelector(`#import-rows tr[data-i="${i}"]`);
  if (!tr) return;
  const check = tr.querySelector(".row-check");
  check.disabled = r.state === "pending";
  check.checked = r.include;
  tr.children[3].replaceChildren(pinCell(r));
}

// A row can be selected once geocoding has settled it either way (matched, or
// unresolved → review/error). Rows still "pending" a lookup aren't selectable yet.
const isSelectable = (r) => r.state !== "pending";

function setAllInclude(predicate) {
  for (const r of importState.rows) {
    r.include = isSelectable(r) && predicate(r);
  }
  renderImportRows();
}

function updateImportSummary() {
  const total = importState.rows.length;
  const matched = importState.rows.filter((r) => r.state === "matched").length;
  const chosen = importState.rows.filter((r) => r.include);
  const unresolved = chosen.filter((r) => r.state !== "matched").length;
  document.getElementById("imp-summary").textContent =
    `${total} rows · ${matched} matched · ${chosen.length} selected` +
    (unresolved ? ` (${unresolved} as pending)` : "");
  document.getElementById("import-confirm").disabled = chosen.length === 0 || importState.geocoding;
  document.getElementById("import-confirm").textContent =
    chosen.length ? `Import ${chosen.length} selected` : "Import selected";
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function geocodeAll() {
  importState.geocoding = true;
  const bar = document.getElementById("geo-bar");
  const status = document.getElementById("geo-status");
  const pending = importState.rows.filter((r) => r.state === "pending");
  let done = 0;

  for (let i = 0; i < importState.rows.length; i++) {
    if (importState.cancelled) break;
    const r = importState.rows[i];
    if (r.state !== "pending") continue;

    status.textContent = `Geocoding ${done + 1} of ${pending.length}: ${r.location}`;
    try {
      const { data } = await api(`/api/geocode?q=${encodeURIComponent(r.location)}`);
      const hit = Array.isArray(data.results) && data.results[0];
      if (hit) {
        r.lat = hit.lat;
        r.lng = hit.lng;
        r.matchedLabel = hit.label.length > 48 ? hit.label.slice(0, 48) + "…" : hit.label;
        r.state = "matched";
        r.include = true;
      } else {
        r.state = "review";
      }
    } catch {
      r.state = "error";
    }
    updateImportRow(i);
    done++;
    bar.style.width = `${Math.round((done / Math.max(pending.length, 1)) * 100)}%`;
    updateImportSummary();
    await sleep(500); // be gentle with the geocoder
  }

  importState.geocoding = false;
  const matched = importState.rows.filter((r) => r.state === "matched").length;
  const unresolved = importState.rows.length - matched;
  status.textContent = importState.cancelled
    ? "Cancelled."
    : `Done. ${matched} of ${importState.rows.length} rows got a pin` +
      (unresolved ? `; ${unresolved} can still be imported as pending drafts.` : ".");
  bar.style.width = "100%";
  updateImportSummary();
}

async function confirmImport() {
  const rows = importState.rows.filter((r) => r.include && isSelectable(r));
  if (!rows.length) return;
  const btn = document.getElementById("import-confirm");
  btn.disabled = true;
  btn.textContent = "Importing…";

  const members = rows.map((r) => {
    const matched = r.state === "matched";
    return {
      display_name: r.name || r.location,
      location_name: r.location || r.matchedLabel,
      // Unresolved rows are imported at a placeholder pin and held as "pending"
      // (never shown publicly) until the member sets their real location via the
      // edit link an admin sends them.
      lat: matched ? r.lat : 0,
      lng: matched ? r.lng : 0,
      contact: r.contact,
      email: r.email,
      status: matched
        ? (["published", "pending", "hidden"].includes(r.status) ? r.status : "published")
        : "pending",
      consent_public: r.consentPublic,
    };
  });

  const { ok, data } = await api("/api/admin/import", { method: "POST", body: { members } });
  if (!ok) {
    importError(data.error || "Import failed.");
    btn.disabled = false;
    btn.textContent = "Import selected";
    return;
  }

  // Attach any photos from the zip to the newly created members. `data.created`
  // maps each accepted input row's index to its new public_id.
  let photoCount = 0;
  if (importState.images && importState.images.size && Array.isArray(data.created)) {
    photoCount = await uploadImportImages(rows, data.created, btn);
  }

  const pendingCount = members.filter((m) => m.status === "pending").length;
  closeImport();
  await refresh();
  const skipped = Array.isArray(data.skipped) ? data.skipped.length : 0;
  flash("dash-ok",
    `Imported ${data.imported} member${data.imported === 1 ? "" : "s"}` +
    (photoCount ? ` with ${photoCount} photo${photoCount === 1 ? "" : "s"}` : "") +
    (pendingCount ? `, ${pendingCount} held as pending (no location yet — send those members their edit link)` : "") +
    (skipped ? `; skipped ${skipped} invalid row${skipped === 1 ? "" : "s"}` : "") + ".");
}

/**
 * Upload images referenced by imported rows. `rows` is the array sent to the
 * import endpoint (same order); `created` is the server's [{index, id}] map.
 * Each referenced file is resized/compressed client-side before upload.
 */
async function uploadImportImages(rows, created, btn) {
  let uploaded = 0;
  let processed = 0;
  for (const { index, id } of created) {
    const r = rows[index];
    if (!r || !r.imageName) continue;
    const bytes = importState.images.get(r.imageName.split("/").pop());
    processed++;
    if (btn) btn.textContent = `Uploading photos… ${processed}`;
    if (!bytes) continue;
    try {
      const { blob, width, height } = await compressImageToBlob(new Blob([bytes]));
      const up = await uploadMemberImage(id, blob, { width, height });
      if (up.ok) uploaded++;
      else console.warn("import photo upload rejected", id, up.data);
    } catch (err) {
      console.warn("import photo failed", r.imageName, err);
    }
  }
  return uploaded;
}

// --- Merge (de-duplication) ----------------------------------------------
// Combine several records into one. The admin picks which record to keep (it
// retains its public id + edit link) and, per field, which record's value to
// use. The other selected records are deleted server-side.
const MERGE_FIELDS = [
  { key: "name", label: "Name", get: (m) => m.name || "" },
  { key: "location", label: "Location", get: (m) => m.location || "" },
  { key: "bio", label: "Bio", get: (m) => m.bio || "" },
  { key: "contact", label: "Contact", get: (m) => m.contactLabel || "" },
  { key: "email", label: "Email", get: (m) => m.email || "" },
  { key: "status", label: "Status", get: (m) => m.status || "" },
  { key: "consent", label: "On map (opted in)", get: (m) => (m.consentPublic ? "Yes" : "No") },
];

const mergeState = { records: [], primaryId: null, choices: {}, touched: new Set(), imageSource: "", imageTouched: false };

function wireMerge() {
  document.getElementById("bulk-merge").addEventListener("click", openMerge);
  const dialog = document.getElementById("merge-dialog");
  document.getElementById("close-merge").addEventListener("click", () => dialog.close());
  document.getElementById("merge-cancel").addEventListener("click", () => dialog.close());
  document.getElementById("merge-confirm").addEventListener("click", confirmMerge);
}

const mergeRecById = (id) => mergeState.records.find((m) => m.id === id);

function mergePreview(text) {
  const t = String(text == null ? "" : text);
  if (!t) return "—";
  return t.length > 80 ? t.slice(0, 80) + "…" : t;
}

function openMerge() {
  const records = MEMBERS.filter((m) => selected.has(m.id));
  if (records.length < 2) {
    flash("dash-error", "Select two or more records to merge.");
    return;
  }
  mergeState.records = records;
  mergeState.primaryId = records[0].id;
  mergeState.touched = new Set();
  mergeState.choices = {};
  for (const f of MERGE_FIELDS) mergeState.choices[f.key] = records[0].id;
  // Default the kept photo to the primary's (if it has one), else none.
  mergeState.imageSource = records[0].imageUpdatedAt != null ? records[0].id : "";
  mergeState.imageTouched = false;
  document.getElementById("merge-error").style.display = "none";
  renderMerge();
  document.getElementById("merge-dialog").showModal();
}

function renderMerge() {
  const wrap = document.getElementById("merge-fields");
  wrap.replaceChildren();

  // "Record to keep": which row survives (keeps its id + edit link). Changing
  // it re-defaults every field the admin hasn't manually overridden.
  const keepGroup = el("div", { class: "merge-field" }, [
    el("div", { class: "merge-flabel", text: "Record to keep" }),
  ]);
  for (const m of mergeState.records) {
    const id = `keep-${m.id}`;
    const radio = el("input", { type: "radio", name: "merge-keep", id });
    radio.checked = mergeState.primaryId === m.id;
    radio.addEventListener("change", () => {
      mergeState.primaryId = m.id;
      for (const f of MERGE_FIELDS) {
        if (!mergeState.touched.has(f.key)) mergeState.choices[f.key] = m.id;
      }
      if (!mergeState.imageTouched) {
        mergeState.imageSource = m.imageUpdatedAt != null ? m.id : "";
      }
      renderMerge();
    });
    keepGroup.append(el("label", { class: "merge-opt keep-opt", for: id }, [
      radio,
      el("span", { class: "merge-opt-val", text: `${m.name || "—"} · ${m.location || "no location"}` }),
    ]));
  }
  wrap.append(keepGroup);

  // Profile photo: pick which record's photo the kept record should end up with
  // (only records that actually have one), or "No photo". Shown only when at
  // least one selected record has a photo.
  const withPhoto = mergeState.records.filter((m) => m.imageUpdatedAt != null);
  if (withPhoto.length) {
    const photoGroup = el("div", { class: "merge-field" }, [
      el("div", { class: "merge-flabel", text: "Profile photo" }),
    ]);
    const options = [
      ...withPhoto.map((m) => ({ id: m.id, label: m.name || "—", url: memberImageUrl(m) })),
      { id: "", label: "No photo", url: null },
    ];
    for (const o of options) {
      const id = `m-photo-${o.id || "none"}`;
      const radio = el("input", { type: "radio", name: "merge-photo", id });
      radio.checked = mergeState.imageSource === o.id;
      radio.addEventListener("change", () => {
        mergeState.imageSource = o.id;
        mergeState.imageTouched = true;
      });
      const children = [radio];
      if (o.url) children.push(el("span", { class: "admin-thumb" }, [el("img", { src: o.url, alt: "" })]));
      children.push(el("span", { class: "merge-opt-val", text: o.label }));
      photoGroup.append(el("label", { class: "merge-opt", for: id }, children));
    }
    wrap.append(photoGroup);
  }

  for (const f of MERGE_FIELDS) {
    const group = el("div", { class: "merge-field" }, [
      el("div", { class: "merge-flabel", text: f.label }),
    ]);
    for (const m of mergeState.records) {
      const id = `m-${f.key}-${m.id}`;
      const radio = el("input", { type: "radio", name: `merge-${f.key}`, id });
      radio.checked = mergeState.choices[f.key] === m.id;
      radio.addEventListener("change", () => {
        mergeState.choices[f.key] = m.id;
        mergeState.touched.add(f.key);
      });
      group.append(el("label", { class: "merge-opt", for: id }, [
        radio,
        el("span", { class: "merge-opt-val", text: mergePreview(f.get(m)) }),
        el("span", { class: "merge-opt-src muted", text: mergeState.primaryId === m.id ? "kept record" : (m.name || "—") }),
      ]));
    }
    wrap.append(group);
  }
  updateMergeSummary();
}

function updateMergeSummary() {
  const n = mergeState.records.length;
  const keep = mergeRecById(mergeState.primaryId);
  document.getElementById("merge-summary").textContent =
    `Keep “${keep ? keep.name || "—" : "—"}”, delete ${n - 1} other${n - 1 === 1 ? "" : "s"}.`;
}

async function confirmMerge() {
  const keep = mergeRecById(mergeState.primaryId);
  if (!keep) return;
  const c = mergeState.choices;
  const loc = mergeRecById(c.location) || keep;
  const fields = {
    display_name: (mergeRecById(c.name) || keep).name || "",
    location_name: loc.location || "",
    lat: loc.lat,
    lng: loc.lng,
    bio: (mergeRecById(c.bio) || keep).bio || "",
    contact: (mergeRecById(c.contact) || keep).contactLabel || "",
    email: (mergeRecById(c.email) || keep).email || "",
    status: (mergeRecById(c.status) || keep).status,
    consent_public: !!(mergeRecById(c.consent) || keep).consentPublic,
  };
  const mergeIds = mergeState.records.map((m) => m.id);
  const others = mergeIds.length - 1;
  if (!confirm(
    `Merge ${mergeState.records.length} records into “${fields.display_name || "—"}”? ` +
    `This permanently deletes ${others} other record${others === 1 ? "" : "s"} and cannot be undone.`,
  )) return;

  const btn = document.getElementById("merge-confirm");
  btn.disabled = true;
  btn.textContent = "Merging…";
  const { ok, data } = await api("/api/admin/merge", {
    method: "POST",
    body: { primaryId: mergeState.primaryId, mergeIds, fields, imageSource: mergeState.imageSource },
  });
  btn.disabled = false;
  btn.textContent = "Merge records";
  if (!ok) {
    const box = document.getElementById("merge-error");
    box.textContent = data.error || "Merge failed.";
    box.style.display = "block";
    return;
  }
  document.getElementById("merge-dialog").close();
  selected.clear();
  await refresh();
  flash("dash-ok", `Merged ${(data.merged || others) + 1} records into one.`);
}

// --- Site settings (branding + integrations) ------------------------------
// Lets a community admin rebrand the map and tweak integrations from the
// dashboard. Fields are built from the server's setting definitions so the
// UI stays in sync with src/settings.ts. Secret values are never sent to the
// browser — only whether one is set.
let settingDefs = [];

function wireSettings() {
  document.getElementById("settings-btn").addEventListener("click", openSettings);
  const dialog = document.getElementById("settings-dialog");
  document.getElementById("close-settings").addEventListener("click", () => dialog.close());
  document.getElementById("settings-cancel").addEventListener("click", () => dialog.close());
  document.getElementById("settings-form").addEventListener("submit", onSaveSettings);
}

const SOURCE_LABEL = {
  dashboard: "set here",
  deployment: "from deployment config",
  default: "using default",
};

async function openSettings() {
  document.getElementById("settings-error").style.display = "none";
  document.getElementById("settings-ok").style.display = "none";
  const wrap = document.getElementById("settings-fields");
  wrap.replaceChildren(el("p", { class: "muted", text: "Loading…" }));
  document.getElementById("settings-dialog").showModal();

  const { ok, data } = await api("/api/admin/settings");
  if (!ok) {
    settingsError(data.error || "Could not load settings.");
    wrap.replaceChildren();
    return;
  }
  settingDefs = Array.isArray(data.settings) ? data.settings : [];
  renderSettings();
}

function renderSettings() {
  const wrap = document.getElementById("settings-fields");
  wrap.replaceChildren();

  for (const s of settingDefs) {
    const labelText = s.label + (s.required ? "" : " (optional)");
    const field = el("div", { class: "field", id: `f-set-${s.key}` }, [
      el("label", { for: `set-${s.key}`, text: labelText }),
    ]);

    if (s.type === "secret") {
      const input = el("input", {
        type: "password",
        id: `set-${s.key}`,
        autocomplete: "new-password",
        placeholder: s.isSet ? "•••••••• (set — leave blank to keep)" : "Not set",
      });
      field.append(input);
      if (s.isSet) {
        const clearWrap = el("label", { class: "checkbox set-clear" }, [
          el("input", { type: "checkbox", id: `clear-${s.key}` }),
          el("span", { text: "Clear (remove the saved value)" }),
        ]);
        field.append(clearWrap);
      }
    } else {
      const input = el("input", {
        type: s.type === "url" ? "url" : "text",
        id: `set-${s.key}`,
        value: s.value || "",
        placeholder: s.type === "url" ? "https://…" : "",
      });
      field.append(input);
    }

    field.append(el("div", { class: "hint", text: s.description }));
    field.append(el("div", {
      class: "hint muted",
      text: `Currently ${SOURCE_LABEL[s.source] || s.source}.`,
    }));
    field.append(el("div", { class: "err", "data-err": "" }));
    wrap.append(field);
  }
}

function settingsError(msg) {
  const box = document.getElementById("settings-error");
  box.textContent = msg;
  box.style.display = "block";
}

function showSettingErrors(fields) {
  document.querySelectorAll("#settings-fields .field.has-error")
    .forEach((n) => n.classList.remove("has-error"));
  for (const [key, msg] of Object.entries(fields || {})) {
    const wrap = document.getElementById(`f-set-${key}`);
    if (!wrap) continue;
    wrap.classList.add("has-error");
    const e = wrap.querySelector("[data-err]");
    if (e) e.textContent = msg;
  }
}

async function onSaveSettings(e) {
  e.preventDefault();
  document.getElementById("settings-error").style.display = "none";
  document.getElementById("settings-ok").style.display = "none";
  document.querySelectorAll("#settings-fields .field.has-error")
    .forEach((n) => n.classList.remove("has-error"));

  const values = {};
  const clear = [];
  for (const s of settingDefs) {
    const input = document.getElementById(`set-${s.key}`);
    if (!input) continue;
    if (s.type === "secret") {
      const clearBox = document.getElementById(`clear-${s.key}`);
      if (clearBox && clearBox.checked) clear.push(s.key);
      else if (input.value) values[s.key] = input.value;
    } else {
      values[s.key] = input.value;
    }
  }

  const btn = document.getElementById("settings-save");
  btn.disabled = true;
  btn.textContent = "Saving…";
  const { ok, data } = await api("/api/admin/settings", { method: "PUT", body: { values, clear } });
  btn.disabled = false;
  btn.textContent = "Save settings";

  if (!ok) {
    if (data.fields) showSettingErrors(data.fields);
    settingsError(data.error || "Could not save settings.");
    return;
  }

  // Refresh the in-memory defs + re-apply branding live.
  settingDefs = Array.isArray(data.settings) ? data.settings : settingDefs;
  renderSettings();
  CONFIG = await getConfig();
  applyBranding();
  const okBox = document.getElementById("settings-ok");
  okBox.textContent = "Settings saved.";
  okBox.style.display = "block";
}
