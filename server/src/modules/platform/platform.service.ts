import { randomUUID } from "node:crypto";
import type { Db } from "../../db/pool.js";
import { E } from "../../core/errors.js";
import { audit } from "../../core/audit.js";
import { hashPassword, passwordProblems } from "../../core/security.js";
import { syncSystemRoles, roleIdByCode } from "../iam/roles.service.js";

export interface ProvisionInput {
  code: string; legalName: string; nameEn?: string; industry?: string;
  baseCurrency: string; timezone: string; defaultLocale: "ar" | "en"; secondaryLocale?: "ar" | "en";
  planCode: string; billingCycle: "monthly" | "yearly"; isDemo?: boolean;
  company: { code: string; nameAr: string; nameEn?: string };
  owner: { email: string; fullName: string; password: string };
}

const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400_000);
const addCycle = (d: Date, c: "monthly" | "yearly") => { const x = new Date(d); if (c === "monthly") x.setUTCMonth(x.getUTCMonth() + 1); else x.setUTCFullYear(x.getUTCFullYear() + 1); return x; };

export async function planByCode(db: Db, code: string) {
  const p = (await db.query("SELECT * FROM plans WHERE code = $1 AND is_active", [code])).rows[0];
  if (!p) throw E.notFound("plan");
  return p;
}

/** Runs inside withPlatformInTenant(tenantId) so both platform and tenant-owned rows can be written. */
export async function provisionTenant(db: Db, tenantId: string, input: ProvisionInput, actorId: string | null, now = new Date()) {
  const pw = passwordProblems(input.owner.password, 10);
  if (pw.length) throw E.validation([{ path: "owner.password", message: pw.join(",") }]);
  const plan = await planByCode(db, input.planCode);

  await db.query(
    `INSERT INTO tenants (id, code, legal_name, name_en, industry, status, base_currency, timezone, default_locale, secondary_locale, is_demo)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [tenantId, input.code, input.legalName, input.nameEn ?? null, input.industry ?? null, plan.trial_days > 0 ? "trial" : "active",
     input.baseCurrency, input.timezone, input.defaultLocale, input.secondaryLocale ?? null, !!input.isDemo],
  );
  await db.query("INSERT INTO tenant_settings (tenant_id) VALUES ($1)", [tenantId]);
  const company = (await db.query(
    "INSERT INTO companies (tenant_id, code, name_ar, name_en, base_currency) VALUES ($1,$2,$3,$4,$5) RETURNING id",
    [tenantId, input.company.code, input.company.nameAr, input.company.nameEn ?? null, input.baseCurrency],
  )).rows[0];
  const branch = (await db.query(
    "INSERT INTO branches (tenant_id, company_id, code, name_ar, name_en, kind) VALUES ($1,$2,'HQ','الإدارة العامة','Head Office','head_office') RETURNING id",
    [tenantId, company.id],
  )).rows[0];
  await syncSystemRoles(db, tenantId);
  const owner = (await db.query(
    "INSERT INTO users (tenant_id, email, full_name, password_hash, locale, is_owner) VALUES ($1,$2,$3,$4,$5,true) RETURNING id",
    [tenantId, input.owner.email.toLowerCase(), input.owner.fullName, await hashPassword(input.owner.password), input.defaultLocale],
  )).rows[0];
  await db.query("INSERT INTO user_roles (tenant_id, user_id, role_id) VALUES ($1,$2,$3)", [tenantId, owner.id, await roleIdByCode(db, "tenant_owner")]);

  const trial = plan.trial_days > 0;
  const periodEnd = trial ? addDays(now, plan.trial_days) : addCycle(now, input.billingCycle);
  const sub = (await db.query(
    `INSERT INTO subscriptions (tenant_id, plan_id, billing_cycle, status, price, currency, trial_ends_at, current_period_start, current_period_end)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [tenantId, plan.id, input.billingCycle, trial ? "trialing" : "active",
     input.billingCycle === "monthly" ? plan.price_monthly : plan.price_yearly, plan.currency, trial ? periodEnd : null, now, periodEnd],
  )).rows[0];
  await db.query("INSERT INTO subscription_events (tenant_id, subscription_id, event_type, to_plan_id, actor_platform_user_id) VALUES ($1,$2,'created',$3,$4)",
    [tenantId, sub.id, plan.id, actorId]);
  if (!trial) await issueInvoice(db, sub.id, now);

  await audit(db, { tenantId: null, actorType: actorId ? "platform" : "system", actorId, action: "tenant.provisioned", entityType: "tenant", entityId: tenantId, after: { code: input.code, plan: plan.code } });
  await audit(db, { tenantId, actorType: actorId ? "platform" : "system", actorId, action: "tenant.provisioned", entityType: "tenant", entityId: tenantId, after: { code: input.code, plan: plan.code, ownerEmail: input.owner.email } });
  return { tenantId, companyId: company.id, branchId: branch.id, ownerUserId: owner.id, subscriptionId: sub.id };
}

export async function issueInvoice(db: Db, subscriptionId: string, now = new Date(), couponCode?: string) {
  const s = (await db.query("SELECT * FROM subscriptions WHERE id = $1", [subscriptionId])).rows[0];
  let discount = "0"; let couponId: string | null = null;
  if (couponCode) {
    const c = (await db.query(
      `UPDATE coupons SET redemptions = redemptions + 1
        WHERE code = $1 AND is_active AND (valid_until IS NULL OR valid_until > $2) AND (max_redemptions IS NULL OR redemptions < max_redemptions)
        RETURNING id, percent_off`, [couponCode, now])).rows[0];
    if (!c) throw E.rule("COUPON_INVALID", "الكوبون غير صالح أو منتهي", "Coupon invalid or exhausted");
    couponId = c.id;
    discount = (await db.query("SELECT round($1::numeric * $2::numeric / 100, 3) AS d", [s.price, c.percent_off])).rows[0].d;
  }
  const seq = (await db.query("SELECT nextval('platform_invoice_seq') AS n")).rows[0].n;
  const number = `PINV-${now.getUTCFullYear()}-${String(seq).padStart(6, "0")}`;
  return (await db.query(
    `INSERT INTO platform_invoices (number, tenant_id, subscription_id, period_start, period_end, amount, discount, currency, due_at, coupon_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [number, s.tenant_id, s.id, s.current_period_start, s.current_period_end, s.price, discount, s.currency, addDays(now, 7), couponId],
  )).rows[0];
}

async function usage(db: Db, tenantId: string) {
  return (await db.query("SELECT * FROM platform_tenant_usage($1)", [tenantId])).rows[0];
}

export async function setTenantStatus(db: Db, tenantId: string, status: "active" | "suspended" | "cancelled", reason: string, actorId: string, now = new Date()) {
  const t = (await db.query("SELECT * FROM tenants WHERE id = $1 FOR UPDATE", [tenantId])).rows[0];
  if (!t) throw E.notFound("tenant");
  const live = (await db.query("SELECT * FROM subscriptions WHERE tenant_id = $1 AND status IN ('trialing','active','past_due','suspended') FOR UPDATE", [tenantId])).rows[0];
  if (status === "active") {
    if (!live) throw E.rule("NO_SUBSCRIPTION", "لا يوجد اشتراك لإعادة تفعيله", "No subscription to reactivate");
    const end = live.current_period_end > now ? live.current_period_end : addCycle(now, live.billing_cycle);
    await db.query("UPDATE subscriptions SET status = 'active', current_period_start = CASE WHEN current_period_end > $2 THEN current_period_start ELSE $2 END, current_period_end = $3 WHERE id = $1", [live.id, now, end]);
  } else if (live) {
    await db.query("UPDATE subscriptions SET status = $2 WHERE id = $1", [live.id, status === "cancelled" ? "cancelled" : "suspended"]);
  }
  await db.query("UPDATE tenants SET status = $2, status_reason = $3 WHERE id = $1", [tenantId, status, reason]);
  if (live) await db.query("INSERT INTO subscription_events (tenant_id, subscription_id, event_type, note, actor_platform_user_id) VALUES ($1,$2,$3,$4,$5)", [tenantId, live.id, status, reason, actorId]);
  if (status !== "active") await db.query("SELECT platform_revoke_tenant_sessions($1)", [tenantId]);
  await audit(db, { tenantId: null, actorType: "platform", actorId, action: `tenant.${status}`, entityType: "tenant", entityId: tenantId, before: { status: t.status }, after: { status, reason } });
}

export async function changePlan(db: Db, tenantId: string, planCode: string, billingCycle: "monthly" | "yearly", actorId: string, now = new Date()) {
  const plan = await planByCode(db, planCode);
  const live = (await db.query("SELECT * FROM subscriptions WHERE tenant_id = $1 AND status IN ('trialing','active','past_due') FOR UPDATE", [tenantId])).rows[0];
  if (!live) throw E.rule("NO_ACTIVE_SUBSCRIPTION", "لا يوجد اشتراك فعّال", "No active subscription");
  const u = await usage(db, tenantId);
  const over: Record<string, { used: number; limit: number }> = {};
  if (Number(u.active_users) > plan.max_users) over.users = { used: Number(u.active_users), limit: plan.max_users };
  if (Number(u.companies) > plan.max_companies) over.companies = { used: Number(u.companies), limit: plan.max_companies };
  if (Number(u.branches) > plan.max_branches) over.branches = { used: Number(u.branches), limit: plan.max_branches };
  if (Number(u.warehouses) > plan.max_warehouses) over.warehouses = { used: Number(u.warehouses), limit: plan.max_warehouses };
  if (Object.keys(over).length)
    throw E.rule("DOWNGRADE_EXCEEDS_LIMITS", "الاستخدام الحالي يتجاوز حدود الباقة الجديدة", "Current usage exceeds the target plan limits", over);
  await db.query("UPDATE subscriptions SET status = 'superseded' WHERE id = $1", [live.id]);
  const sub = (await db.query(
    `INSERT INTO subscriptions (tenant_id, plan_id, billing_cycle, status, price, currency, current_period_start, current_period_end)
     VALUES ($1,$2,$3,'active',$4,$5,$6,$7) RETURNING id`,
    [tenantId, plan.id, billingCycle, billingCycle === "monthly" ? plan.price_monthly : plan.price_yearly, plan.currency, now, addCycle(now, billingCycle)],
  )).rows[0];
  await db.query("UPDATE tenants SET status = 'active', status_reason = NULL WHERE id = $1", [tenantId]);
  await db.query("INSERT INTO subscription_events (tenant_id, subscription_id, event_type, from_plan_id, to_plan_id, actor_platform_user_id) VALUES ($1,$2,'plan_changed',$3,$4,$5)",
    [tenantId, sub.id, live.plan_id, plan.id, actorId]);
  const invoice = await issueInvoice(db, sub.id, now);
  await audit(db, { tenantId: null, actorType: "platform", actorId, action: "tenant.plan_changed", entityType: "tenant", entityId: tenantId, after: { plan: plan.code, billingCycle } });
  return { subscriptionId: sub.id, invoice };
}

/**
 * Lifecycle sweep (run by scheduler, e.g. hourly):
 *  - expired trial / non-renewing period → past_due (grace period starts)
 *  - auto-renew active period → renew + issue invoice
 *  - past_due beyond plan.grace_days → suspended (tenant blocked, sessions revoked)
 */
export async function sweepSubscriptions(db: Db, now = new Date()) {
  const due = (await db.query(
    `SELECT s.*, p.grace_days FROM subscriptions s JOIN plans p ON p.id = s.plan_id
      WHERE s.status IN ('trialing','active','past_due') AND s.current_period_end <= $1 FOR UPDATE OF s`, [now])).rows;
  const result = { renewed: 0, pastDue: 0, suspended: 0 };
  for (const s of due) {
    if (s.status === "active" && s.auto_renew) {
      await db.query("UPDATE subscriptions SET current_period_start = current_period_end, current_period_end = current_period_end + CASE WHEN billing_cycle = 'monthly' THEN interval '1 month' ELSE interval '1 year' END WHERE id = $1", [s.id]);
      await issueInvoice(db, s.id, now);
      await db.query("INSERT INTO subscription_events (tenant_id, subscription_id, event_type) VALUES ($1,$2,'renewed')", [s.tenant_id, s.id]);
      result.renewed++;
    } else if (s.status !== "past_due") {
      await db.query("UPDATE subscriptions SET status = 'past_due' WHERE id = $1", [s.id]);
      await db.query("UPDATE tenants SET status = 'past_due', status_reason = 'subscription period ended' WHERE id = $1", [s.tenant_id]);
      await db.query("INSERT INTO subscription_events (tenant_id, subscription_id, event_type) VALUES ($1,$2,'past_due')", [s.tenant_id, s.id]);
      result.pastDue++;
    } else if (addDays(new Date(s.current_period_end), s.grace_days) <= now) {
      await db.query("UPDATE subscriptions SET status = 'suspended' WHERE id = $1", [s.id]);
      await db.query("UPDATE tenants SET status = 'suspended', status_reason = 'grace period expired' WHERE id = $1", [s.tenant_id]);
      await db.query("SELECT platform_revoke_tenant_sessions($1)", [s.tenant_id]);
      await db.query("INSERT INTO subscription_events (tenant_id, subscription_id, event_type) VALUES ($1,$2,'suspended')", [s.tenant_id, s.id]);
      result.suspended++;
    }
  }
  if (result.renewed + result.pastDue + result.suspended)
    await audit(db, { tenantId: null, actorType: "system", actorId: null, action: "subscriptions.sweep", entityType: "subscription", after: result });
  return result;
}

export const newTenantId = () => randomUUID();
