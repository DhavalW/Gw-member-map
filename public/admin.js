import { api, configureLeafletIcons, copyText, downloadFile, el, getConfig } from "/common.js";
import { mapHeaders, parseCsvObjects, toCsv } from "/csv.js";

const L = window.L;
configureLeafletIcons(L);

let CONFIG = {};
let MEMBERS = [];
let editing = null; // currently edited member id
const selected = new Set(); // selected public ids (persists across filtering)
const pick = { map: null, marker: null };

init().catch((err) => console.error(err));

async function init() {
  CONFIG = await getConfig();
  const community = document.getElementById("community-link");
  if (community && CONFIG.communityUrl) {
    community.href = CONFIG.communityUrl;
    community.textContent = CONFIG.communityName || "Generalist World";
  }
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
  document.getElementById("export-btn").addEventListener("click", () => exportCsv(MEMBERS));
  document.getElementById("bulk-export").addEventListener("click", exportSelected);
  document.getElementById("select-all").addEventListener("change", onSelectAll);
  document.getElementById("bulk-clear").addEventListener("click", clearSelection);
  document.querySelectorAll("[data-bulk]").forEach((b) =>
    b.addEventListener("click", () => onBulk(b.dataset.bulk)));
  wireEditDialog();
  wireImport();
}

async function onLogout() {
  await api("/api/admin/logout", { method: "POST" });
  location.reload();
}

// --- Rendering ------------------------------------------------------------
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
      el("td", {}, [el("strong", { text: m.name })]),
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

function exportCsv(members) {
  const rows = members.map((m) => ({
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
  }));
  const stamp = new Date().toISOString().slice(0, 10);
  downloadFile(`generalist-world-members-${stamp}.csv`, toCsv(EXPORT_COLUMNS, rows));
}

function exportSelected() {
  const members = MEMBERS.filter((m) => selected.has(m.id));
  if (members.length) exportCsv(members);
}

// --- CSV import -----------------------------------------------------------
const importState = {
  rows: [], // { include, name, location, contact, email, status, consentPublic, lat, lng, state, matchedLabel }
  geocoding: false,
  cancelled: false,
};

function wireImport() {
  document.getElementById("import-btn").addEventListener("click", openImport);
  document.getElementById("close-import").addEventListener("click", closeImport);
  document.getElementById("import-cancel").addEventListener("click", closeImport);
  document.getElementById("csv-file").addEventListener("change", onFileChosen);
  document.getElementById("import-confirm").addEventListener("click", confirmImport);
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
    if (file) readFile(file);
  });
}

function openImport() {
  importState.rows = [];
  importState.cancelled = false;
  document.getElementById("import-error").style.display = "none";
  document.getElementById("import-pick").style.display = "block";
  document.getElementById("import-review").style.display = "none";
  document.getElementById("import-confirm").disabled = true;
  document.getElementById("csv-file").value = "";
  document.getElementById("import-dialog").showModal();
}

function closeImport() {
  importState.cancelled = true;
  document.getElementById("import-dialog").close();
}

function onFileChosen(e) {
  const file = e.target.files?.[0];
  if (file) readFile(file);
}

function readFile(file) {
  const reader = new FileReader();
  reader.onload = () => startReview(String(reader.result || ""));
  reader.onerror = () => importError("Could not read that file.");
  reader.readAsText(file);
}

function importError(msg) {
  const box = document.getElementById("import-error");
  box.textContent = msg;
  box.style.display = "block";
}

function startReview(text) {
  let parsed;
  try {
    parsed = parseCsvObjects(text);
  } catch {
    importError("That doesn't look like a valid CSV file.");
    return;
  }
  const map = mapHeaders(parsed.headers); // header -> field
  const byField = {};
  for (const [header, field] of Object.entries(map)) byField[field] = header;

  if (!byField.name && !byField.location) {
    importError("Couldn't find name or location columns in that CSV.");
    return;
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
    };
  }).filter((r) => r.name || r.location);

  document.getElementById("import-pick").style.display = "none";
  document.getElementById("import-review").style.display = "block";
  renderImportRows();
  geocodeAll();
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
      el("td", { text: r.name || "—" }),
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
  const pendingCount = members.filter((m) => m.status === "pending").length;
  closeImport();
  await refresh();
  const skipped = Array.isArray(data.skipped) ? data.skipped.length : 0;
  flash("dash-ok",
    `Imported ${data.imported} member${data.imported === 1 ? "" : "s"}` +
    (pendingCount ? `, ${pendingCount} held as pending (no location yet — send those members their edit link)` : "") +
    (skipped ? `; skipped ${skipped} invalid row${skipped === 1 ? "" : "s"}` : "") + ".");
}
