// READ-ONLY export of the old Firebase projects to JSON files.
// Run it yourself, on your own computer, with a service-account key of the
// Firebase project (Firebase console → Project settings → Service accounts →
// Generate new private key). The key never leaves your computer and must not
// be committed or sent to anyone.
//
//   npm install
//   node export.mjs --key ./van-sales-key.json --app van --out ./export
//   node export.mjs --key ./hudoori-key.json  --app hr  --out ./export
//
// The script only calls .get(): it cannot change or delete anything.
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import admin from "firebase-admin";

const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const key = arg("key"), app = arg("app"), out = arg("out") ?? "./export";
if (!key || !["van", "hr"].includes(app ?? "")) { console.error("usage: node export.mjs --key <service-account.json> --app van|hr [--out ./export]"); process.exit(1); }

const COLLECTIONS = {
  van: ["customers", "products", "reps", "vehicles", "invoices", "payments", "returns"],
  hr: ["employees", "employeePrivate", "departments", "schedules"],
};

admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync(key, "utf8"))) });
const db = admin.firestore();
// Firestore types → plain JSON (timestamps as ISO strings, geo points as {lat,lng})
const plain = (v) => {
  if (v === null || v === undefined) return v ?? null;
  if (v instanceof admin.firestore.Timestamp) return v.toDate().toISOString();
  if (v instanceof admin.firestore.GeoPoint) return { lat: v.latitude, lng: v.longitude };
  if (v instanceof admin.firestore.DocumentReference) return v.path;
  if (Array.isArray(v)) return v.map(plain);
  if (typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  return v;
};
const dir = path.join(out, app);
mkdirSync(dir, { recursive: true });
for (const c of COLLECTIONS[app]) {
  const snap = await db.collection(c).get();
  const docs = snap.docs.map((d) => ({ id: d.id, ...plain(d.data()) }));
  // employeePrivate holds salaries: keep the file as protected as the payroll itself
  writeFileSync(path.join(dir, `${c}.json`), JSON.stringify(docs, null, 1));
  console.log(`${app}/${c}: ${docs.length}`);
}
console.log(`done → ${dir}  (files contain customer and salary data: store them securely and delete after the migration)`);
