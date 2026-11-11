import type { FastifyReply, FastifyRequest } from "fastify";
import { E } from "./errors.js";
import { verifyAccess, verifyPlatform } from "./security.js";
import { withPlatform, withTenant, type Db } from "../db/pool.js";

export interface UserCtx {
  userId: string;
  tenantId: string;
  isOwner: boolean;
  permissions: Set<string>;
  /** null = all branches */
  branchIds: string[] | null;
  modules: Set<string>;
  enforceSod: boolean;
  tenantStatus: string;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: UserCtx;
    platformUserId?: string;
  }
}

const LIVE_TENANT = new Set(["trial", "active", "past_due"]);

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  return h && h.startsWith("Bearer ") ? h.slice(7) : null;
}

/** Loads the user's effective permissions fresh on every request so revocation is immediate. */
export async function loadUserCtx(db: Db, userId: string, tenantId: string): Promise<UserCtx | null> {
  const { rows } = await db.query(
    `SELECT u.is_active, u.is_owner, t.status AS tenant_status, coalesce(ts.enforce_sod, true) AS enforce_sod,
       ARRAY(SELECT DISTINCT rp.permission_code FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id WHERE ur.user_id = u.id) AS perms,
       ARRAY(SELECT DISTINCT ur.branch_id FROM user_roles ur WHERE ur.user_id = u.id AND ur.branch_id IS NOT NULL) AS branches,
       EXISTS(SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id AND ur.branch_id IS NULL) AS all_branches,
       ARRAY(SELECT pm.module_code FROM subscriptions s JOIN plan_modules pm ON pm.plan_id = s.plan_id
             WHERE s.tenant_id = u.tenant_id AND s.status IN ('trialing','active','past_due')) AS modules
     FROM users u JOIN tenants t ON t.id = u.tenant_id LEFT JOIN tenant_settings ts ON ts.tenant_id = u.tenant_id
     WHERE u.id = $1`,
    [userId],
  );
  const r = rows[0];
  if (!r || !r.is_active) return null;
  return {
    userId, tenantId, isOwner: r.is_owner, tenantStatus: r.tenant_status, enforceSod: r.enforce_sod,
    permissions: new Set(r.perms), branchIds: r.is_owner || r.all_branches ? null : r.branches,
    modules: new Set(["core", ...r.modules]),
  };
}

export async function authenticateUser(req: FastifyRequest) {
  const token = bearer(req);
  const claims = token ? verifyAccess(token) : null;
  if (!claims) throw E.unauthenticated();
  const ctx = await withTenant(claims.tid, claims.sub, (db) => loadUserCtx(db, claims.sub, claims.tid));
  if (!ctx) throw E.unauthenticated();
  if (!LIVE_TENANT.has(ctx.tenantStatus)) throw E.tenantSuspended(ctx.tenantStatus);
  req.user = ctx;
}

export async function authenticatePlatform(req: FastifyRequest) {
  const token = bearer(req);
  const claims = token ? verifyPlatform(token) : null;
  if (!claims) throw E.unauthenticated();
  const ok = await withPlatform(async (db) => (await db.query("SELECT is_active FROM platform_users WHERE id = $1", [claims.sub])).rows[0]?.is_active);
  if (!ok) throw E.unauthenticated();
  req.platformUserId = claims.sub;
}

/** preHandler factory: authentication + module-in-plan + permission check (server side, always). */
export function can(permission: string | null, module?: string) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    if (!req.user) await authenticateUser(req);
    const u = req.user!;
    const mod = module ?? permission?.split(".")[0];
    if (mod && !u.modules.has(mod)) throw E.moduleNotInPlan(mod);
    if (permission && !u.permissions.has(permission)) throw E.forbidden(permission);
  };
}

export function assertBranchAccess(u: UserCtx, branchId: string | null | undefined) {
  if (!branchId || u.branchIds === null) return;
  if (!u.branchIds.includes(branchId)) throw E.forbidden("branch_scope");
}

export const tdb = <T>(req: FastifyRequest, fn: (db: Db) => Promise<T>) => withTenant(req.user!.tenantId, req.user!.userId, fn);
