import pg from "pg";
import { config } from "../config.js";

// numeric -> string (never lose precision in JS floats); int8 -> string as well
pg.types.setTypeParser(1700, (v) => v);
pg.types.setTypeParser(1082, (v) => v); // date stays 'YYYY-MM-DD'

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 20, idleTimeoutMillis: 30_000 });

export type Db = pg.PoolClient;

export interface TxContext {
  tenantId?: string | null;
  userId?: string | null;
  platform?: boolean;
}

/**
 * Runs fn inside a transaction with the request context bound via
 * transaction-local settings. RLS policies read these settings, so every
 * query inside fn is automatically scoped to the tenant.
 */
export async function tx<T>(ctx: TxContext, fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true), set_config('app.is_platform', $3, true)",
      [ctx.tenantId ?? "", ctx.userId ?? "", ctx.platform ? "on" : ""],
    );
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined); // connection may already be broken; original error is rethrown
    throw e;
  } finally {
    client.release();
  }
}

export const withTenant = <T>(tenantId: string, userId: string | null, fn: (db: Db) => Promise<T>) =>
  tx({ tenantId, userId }, fn);
export const withPlatform = <T>(fn: (db: Db) => Promise<T>) => tx({ platform: true }, fn);
/** platform operation that also writes tenant-owned rows (tenant provisioning) */
export const withPlatformInTenant = <T>(tenantId: string, fn: (db: Db) => Promise<T>) =>
  tx({ platform: true, tenantId }, fn);
/** no context at all — only SECURITY DEFINER lookups work */
export const withAnonymous = <T>(fn: (db: Db) => Promise<T>) => tx({}, fn);
