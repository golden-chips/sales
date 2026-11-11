// Forward-only, checksummed SQL migrations. Run with the OWNER connection
// (DATABASE_ADMIN_URL), never with the runtime golden_app role.
import { readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../db/migrations");

export async function migrate(adminUrl: string, log = console.log) {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const applied = new Map<string, string>(
      (await client.query("SELECT version, checksum FROM schema_migrations")).rows.map((r) => [r.version, r.checksum]),
    );
    const files = readdirSync(dir).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
    for (const f of files) {
      const sql = readFileSync(path.join(dir, f), "utf8");
      const sum = createHash("sha256").update(sql).digest("hex");
      const prev = applied.get(f);
      if (prev) {
        if (prev !== sum) throw new Error(`Migration ${f} was modified after being applied. Create a new migration instead.`);
        continue;
      }
      log(`applying ${f}`);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations(version, checksum) VALUES ($1, $2)", [f, sum]);
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${f} failed: ${(e as Error).message}`);
      }
    }
  } finally {
    await client.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const url = process.env.DATABASE_ADMIN_URL;
  if (!url) { console.error("DATABASE_ADMIN_URL is required"); process.exit(1); }
  migrate(url).then(() => console.log("migrations up to date")).catch((e) => { console.error(e.message); process.exit(1); });
}
