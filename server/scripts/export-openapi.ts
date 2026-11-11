// Writes the generated OpenAPI document to docs/api/openapi.json
import { writeFileSync, mkdirSync } from "node:fs";
import { buildApp } from "../src/app.js";
import { pool } from "../src/db/pool.js";

const app = await buildApp({ logger: false });
await app.ready();
mkdirSync("../docs/api", { recursive: true });
writeFileSync("../docs/api/openapi.json", JSON.stringify(app.swagger(), null, 2));
const n = Object.values((app.swagger() as any).paths).reduce((s: number, p: any) => s + Object.keys(p).length, 0);
console.log(`openapi.json written: ${n} operations`);
await app.close(); await pool.end();
