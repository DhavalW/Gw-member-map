// Minimal, dependency-free ZIP reader/writer for the optional profile-image
// bundle used by bulk import/export. No external library is pulled in (the app
// runs under a strict `script-src 'self'` CSP).
//
// - Writing uses the STORE method (no compression). The images are already
//   compressed (WebP/JPEG), so re-deflating them buys nothing and STORE keeps
//   the writer tiny and correct.
// - Reading handles STORE (method 0) and DEFLATE (method 8). Deflate is
//   inflated with the browser-native DecompressionStream("deflate-raw"), so we
//   can still ingest zips produced by other tools (Finder, Windows, etc.).

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// --- CRC32 (required by the ZIP format) -----------------------------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// --- Writer ----------------------------------------------------------------
/**
 * Build a ZIP Blob from `[{ name, data: Uint8Array }]` using the STORE method.
 * Filenames are written as UTF-8.
 */
export function buildZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;

  const push = (arr) => { chunks.push(arr); offset += arr.length; };

  for (const file of files) {
    const nameBytes = textEncoder.encode(file.name);
    const data = file.data;
    const crc = crc32(data);
    const localOffset = offset;

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); // local file header signature
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0x0800, true); // flags: UTF-8 filename
    lv.setUint16(8, 0, true); // method: store
    lv.setUint16(10, 0, true); // mod time
    lv.setUint16(12, 0, true); // mod date
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true); // compressed size
    lv.setUint32(22, data.length, true); // uncompressed size
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true); // extra length
    local.set(nameBytes, 30);
    push(local);
    push(data);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true); // central directory signature
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0x0800, true); // flags: UTF-8
    cv.setUint16(10, 0, true); // method: store
    cv.setUint16(12, 0, true); // mod time
    cv.setUint16(14, 0, true); // mod date
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true); // extra length
    cv.setUint16(32, 0, true); // comment length
    cv.setUint16(34, 0, true); // disk number
    cv.setUint16(36, 0, true); // internal attrs
    cv.setUint32(38, 0, true); // external attrs
    cv.setUint32(42, localOffset, true);
    cd.set(nameBytes, 46);
    central.push(cd);
  }

  const centralStart = offset;
  for (const cd of central) push(cd);
  const centralSize = offset - centralStart;

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); // EOCD signature
  ev.setUint16(8, central.length, true); // entries on this disk
  ev.setUint16(10, central.length, true); // total entries
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralStart, true);
  push(eocd);

  return new Blob(chunks, { type: "application/zip" });
}

// --- Reader ----------------------------------------------------------------
async function inflateRaw(bytes) {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("This browser can't read compressed zips. Re-save the zip without compression.");
  }
  const ds = new DecompressionStream("deflate-raw");
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * Read a ZIP (ArrayBuffer) into a `Map<filename, Uint8Array>`. Only the file's
 * base name is used as the key (folders are flattened), which matches how the
 * import CSV references images by filename. Handles STORE and DEFLATE entries.
 */
export async function readZip(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const view = new DataView(arrayBuffer);
  const out = new Map();

  // Locate the End Of Central Directory record by scanning back from the end.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Not a valid zip file.");

  const entryCount = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true); // central directory offset

  for (let n = 0; n < entryCount; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = textDecoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    // Skip directory entries.
    if (name.endsWith("/")) continue;

    // Read the matching local header to find where the data starts (its name +
    // extra lengths can differ from the central record's).
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = bytes.subarray(dataStart, dataStart + compSize);

    let data;
    if (method === 0) data = raw.slice();
    else if (method === 8) data = await inflateRaw(raw);
    else continue; // unsupported method — skip

    const base = name.split("/").pop();
    if (base) out.set(base, data);
  }

  return out;
}
