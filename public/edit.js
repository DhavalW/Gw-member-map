import { api, configureLeafletIcons, createPhotoField, debounce, deleteMemberImage, el, getConfig, memberImageUrl, readEditCredential, uploadMemberImage } from "/common.js";

const L = window.L;
configureLeafletIcons(L);

const params = new URLSearchParams(location.search);
const publicId = params.get("id") || "";
const credential = readEditCredential();
let CONFIG = {};
let photoField = null;

const pick = { map: null, marker: null, picked: null };

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

// Mirrors the sign-up form's location search (app.js): every failure mode —
// endpoint unreachable, upstream geocoder down, no matches — tells the member
// what happened via the field hint instead of silently showing no results.
function wireGeocode() {
  const input = document.getElementById("location_name");
  const results = document.getElementById("geo-results");
  const hint = document.querySelector("#f-location_name .hint");
  const defaultHint = hint ? hint.textContent : "";
  const setHint = (msg) => { if (hint) hint.textContent = msg || defaultHint; };
  const PIN_HINT = "Couldn’t search locations right now — click the map below to move your pin.";

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
    // tell the member instead of silently showing nothing.
    if (!ok || data.error || !Array.isArray(data.results)) {
      console.warn("geocode unavailable", { status, error: data.error });
      results.classList.remove("show");
      setHint(PIN_HINT);
      return;
    }

    const items = data.results;
    if (items.length === 0) {
      results.classList.remove("show");
      setHint("No matches — try a different spelling, or click the map to move your pin.");
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
