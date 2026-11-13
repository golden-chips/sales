// Container start-up step (idempotent): wait for PostgreSQL, apply pending
// migrations with the OWNER connection, give the runtime role golden_app its
// login password, then (optionally) run the idempotent seed. The API itself
// always connects as golden_app, so row-level security is enforced.
import pg from "pg";
import { migrate } from "../src/db/migrate.js";

const adminUrl = process.env.DATABASE_ADMIN_URL;
const appPassword = process.env.APP_DB_PASSWORD;
if (!adminUrl || !appPassword) { console.error("DATABASE_ADMIN_URL and APP_DB_PASSWORD are required"); process.exit(1); }

async function waitForDb() {
  for (let i = 1; i <= 60; i++) {
    const c = new pg.Client({ connectionString: adminUrl });
    try { await c.connect(); await c.end(); return; }
    catch { await c.end().catch(() => undefined); console.log(`waiting for database (${i})…`); await new Promise((r) => setTimeout(r, 2000)); }
  }
  throw new Error("database not reachable");
}

await waitForDb();
await migrate(adminUrl!);
const c = new pg.Client({ connectionString: adminUrl });
await c.connect();
const db = new URL(adminUrl!).pathname.slice(1);
await c.query(`ALTER ROLE golden_app LOGIN PASSWORD '${appPassword!.replace(/'/g, "''")}'`);
await c.query(`GRANT CONNECT ON DATABASE "${db.replace(/"/g, '""')}" TO golden_app`);
await c.end();
console.log("database ready (migrations applied, runtime role configured)");
