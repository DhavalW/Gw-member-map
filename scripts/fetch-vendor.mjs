// Copies the front-end map libraries into public/vendor so the app is fully
// self-hosted (no third-party script/style origins => strict CSP).
//
// Usage:
//   npm install            # ensures leaflet + leaflet.markercluster are present
//   npm run vendor
//
// The libs are declared as devDependencies, so they're installed from the npm
// registry (works behind restrictive networks) rather than fetched from a CDN.
import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const nm = join(root, "node_modules");
const vendor = join(root, "public", "vendor");

const FILES = [
  ["leaflet/dist/leaflet.js", "leaflet.js"],
  ["leaflet/dist/leaflet.css", "leaflet.css"],
  ["leaflet/dist/images/marker-icon.png", "images/marker-icon.png"],
  ["leaflet/dist/images/marker-icon-2x.png", "images/marker-icon-2x.png"],
  ["leaflet/dist/images/marker-shadow.png", "images/marker-shadow.png"],
  ["leaflet.markercluster/dist/leaflet.markercluster.js", "leaflet.markercluster.js"],
  ["leaflet.markercluster/dist/MarkerCluster.css", "MarkerCluster.css"],
  ["leaflet.markercluster/dist/MarkerCluster.Default.css", "MarkerCluster.Default.css"],
];

await mkdir(join(vendor, "images"), { recursive: true });
for (const [src, dest] of FILES) {
  await cp(join(nm, src), join(vendor, dest));
  console.log(`✓ ${dest}`);
}
console.log("Vendor assets ready in public/vendor.");
