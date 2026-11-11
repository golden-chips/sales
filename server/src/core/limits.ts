import type { Db } from "../db/pool.js";
import { E } from "./errors.js";

type Kind = "users" | "companies" | "branches" | "warehouses";
const COL: Record<Kind, string> = { users: "max_users", companies: "max_companies", branches: "max_branches", warehouses: "max_warehouses" };
const COUNT: Record<Kind, string> = {
  users: "SELECT count(*) FROM users WHERE is_active",
  companies: "SELECT count(*) FROM companies",
  branches: "SELECT count(*) FROM branches",
  warehouses: "SELECT count(*) FROM warehouses",
};

/** Enforces plan limits. Serialized per tenant with an advisory lock so concurrent creates cannot overshoot. */
export async function assertWithinLimit(db: Db, tenantId: string, kind: Kind, adding = 1) {
  await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`limits:${tenantId}:${kind}`]);
  const plan = (await db.query(
    `SELECT p.${COL[kind]} AS lim FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.tenant_id = $1 AND s.status IN ('trialing','active','past_due')`, [tenantId])).rows[0];
  if (!plan) throw E.tenantSuspended("no_subscription");
  const used = Number((await db.query(COUNT[kind])).rows[0].count);
  if (used + adding > plan.lim) throw E.planLimit(kind, plan.lim);
}
