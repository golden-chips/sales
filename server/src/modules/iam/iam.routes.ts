import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { can, tdb } from "../../core/auth.js";
import { parse, zPage, pageSql, paged, zUuid } from "../../core/http.js";
import { E } from "../../core/errors.js";
import { audit } from "../../core/audit.js";
import { hashPassword, passwordProblems } from "../../core/security.js";
import { assertWithinLimit } from "../../core/limits.js";

const T = { tags: ["Users & Roles"] };
const zAssign = z.array(z.object({ roleId: zUuid, branchId: zUuid.nullable().optional() })).max(30);

export async function iamRoutes(app: FastifyInstance) {
  app.get("/permissions", { schema: { ...T, summary: "Permission catalog" }, preHandler: can("core.roles.view") }, async (req) =>
    tdb(req, async (db) => (await db.query("SELECT * FROM permissions ORDER BY module_code, code")).rows));

  app.get("/roles", { schema: { ...T, summary: "Roles with permissions" }, preHandler: can("core.roles.view") }, async (req) =>
    tdb(req, async (db) => (await db.query(
      `SELECT r.*, ARRAY(SELECT permission_code FROM role_permissions rp WHERE rp.role_id = r.id ORDER BY 1) AS permissions,
              (SELECT count(*) FROM user_roles ur WHERE ur.role_id = r.id) AS user_count
         FROM roles r ORDER BY is_system DESC, code`)).rows));

  app.post("/roles", { schema: { ...T, summary: "Create custom role" }, preHandler: can("core.roles.manage") }, async (req, reply) => {
    const b = parse(z.object({ code: z.string().regex(/^[a-z0-9_]+$/), nameAr: z.string().min(2), nameEn: z.string().min(2), permissions: z.array(z.string()).default([]) }), req.body);
    const u = req.user!;
    const role = await tdb(req, async (db) => {
      const r = (await db.query("INSERT INTO roles (tenant_id, code, name_ar, name_en) VALUES ($1,$2,$3,$4) RETURNING *", [u.tenantId, b.code, b.nameAr, b.nameEn])).rows[0];
      if (b.permissions.length) await db.query("INSERT INTO role_permissions (tenant_id, role_id, permission_code) SELECT $1,$2,unnest($3::text[])", [u.tenantId, r.id, b.permissions]);
      await audit(db, { tenantId: u.tenantId, actorType: "user", actorId: u.userId, action: "role.created", entityType: "role", entityId: r.id, after: b, ip: req.ip, requestId: req.id });
      return r;
    });
    return reply.code(201).send(role);
  });

  app.put("/roles/:id/permissions", { schema: { ...T, summary: "Replace a role's permissions" }, preHandler: can("core.roles.manage") }, async (req) => {
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const b = parse(z.object({ permissions: z.array(z.string()).max(500) }), req.body);
    const u = req.user!;
    return tdb(req, async (db) => {
      const r = (await db.query("SELECT * FROM roles WHERE id = $1", [id])).rows[0];
      if (!r) throw E.notFound("role");
      if (r.code === "tenant_owner") throw E.rule("SYSTEM_ROLE_LOCKED", "لا يمكن تعديل صلاحيات دور المالك", "The tenant owner role cannot be edited");
      // privilege escalation guard: you cannot grant what you do not hold yourself
      const missing = b.permissions.filter((p) => !u.permissions.has(p));
      if (missing.length && !u.isOwner) throw E.forbidden(missing[0]);
      const before = (await db.query("SELECT array_agg(permission_code ORDER BY 1) AS p FROM role_permissions WHERE role_id = $1", [id])).rows[0].p;
      await db.query("DELETE FROM role_permissions WHERE role_id = $1", [id]);
      if (b.permissions.length) await db.query("INSERT INTO role_permissions (tenant_id, role_id, permission_code) SELECT $1,$2,unnest($3::text[])", [u.tenantId, id, b.permissions]);
      await audit(db, { tenantId: u.tenantId, actorType: "user", actorId: u.userId, action: "role.permissions_replaced", entityType: "role", entityId: id, before, after: b.permissions, ip: req.ip, requestId: req.id });
      return { ok: true };
    });
  });

  app.get("/users", { schema: { ...T, summary: "List users" }, preHandler: can("core.users.view") }, async (req) => {
    const q = parse(zPage.extend({ q: z.string().optional(), active: z.enum(["true", "false"]).optional() }), req.query);
    const { limit, offset } = pageSql(q);
    return tdb(req, async (db) => {
      const where = `WHERE ($1::text IS NULL OR u.email ILIKE '%'||$1||'%' OR u.full_name ILIKE '%'||$1||'%') AND ($2::boolean IS NULL OR u.is_active = $2)`;
      const args = [q.q ?? null, q.active === undefined ? null : q.active === "true"];
      const total = Number((await db.query(`SELECT count(*) FROM users u ${where}`, args)).rows[0].count);
      const rows = (await db.query(
        `SELECT u.id, u.email, u.full_name, u.phone, u.locale, u.is_active, u.is_owner, u.mfa_enabled, u.last_login_at, u.locked_until, u.created_at,
                coalesce(json_agg(json_build_object('roleId', r.id, 'code', r.code, 'nameAr', r.name_ar, 'nameEn', r.name_en, 'branchId', ur.branch_id)) FILTER (WHERE r.id IS NOT NULL), '[]') AS roles
           FROM users u LEFT JOIN user_roles ur ON ur.user_id = u.id LEFT JOIN roles r ON r.id = ur.role_id
          ${where} GROUP BY u.id ORDER BY u.created_at LIMIT $3 OFFSET $4`, [...args, limit, offset])).rows;
      return paged(rows, total, q);
    });
  });

  app.post("/users", { schema: { ...T, summary: "Create user (plan user limit enforced)" }, preHandler: can("core.users.manage") }, async (req, reply) => {
    const b = parse(z.object({ email: z.string().email(), fullName: z.string().min(2), phone: z.string().optional(), password: z.string(), locale: z.enum(["ar", "en"]).default("ar"), roles: zAssign.default([]) }), req.body);
    const u = req.user!;
    const created = await tdb(req, async (db) => {
      await assertWithinLimit(db, u.tenantId, "users");
      const s = (await db.query("SELECT password_min_length FROM tenant_settings")).rows[0];
      const probs = passwordProblems(b.password, s.password_min_length);
      if (probs.length) throw E.validation([{ path: "password", message: probs.join(",") }]);
      const r = (await db.query("INSERT INTO users (tenant_id, email, full_name, phone, password_hash, locale) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, email, full_name",
        [u.tenantId, b.email.toLowerCase(), b.fullName, b.phone ?? null, await hashPassword(b.password), b.locale])).rows[0];
      await assignRoles(db, u, r.id, b.roles);
      await audit(db, { tenantId: u.tenantId, actorType: "user", actorId: u.userId, action: "user.created", entityType: "user", entityId: r.id, after: { ...b, password: undefined }, ip: req.ip, requestId: req.id });
      return r;
    });
    return reply.code(201).send(created);
  });

  app.patch("/users/:id", { schema: { ...T, summary: "Update user / activate / deactivate / unlock" }, preHandler: can("core.users.manage") }, async (req) => {
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const b = parse(z.object({ fullName: z.string().min(2).optional(), phone: z.string().nullable().optional(), isActive: z.boolean().optional(), unlock: z.boolean().optional(), locale: z.enum(["ar", "en"]).optional() }), req.body);
    const u = req.user!;
    return tdb(req, async (db) => {
      const before = (await db.query("SELECT * FROM users WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!before) throw E.notFound("user");
      if (before.is_owner && b.isActive === false) throw E.rule("OWNER_CANNOT_BE_DISABLED", "لا يمكن تعطيل مالك الحساب", "The tenant owner cannot be deactivated");
      if (id === u.userId && b.isActive === false) throw E.rule("CANNOT_DISABLE_SELF", "لا يمكنك تعطيل حسابك", "You cannot deactivate yourself");
      if (b.isActive === true && !before.is_active) await assertWithinLimit(db, u.tenantId, "users");
      const r = (await db.query(
        `UPDATE users SET full_name = coalesce($2, full_name), phone = CASE WHEN $3::boolean THEN $4 ELSE phone END, is_active = coalesce($5, is_active),
            locale = coalesce($6, locale), failed_logins = CASE WHEN $7 THEN 0 ELSE failed_logins END, locked_until = CASE WHEN $7 THEN NULL ELSE locked_until END
          WHERE id = $1 RETURNING id, email, full_name, phone, is_active, locale, locked_until`,
        [id, b.fullName ?? null, b.phone !== undefined, b.phone ?? null, b.isActive ?? null, b.locale ?? null, !!b.unlock])).rows[0];
      if (b.isActive === false) await db.query("UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [id]);
      await audit(db, { tenantId: u.tenantId, actorType: "user", actorId: u.userId, action: "user.updated", entityType: "user", entityId: id, before, after: r, ip: req.ip, requestId: req.id });
      return r;
    });
  });

  app.put("/users/:id/roles", { schema: { ...T, summary: "Replace a user's role assignments (optionally branch-scoped)" }, preHandler: can("core.users.manage") }, async (req) => {
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const b = parse(z.object({ roles: zAssign }), req.body);
    const u = req.user!;
    return tdb(req, async (db) => {
      const target = (await db.query("SELECT is_owner FROM users WHERE id = $1", [id])).rows[0];
      if (!target) throw E.notFound("user");
      if (target.is_owner) throw E.rule("OWNER_ROLES_LOCKED", "أدوار مالك الحساب ثابتة", "Owner role assignments are fixed");
      const before = (await db.query("SELECT role_id, branch_id FROM user_roles WHERE user_id = $1", [id])).rows;
      await db.query("DELETE FROM user_roles WHERE user_id = $1", [id]);
      await assignRoles(db, u, id, b.roles);
      await db.query("UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [id]);
      await audit(db, { tenantId: u.tenantId, actorType: "user", actorId: u.userId, action: "user.roles_replaced", entityType: "user", entityId: id, before, after: b.roles, ip: req.ip, requestId: req.id });
      return { ok: true };
    });
  });

  app.post("/users/:id/reset-password", { schema: { ...T, summary: "Admin password reset (revokes sessions)" }, preHandler: can("core.users.manage") }, async (req) => {
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const b = parse(z.object({ newPassword: z.string() }), req.body);
    const u = req.user!;
    return tdb(req, async (db) => {
      const s = (await db.query("SELECT password_min_length FROM tenant_settings")).rows[0];
      const probs = passwordProblems(b.newPassword, s.password_min_length);
      if (probs.length) throw E.validation([{ path: "newPassword", message: probs.join(",") }]);
      const r = await db.query("UPDATE users SET password_hash = $2, password_changed_at = now(), failed_logins = 0, locked_until = NULL WHERE id = $1 AND NOT is_owner RETURNING id", [id, await hashPassword(b.newPassword)]);
      if (!r.rowCount) throw E.notFound("user");
      await db.query("UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [id]);
      await audit(db, { tenantId: u.tenantId, actorType: "user", actorId: u.userId, action: "user.password_reset", entityType: "user", entityId: id, ip: req.ip, requestId: req.id });
      return { ok: true };
    });
  });
}

async function assignRoles(db: import("../../db/pool.js").Db, actor: NonNullable<import("fastify").FastifyRequest["user"]>, userId: string, roles: z.infer<typeof zAssign>) {
  if (!roles.length) return;
  const found = (await db.query("SELECT id, code FROM roles WHERE id = ANY($1::uuid[])", [roles.map((r) => r.roleId)])).rows;
  if (found.length !== new Set(roles.map((r) => r.roleId)).size) throw E.validation([{ path: "roles", message: "unknown role" }]);
  if (found.some((r) => r.code === "tenant_owner") && !actor.isOwner) throw E.forbidden("assign tenant_owner");
  // escalation guard: a non-owner may only assign roles whose permissions they fully hold
  if (!actor.isOwner) {
    const perms = (await db.query("SELECT DISTINCT permission_code FROM role_permissions WHERE role_id = ANY($1::uuid[])", [found.map((r) => r.id)])).rows.map((r) => r.permission_code as string);
    const missing = perms.filter((p) => !actor.permissions.has(p));
    if (missing.length) throw E.forbidden(missing[0]);
  }
  for (const r of roles) await db.query("INSERT INTO user_roles (tenant_id, user_id, role_id, branch_id) VALUES ($1,$2,$3,$4)", [actor.tenantId, userId, r.roleId, r.branchId ?? null]);
}
