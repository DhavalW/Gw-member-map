import { api, configureLeafletIcons, debounce, el, getConfig, readEditCredential } from "/common.js";

const L = window.L;
configureLeafletIcons(L);

const params = new URLSearchParams(location.search);
const publicId = params.get("id") || "";
const credential = readEditCredential();
let CONFIG = {};

const pick = { map: null, marker: null, picked: null };

init().catch((err) => console.error(err));

async function init() {
  CONFIG = await getConfig();

  // Surface magic-link errors passed back as ?error=
  const errParam = params.get("error");
  if (errParam) {
    showRequestView(
      errParam === "expired"
        ? "That sign-in link has expired. Request a new one below."
        : "That link is invalid. Request a new one below.",
    );
    return;
  }

  if (!publicId || !credential) {
    showRequestView();
    return;
  }

  const { ok, status, data } = await api(`/api/members/${encodeURIComponent(publicId)}`, {
    headers: { "X-Edit-Token": credential },
  });

  if (!ok) {
    showRequestView(
      status === 401
        ? "This edit link is invalid or has expired."
        : "We couldn't find that entry.",
    );
    return;
  }

  showEditView(data.member);
}

function show(id) {
  for (const v of ["request-view", "loading-view", "edit-view"]) {
    document.getElementById(v).style.display = v === id ? "block" : "none";
  }
}

function showRequestView(message) {
  show("request-view");
  if (message) {
    const box = document.getElementById("request-error");
    box.textContent = message;
    box.style.display = "block";
  }
  if (CONFIG.emailConfigured) {
    document.getElementById("email-request").style.display = "block";
  }
  document.getElementById("request-form")?.addEventListener("submit", onRequestLink);
}

async function onRequestLink(e) {
  e.preventDefault();
  const email = document.getElementById("req-email").value;
  await api("/api/request-edit-link", { method: "POST", body: { email } });
  // Always show the same generic message (no account enumeration).
  document.getElementById("request-sent").style.display = "block";
  document.getElementById("request-form").style.display = "none";
}

function showEditView(m) {
  show("edit-view");
  document.getElementById("display_name").value = m.name || "";
  document.getElementById("location_name").value = m.location || "";
  document.getElementById("bio").value = m.bio || "";
  document.getElementById("contact").value = m.contactLabel || "";
  document.getElementById("email").value = m.email || "";
  document.getElementById("consent_public").checked = !!m.consentPublic;
  document.getElementById("consent-note").style.display = "block";

  initPickMap(m.lat, m.lng);
  pick.picked = { lat: m.lat, lng: m.lng };

  wireGeocode();
  document.getElementById("edit-form").addEventListener("submit", onSave);
  document.getElementById("delete-btn").addEventListener("click", onDelete);
}

function initPickMap(lat, lng) {
  const map = L.map("pickmap", { worldCopyJump: true }).setView([lat, lng], 6);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);
  map.on("click", (e) => setPick(e.latlng.lat, e.latlng.lng));
  pick.map = map;
  setPick(lat, lng);
}

function setPick(lat, lng, recenter = false) {
  pick.picked = { lat, lng };
  if (!pick.marker) {
    pick.marker = L.marker([lat, lng], { draggable: true }).addTo(pick.map);
    pick.marker.on("dragend", () => {
      const ll = pick.marker.getLatLng();
      pick.picked = { lat: ll.lat, lng: ll.lng };
    });
  } else {
    pick.marker.setLatLng([lat, lng]);
  }
  if (recenter) pick.map.setView([lat, lng], 9);
}

function wireGeocode() {
  const input = document.getElementById("location_name");
  const results = document.getElementById("geo-results");
  const search = debounce(async () => {
    const q = input.value.trim();
    if (q.length < 3) {
      results.classList.remove("show");
      return;
    }
    const { data } = await api(`/api/geocode?q=${encodeURIComponent(q)}`);
    const items = Array.isArray(data.results) ? data.results : [];
    results.replaceChildren();
    if (!items.length) {
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
      results.append(el("li", {}, [btn]));
    }
    results.classList.add("show");
  }, 350);
  input.addEventListener("input", search);
}

function showFieldErrors(fields) {
  document.querySelectorAll(".field.has-error").forEach((n) => n.classList.remove("has-error"));
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
  const btn = document.getElementById("save-btn");
  const okBox = document.getElementById("edit-ok");
  const errBox = document.getElementById("edit-error");
  okBox.style.display = "none";
  errBox.style.display = "none";

  const payload = {
    display_name: document.getElementById("display_name").value,
    location_name: document.getElementById("location_name").value,
    bio: document.getElementById("bio").value,
    contact: document.getElementById("contact").value,
    email: document.getElementById("email").value,
    consent_public: document.getElementById("consent_public").checked,
    lat: pick.picked?.lat,
    lng: pick.picked?.lng,
  };

  btn.disabled = true;
  btn.textContent = "Saving…";
  try {
    const { ok, data } = await api(`/api/members/${encodeURIComponent(publicId)}`, {
      method: "PUT",
      headers: { "X-Edit-Token": credential },
      body: payload,
    });
    if (!ok) {
      if (data.fields) showFieldErrors(data.fields);
      errBox.textContent = data.error || "Could not save changes.";
      errBox.style.display = "block";
      return;
    }
    okBox.textContent = "Saved! Your changes are live.";
    okBox.style.display = "block";
  } catch {
    errBox.textContent = "Network error. Please try again.";
    errBox.style.display = "block";
  } finally {
    btn.disabled = false;
    btn.textContent = "Save changes";
  }
}

async function onDelete() {
  if (!confirm("Permanently delete your entry from the map? This cannot be undone.")) return;
  const { ok } = await api(`/api/members/${encodeURIComponent(publicId)}`, {
    method: "DELETE",
    headers: { "X-Edit-Token": credential },
  });
  if (ok) {
    document.querySelector(".wrap").replaceChildren(
      el("div", { class: "card" }, [
        el("h1", { text: "Entry deleted" }),
        el("p", { text: "Your entry has been removed from the map." }),
        el("p", {}, [el("a", { href: "/", text: "Back to the map" })]),
      ]),
    );
  } else {
    const errBox = document.getElementById("edit-error");
    errBox.textContent = "Could not delete entry. Please try again.";
    errBox.style.display = "block";
  }
}
