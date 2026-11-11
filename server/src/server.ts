import { buildApp } from "./app.js";
import { assertSecretsStrong, config } from "./config.js";
import { pool } from "./db/pool.js";

assertSecretsStrong();
const app = await buildApp();
const { rows } = await pool.query("SELECT current_user AS u, (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass");
if (rows[0].bypass && config.env === "production") {
  app.log.fatal(`DATABASE_URL connects as ${rows[0].u}, which bypasses RLS. Use the golden_app role.`);
  process.exit(1);
} else if (rows[0].bypass) {
  app.log.warn(`DATABASE_URL role ${rows[0].u} bypasses RLS — tenant isolation is NOT enforced by the database in this environment`);
}
await app.listen({ port: config.port, host: config.host });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, async () => { await app.close(); await pool.end(); process.exit(0); });
