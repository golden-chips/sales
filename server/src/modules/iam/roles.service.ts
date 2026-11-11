import type { Db } from "../../db/pool.js";
import { ROLE_TEMPLATES, expand } from "../../core/roleTemplates.js";

/** Idempotently creates system roles and adds any template permission they miss. Never removes custom grants. */
export async function syncSystemRoles(db: Db, tenantId: string) {
  const all = (await db.query("SELECT code, is_sensitive AS sensitive FROM permissions")).rows as { code: string; sensitive: boolean }[];
  for (const t of ROLE_TEMPLATES) {
    const { rows } = await db.query(
      `INSERT INTO roles (tenant_id, code, name_ar, name_en, is_system) VALUES ($1,$2,$3,$4,true)
       ON CONFLICT (tenant_id, code) DO UPDATE SET name_ar = EXCLUDED.name_ar, name_en = EXCLUDED.name_en, is_system = true
       RETURNING id`,
      [tenantId, t.code, t.nameAr, t.nameEn],
    );
    const perms = expand(t.grants, all);
    if (perms.length)
      await db.query(
        `INSERT INTO role_permissions (tenant_id, role_id, permission_code) SELECT $1, $2, unnest($3::text[]) ON CONFLICT DO NOTHING`,
        [tenantId, rows[0].id, perms],
      );
  }
}

export async function roleIdByCode(db: Db, code: string): Promise<string | null> {
  const r = await db.query("SELECT id FROM roles WHERE code = $1", [code]);
  return r.rows[0]?.id ?? null;
}
