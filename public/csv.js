// Minimal, dependency-free CSV parser/serialiser (RFC 4180-ish).
// Handles quoted fields, escaped quotes (""), and newlines inside quotes.

/** Parse CSV text into an array of string[] rows. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  // Normalise line endings; strip a leading BOM if present.
  const s = text.replace(/^﻿/, "");

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      // Treat \r\n as a single break.
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  // Flush trailing field/row (unless the file ended on a clean newline).
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Parse CSV into objects keyed by header. Returns { headers, rows }.
 * Blank rows (every cell empty) are dropped.
 */
export function parseCsvObjects(text) {
  const matrix = parseCsv(text);
  if (matrix.length === 0) return { headers: [], rows: [] };
  const headers = matrix[0].map((h) => h.trim());
  const rows = [];
  for (let i = 1; i < matrix.length; i++) {
    const cells = matrix[i];
    if (cells.every((c) => c.trim() === "")) continue;
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = (cells[idx] ?? "").trim();
    });
    rows.push(obj);
  }
  return { headers, rows };
}

function escapeCell(value) {
  const s = value == null ? "" : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Serialise an array of objects to CSV text using the given column order. */
export function toCsv(columns, rows) {
  const lines = [columns.map(escapeCell).join(",")];
  for (const r of rows) {
    lines.push(columns.map((c) => escapeCell(r[c])).join(","));
  }
  return lines.join("\r\n");
}

/**
 * Best-effort mapping of an arbitrary header to a known field. Lets us ingest
 * both our own export and the raw Google-Form dump (whose headers are long
 * questions like "What's your approximate location?...").
 */
export function detectField(header) {
  const h = header.toLowerCase();
  // Check distinctive fields before the broad "location" rule: the raw form's
  // consent question ("…shared on our Members' Location Map?") contains the
  // word "location", so it must be matched as consent first.
  if (h.includes("consent") || h.includes("shared")) return "consent";
  if (h === "email" || h.includes("e-mail")) return "email";
  if (h.includes("latitude") || h === "lat") return "lat";
  if (h.includes("longitude") || h === "lng" || h === "lon") return "lng";
  if (h.includes("contact") || h.includes("preferred") || h.includes("link"))
    return "contact";
  if (h === "bio" || h.includes("about")) return "bio";
  if (h === "status") return "status";
  if (h === "id" || h.includes("publicid") || h.includes("public id")) return "id";
  if (/(^|[^a-z])name([^a-z]|$)/.test(h) && !h.includes("user")) return "name";
  if (h.includes("location") || h.includes("city") || h.includes("country") || h.includes("where"))
    return "location";
  return null;
}

/** Build a header -> field map for a parsed CSV's headers. */
export function mapHeaders(headers) {
  const map = {};
  headers.forEach((h) => {
    const field = detectField(h);
    if (field && !Object.values(map).includes(field)) map[h] = field;
  });
  return map;
}
