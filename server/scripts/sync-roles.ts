// Adds newly shipped permissions to every tenant's system roles (idempotent, never removes grants).
// Run after migrations that add permissions: npm run roles:sync
import { withPlatform, withPlatformInTenant, pool } from "../src/db/pool.js";
import { syncSystemRoles } from "../src/modules/iam/roles.service.js";

const ids = await withPlatform(async (db) => (await db.query("SELECT id, code FROM tenants ORDER BY created_at")).rows);
for (const t of ids) { await withPlatformInTenant(t.id, (db) => syncSystemRoles(db, t.id)); console.log(`roles synced: ${t.code}`); }
await pool.end();
