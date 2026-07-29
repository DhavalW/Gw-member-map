import { api, configureLeafletIcons, createPhotoField, deleteMemberImage, el, getConfig, memberImageUrl, readEditCredential, resolveLocation, uploadMemberImage, wireLocationSearch } from "/common.js";

const L = window.L;
configureLeafletIcons(L);

const params = new URLSearchParams(location.search);
const publicId = params.get("id") || "";
const credential = readEditCredential();
let CONFIG = {};
let photoField = null;

// resolvedLabel is the location text the current pin was derived from;
// pinTouched flips when the member places the pin by hand (map click or
// marker drag). Together they let onSave know whether a typed location
// still needs geocoding.
const pick = { map: null, marker: null, picked: null, resolvedLabel: "", pinTouched: false };

init().catch((err) => console.error(err));

async function init() {
  CONFIG = await getConfig();
  applyBranding();

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

/**
 * Apply the configurable community branding to this page. The Worker already
 * rendered it into the HTML, so this only re-states it — and leaves a slot
 * blank rather than filling it with a placeholder name.
 */
function applyBranding() {
  if (CONFIG.appName) document.title = `Edit your entry — ${CONFIG.appName}`;
  const nameEl = document.getElementById("community-name");
  if (nameEl && CONFIG.communityName) nameEl.textContent = CONFIG.communityName;
}

function show(id) {
  for (const v of ["request-view", "loading-view", "edit-view"]) {
    document.getElementById(v).style.display = v === id ? "block" : "none";
  }
}

/**
 * Describe an entry's current public visibility, so the member always knows
 * whether their entry is awaiting approval, live, or hidden.
 */
function visibilityState(m) {
  if (m.status === "pending") {
    return {
      kind: "info",
      text: "Your entry is awaiting admin approval — it isn’t shown on the map yet. You can keep editing in the meantime.",
    };
  }
  if (m.status === "hidden") {
    return {
      kind: "warn",
      text: "An admin has hidden your entry, so it isn’t shown publicly right now.",
    };
  }
  // status === "published"
  if (m.consentPublic) {
    return { kind: "ok", text: "Your entry is approved and live on the map." };
  }
  return {
    kind: "info",
    text: "Your entry is approved, but it’s hidden from the map because public sharing is turned off below.",
  };
}

function showStatusBanner(m) {
  const banner = document.getElementById("status-banner");
  const s = visibilityState(m);
  banner.className = `notice ${s.kind}`;
  banner.textContent = s.text;
  banner.style.display = "block";
}

/** Status-aware confirmation shown after a successful save. */
function saveMessage(m) {
  if (!m) return "Saved! Your changes have been recorded.";
  if (m.status === "pending") {
    return "Saved! Your entry is awaiting admin approval and will appear on the map once approved.";
  }
  if (m.status === "hidden") {
    return "Saved! Note: an admin has hidden your entry, so it isn’t shown publicly.";
  }
  if (m.consentPublic) return "Saved! Your changes are live on the map.";
  return "Saved! Your entry is saved but hidden, because public sharing is turned off.";
}

function showRequestView(message) {
  show("request-view");
  if (message) {
    const box = document.getElementById("request-error");
    box.textContent = message;
    box.style.display = "block";
  }
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

  photoField = createPhotoField({ hint: "Square works best. JPG, PNG or WebP — resized automatically." });
  photoField.onError((msg) => {
    const errBox = document.getElementById("edit-error");
    errBox.textContent = msg;
    errBox.style.display = "block";
  });
  document.getElementById("photo-holder").append(photoField.element);
  loadExistingPhoto(m);

  showStatusBanner(m);

  initPickMap(m.lat, m.lng);
  pick.picked = { lat: m.lat, lng: m.lng };
  pick.resolvedLabel = m.location || "";
  pick.pinTouched = false;

  wireGeocode();
  document.getElementById("edit-form").addEventListener("submit", onSave);
  document.getElementById("delete-btn").addEventListener("click", onDelete);
}

/**
 * Show the member's existing photo in the picker. The image endpoint requires
 * the edit token for a not-yet-public entry, and an <img> tag can't send a
 * header — so fetch it with the token and hand the picker a local blob URL.
 */
async function loadExistingPhoto(m) {
  if (!photoField) return;
  if (m.imageUpdatedAt == null) { photoField.setExisting(null); return; }
  try {
    const res = await fetch(memberImageUrl(m), {
      headers: { "X-Edit-Token": credential },
      credentials: "same-origin",
    });
    if (!res.ok) { photoField.setExisting(null); return; }
    photoField.setExisting(URL.createObjectURL(await res.blob()));
  } catch (err) {
    console.warn("could not load existing photo", err);
    photoField.setExisting(null);
  }
}

function initPickMap(lat, lng) {
  const map = L.map("pickmap", { worldCopyJump: true }).setView([lat, lng], 6);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);
  map.on("click", (e) => {
    pick.pinTouched = true;
    setPick(e.latlng.lat, e.latlng.lng);
  });
  pick.map = map;
  setPick(lat, lng);
}

function setPick(lat, lng, recenter = false) {
  pick.picked = { lat, lng };
  if (!pick.marker) {
    pick.marker = L.marker([lat, lng], { draggable: true }).addTo(pick.map);
    pick.marker.on("dragend", () => {
      pick.pinTouched = true;
      const ll = pick.marker.getLatLng();
      pick.picked = { lat: ll.lat, lng: ll.lng };
    });
  } else {
    pick.marker.setLatLng([lat, lng]);
  }
  if (recenter) pick.map.setView([lat, lng], 9);
}

// Shared location search (see wireLocationSearch in common.js): every failure
// mode — endpoint unreachable, upstream geocoder down, no matches — tells the
// member what happened via the field hint instead of silently showing nothing.
function wireGeocode() {
  wireLocationSearch({
    input: document.getElementById("location_name"),
    results: document.getElementById("geo-results"),
    hint: document.querySelector("#f-location_name .hint"),
    pinHint: "Couldn’t search locations right now — click the map below to move your pin.",
    noMatchHint: "No matches — try a different spelling, or click the map to move your pin.",
    onPick: (r) => {
      setPick(r.lat, r.lng, true);
      pick.resolvedLabel = r.label;
      pick.pinTouched = false;
    },
  });
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

  // A location typed straight into the field (no dropdown pick, no manual pin
  // move) must still resolve: geocode it now so the entry doesn't silently
  // keep its old coordinates under a new location name.
  const typedLoc = document.getElementById("location_name").value.trim();
  if (typedLoc && typedLoc !== pick.resolvedLabel && !pick.pinTouched) {
    const r = await resolveLocation(typedLoc);
    if (r) {
      setPick(r.lat, r.lng, true);
      pick.resolvedLabel = r.label;
    }
  }

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
  btn.classList.add("loading");
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

    // Persist any profile-photo change (added/replaced or removed). The preview
    // already reflects the member's choice (a local blob, or the empty
    // placeholder), so there's no need to reload it from the server — which the
    // member couldn't do for a pending entry anyway, since an <img> tag can't
    // send the edit token.
    const photo = photoField ? photoField.getState() : null;
    if (photo && (photo.blob || photo.removed)) {
      try {
        if (photo.blob) {
          const up = await uploadMemberImage(publicId, photo.blob, {
            editToken: credential, width: photo.width, height: photo.height,
          });
          if (!up.ok) throw new Error(up.data.error || "photo upload failed");
        } else if (photo.removed) {
          await deleteMemberImage(publicId, { editToken: credential });
        }
      } catch (err) {
        console.error("photo save failed", err);
        errBox.textContent = "Your details were saved, but the photo couldn’t be updated. Please try again.";
        errBox.style.display = "block";
      }
    }

    // Reflect the saved entry's real visibility — never claim it's "live" when
    // it's actually pending approval or hidden.
    if (data.member) showStatusBanner(data.member);
    okBox.textContent = saveMessage(data.member);
    okBox.style.display = "block";
  } catch {
    errBox.textContent = "Network error. Please try again.";
    errBox.style.display = "block";
  } finally {
    btn.disabled = false;
    btn.classList.remove("loading");
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
