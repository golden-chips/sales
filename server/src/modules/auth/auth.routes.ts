import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { withAnonymous, withTenant, type Db } from "../../db/pool.js";
import { parse } from "../../core/http.js";
import { E } from "../../core/errors.js";
import { audit } from "../../core/audit.js";
import { authenticateUser } from "../../core/auth.js";
import { config } from "../../config.js";
import {
  DUMMY_HASH, hashPassword, newOpaqueToken, newTotpSecret, passwordProblems, sha256, signAccess, totpUri, verifyPassword, verifyTotp,
} from "../../core/security.js";

const T = { tags: ["Auth"] };
const LOCK_MINUTES = 15;

async function issueTokens(db: Db, req: FastifyRequest, tenantId: string, userId: string, familyId = randomUUID()) {
  const refresh = newOpaqueToken();
  const row = (await db.query(
    `INSERT INTO refresh_tokens (tenant_id, user_id, token_hash, family_id, expires_at, ip, user_agent)
     VALUES ($1,$2,$3,$4, now() + make_interval(secs => $5), $6, $7) RETURNING id`,
    [tenantId, userId, sha256(refresh), familyId, config.refreshTokenTtlSec, req.ip, req.headers["user-agent"] ?? null],
  )).rows[0];
  return { accessToken: signAccess(userId, tenantId), refreshToken: `${tenantId}.${refresh}`, expiresIn: config.accessTokenTtlSec, refreshId: row.id as string };
}

export async function authRoutes(app: FastifyInstance) {
  app.post("/login", {
    schema: { ...T, security: [], summary: "Tenant user login (tenant code + email + password [+ TOTP])",
      body: { type: "object", required: ["tenant", "email", "password"], properties: { tenant: { type: "string" }, email: { type: "string" }, password: { type: "string" }, otp: { type: "string" } } } },
    config: { rateLimit: { max: config.loginRateLimitPerMin, timeWindow: "1 minute" } },
  }, async (req) => {
    const b = parse(z.object({ tenant: z.string().min(3).max(40), email: z.string().email(), password: z.string().min(1).max(200), otp: z.string().optional() }), req.body);
    const tenant = await withAnonymous(async (db) => (await db.query("SELECT * FROM resolve_tenant($1)", [b.tenant])).rows[0]);
    if (!tenant) {
      await verifyPassword(b.password, DUMMY_HASH);
      await withAnonymous((db) => db.query("INSERT INTO login_attempts (scope, identifier, success, reason, ip) VALUES ('tenant',$1,false,'unknown_tenant',$2)", [`${b.tenant}:${b.email}`, req.ip]));
      throw E.invalidCredentials();
    }
    if (!["trial", "active", "past_due"].includes(tenant.status)) throw E.tenantSuspended(tenant.status);

    // Outcome is decided inside the transaction; errors are thrown after commit so the attempt/lockout is persisted.
    const outcome = await withTenant(tenant.id, null, async (db) => {
      const u = (await db.query("SELECT u.*, s.max_failed_logins, s.mfa_required FROM users u JOIN tenant_settings s ON s.tenant_id = u.tenant_id WHERE u.email = $1 FOR UPDATE OF u", [b.email])).rows[0];
      const log = (success: boolean, reason: string | null) => db.query(
        "INSERT INTO login_attempts (tenant_id, scope, identifier, success, reason, ip, user_agent) VALUES ($1,'tenant',$2,$3,$4,$5,$6)",
        [tenant.id, b.email, success, reason, req.ip, req.headers["user-agent"] ?? null]);
      if (u?.locked_until && new Date(u.locked_until) > new Date()) { await log(false, "locked"); return { err: E.locked(u.locked_until) }; }
      const ok = await verifyPassword(b.password, u?.password_hash ?? DUMMY_HASH);
      if (!u || !ok || !u.is_active) {
        if (u) {
          const fails = u.failed_logins + 1;
          await db.query("UPDATE users SET failed_logins = $2::int, locked_until = CASE WHEN $2::int >= $3::int THEN now() + make_interval(mins => $4) ELSE locked_until END WHERE id = $1",
            [u.id, fails, u.max_failed_logins, LOCK_MINUTES]);
          if (fails >= u.max_failed_logins) await audit(db, { tenantId: tenant.id, actorType: "system", actorId: null, action: "user.locked", entityType: "user", entityId: u.id, ip: req.ip, requestId: req.id });
        }
        await log(false, !u ? "unknown_user" : !u.is_active ? "inactive" : "bad_password");
        return { err: E.invalidCredentials() };
      }
      if (u.mfa_enabled && !(b.otp && verifyTotp(u.mfa_secret, b.otp))) { await log(false, b.otp ? "bad_otp" : "mfa_required"); return { err: E.mfaRequired() }; }
      await db.query("UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1", [u.id]);
      await log(true, null);
      await audit(db, { tenantId: tenant.id, actorType: "user", actorId: u.id, action: "user.login", entityType: "user", entityId: u.id, ip: req.ip, requestId: req.id });
      const tokens = await issueTokens(db, req, tenant.id, u.id);
      return { ok: { ...tokens, refreshId: undefined, mfaSetupRequired: u.mfa_required && !u.mfa_enabled, user: { id: u.id, fullName: u.full_name, email: u.email, locale: u.locale } } };
    });
    if ("err" in outcome) throw outcome.err;
    return outcome.ok;
  });

  app.post("/refresh", { schema: { ...T, security: [], summary: "Rotate refresh token (reuse of a rotated token revokes the whole session family)" } }, async (req) => {
    const b = parse(z.object({ refreshToken: z.string().regex(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{20,}$/) }), req.body);
    const [tenantId, raw] = b.refreshToken.split(".");
    const out = await withTenant(tenantId, null, async (db) => {
      const t = (await db.query("SELECT rt.*, u.is_active FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id WHERE token_hash = $1 FOR UPDATE OF rt", [sha256(raw)])).rows[0];
      if (!t) return { err: E.unauthenticated() };
      if (t.revoked_at) {
        await db.query("UPDATE refresh_tokens SET revoked_at = coalesce(revoked_at, now()) WHERE family_id = $1", [t.family_id]);
        await audit(db, { tenantId, actorType: "system", actorId: null, action: "auth.refresh_reuse_detected", entityType: "user", entityId: t.user_id, ip: req.ip, requestId: req.id });
        return { err: E.unauthenticated() };
      }
      if (new Date(t.expires_at) <= new Date() || !t.is_active) return { err: E.unauthenticated() };
      const st = (await db.query("SELECT status FROM tenants WHERE id = $1", [tenantId])).rows[0];
      if (!st || !["trial", "active", "past_due"].includes(st.status)) return { err: E.tenantSuspended(st?.status ?? "unknown") };
      const tokens = await issueTokens(db, req, tenantId, t.user_id, t.family_id);
      await db.query("UPDATE refresh_tokens SET revoked_at = now(), replaced_by = $2 WHERE id = $1", [t.id, tokens.refreshId]);
      return { ok: { ...tokens, refreshId: undefined } };
    }).catch((e) => { if (e?.code === "22P02") return { err: E.unauthenticated() }; throw e; });
    if ("err" in out) throw out.err;
    return out.ok;
  });

  await app.register(async (p) => {
    p.addHook("preHandler", authenticateUser);

    p.post("/logout", { schema: { ...T, summary: "Revoke all sessions of the current user" } }, async (req) => {
      await withTenant(req.user!.tenantId, req.user!.userId, (db) => db.query("UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [req.user!.userId]));
      return { ok: true };
    });

    p.get("/me", { schema: { ...T, summary: "Current user, tenant, permissions, plan modules" } }, async (req) => {
      const u = req.user!;
      return withTenant(u.tenantId, u.userId, async (db) => {
        const me = (await db.query("SELECT id, email, full_name, locale, is_owner, mfa_enabled, last_login_at FROM users WHERE id = $1", [u.userId])).rows[0];
        const tenant = (await db.query("SELECT id, code, legal_name, name_en, status, base_currency, timezone, default_locale, secondary_locale, brand_color, logo_url, is_demo FROM tenants WHERE id = $1", [u.tenantId])).rows[0];
        const companies = (await db.query("SELECT id, code, name_ar, name_en, base_currency FROM companies WHERE is_active ORDER BY code")).rows;
        const roles = (await db.query("SELECT r.code, r.name_ar, r.name_en, ur.branch_id FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1", [u.userId])).rows;
        return { user: me, tenant, companies, roles, permissions: [...u.permissions].sort(), modules: [...u.modules].sort(), branchScope: u.branchIds };
      });
    });

    p.post("/change-password", { schema: { ...T, summary: "Change own password" } }, async (req) => {
      const b = parse(z.object({ currentPassword: z.string(), newPassword: z.string() }), req.body);
      const u = req.user!;
      await withTenant(u.tenantId, u.userId, async (db) => {
        const row = (await db.query("SELECT u.password_hash, s.password_min_length FROM users u JOIN tenant_settings s ON s.tenant_id = u.tenant_id WHERE u.id = $1", [u.userId])).rows[0];
        if (!(await verifyPassword(b.currentPassword, row.password_hash))) throw E.invalidCredentials();
        const probs = passwordProblems(b.newPassword, row.password_min_length);
        if (probs.length) throw E.validation([{ path: "newPassword", message: probs.join(",") }]);
        await db.query("UPDATE users SET password_hash = $2, password_changed_at = now() WHERE id = $1", [u.userId, await hashPassword(b.newPassword)]);
        await db.query("UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [u.userId]);
        await audit(db, { tenantId: u.tenantId, actorType: "user", actorId: u.userId, action: "user.password_changed", entityType: "user", entityId: u.userId, ip: req.ip, requestId: req.id });
      });
      return { ok: true };
    });

    p.post("/mfa/setup", { schema: { ...T, summary: "Start TOTP enrolment (returns otpauth URI)" } }, async (req) => {
      const u = req.user!;
      const secret = newTotpSecret();
      const email = await withTenant(u.tenantId, u.userId, async (db) => {
        const r = (await db.query("UPDATE users SET mfa_secret = $2 WHERE id = $1 AND NOT mfa_enabled RETURNING email", [u.userId, secret])).rows[0];
        if (!r) throw E.conflict("التحقق الثنائي مفعّل مسبقًا", "MFA already enabled");
        return r.email;
      });
      return { otpauthUri: totpUri(secret, email), secret };
    });

    p.post("/mfa/enable", { schema: { ...T, summary: "Confirm TOTP enrolment with a current code" } }, async (req) => {
      const b = parse(z.object({ otp: z.string() }), req.body);
      const u = req.user!;
      await withTenant(u.tenantId, u.userId, async (db) => {
        const r = (await db.query("SELECT mfa_secret FROM users WHERE id = $1", [u.userId])).rows[0];
        if (!r?.mfa_secret || !verifyTotp(r.mfa_secret, b.otp)) throw E.rule("MFA_INVALID", "رمز التحقق غير صحيح", "Invalid verification code");
        await db.query("UPDATE users SET mfa_enabled = true WHERE id = $1", [u.userId]);
        await audit(db, { tenantId: u.tenantId, actorType: "user", actorId: u.userId, action: "user.mfa_enabled", entityType: "user", entityId: u.userId, ip: req.ip, requestId: req.id });
      });
      return { ok: true };
    });
  });
}
