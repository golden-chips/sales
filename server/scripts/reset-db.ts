// Drops and rebuilds a database schema, then sets the runtime role password.
// Refuses to run against anything that does not look like a dev/test database.
import pg from "pg";
import { migrate } from "../src/db/migrate.js";

export async function resetDb(adminUrl: string, appPassword: string) {
  const dbName = new URL(adminUrl).pathname.slice(1);
  if (!/(_test|_dev)$/.test(dbName)) throw new Error(`refusing to reset database "${dbName}" (name must end with _test or _dev)`);
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  await c.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
  await c.end();
  await migrate(adminUrl, () => undefined);
  const c2 = new pg.Client({ connectionString: adminUrl });
  await c2.connect();
  await c2.query(`ALTER ROLE golden_app LOGIN PASSWORD '${appPassword.replace(/'/g, "''")}'`);
  await c2.query(`GRANT CONNECT ON DATABASE ${dbName} TO golden_app`);
  await c2.end();
}

if (process.argv[1]?.endsWith("reset-db.ts")) {
  const url = process.env.DATABASE_ADMIN_URL, pw = process.env.APP_DB_PASSWORD;
  if (!url || !pw) { console.error("DATABASE_ADMIN_URL and APP_DB_PASSWORD are required"); process.exit(1); }
  resetDb(url, pw).then(() => console.log("database reset")).catch((e) => { console.error(e.message); process.exit(1); });
}
