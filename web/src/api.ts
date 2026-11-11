// Thin API client. Access token in memory + sessionStorage (tab-scoped);
// refresh token rotates on every use. See docs/SECURITY.md (known issue:
// move refresh token to an httpOnly cookie before production).
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public messageAr: string, public details?: any) { super(message); }
}

type Scope = "tenant" | "platform";
/** "" on the web (same origin); the server's address inside the Android app (VITE_API_BASE at build time) */
export const API_BASE = ((import.meta as any).env?.VITE_API_BASE ?? "").replace(/\/$/, "");
const KEY = { tenant: "ge.session", platform: "ge.platform" };

export interface Session { accessToken: string; refreshToken?: string }
export function getSession(scope: Scope): Session | null {
  try { const v = sessionStorage.getItem(KEY[scope]); return v ? JSON.parse(v) : null; } catch { return null; }
}
export function setSession(scope: Scope, s: Session | null) {
  try { s ? sessionStorage.setItem(KEY[scope], JSON.stringify(s)) : sessionStorage.removeItem(KEY[scope]); } catch { /* storage blocked: session lives in memory only */ }
}

let refreshing: Promise<boolean> | null = null;
async function refresh(): Promise<boolean> {
  const s = getSession("tenant");
  if (!s?.refreshToken) return false;
  refreshing ??= fetch(`${API_BASE}/api/v1/auth/refresh`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refreshToken: s.refreshToken }) })
    .then(async (r) => { if (!r.ok) { setSession("tenant", null); return false; } const j = await r.json(); setSession("tenant", { accessToken: j.accessToken, refreshToken: j.refreshToken }); return true; })
    .finally(() => { refreshing = null; });
  return refreshing;
}

export async function request<T = any>(method: string, path: string, body?: unknown, opts: { scope?: Scope; idempotencyKey?: string } = {}): Promise<T> {
  const scope = opts.scope ?? "tenant";
  const go = () => {
    const s = getSession(scope);
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (s) headers.authorization = `Bearer ${s.accessToken}`;
    if (opts.idempotencyKey) headers["idempotency-key"] = opts.idempotencyKey;
    return fetch(`${API_BASE}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  };
  let res = await go();
  if (res.status === 401 && scope === "tenant" && getSession("tenant")?.refreshToken && !path.startsWith("/auth/")) {
    if (await refresh()) res = await go();
  }
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const e = json?.error ?? {};
    if (res.status === 401) window.dispatchEvent(new CustomEvent("ge:unauthorized", { detail: scope }));
    throw new ApiError(res.status, e.code ?? "HTTP_" + res.status, e.message ?? res.statusText, e.message_ar ?? e.message ?? res.statusText, e.details);
  }
  return json as T;
}

export const api = {
  get: <T = any>(p: string, scope?: Scope) => request<T>("GET", p, undefined, { scope }),
  post: <T = any>(p: string, b?: unknown, o?: { scope?: Scope; idempotencyKey?: string }) => request<T>("POST", p, b ?? {}, o),
  put: <T = any>(p: string, b: unknown) => request<T>("PUT", p, b),
  patch: <T = any>(p: string, b: unknown) => request<T>("PATCH", p, b),
  del: <T = any>(p: string) => request<T>("DELETE", p),
};

export const fmt = (v: string | number | null | undefined, digits = 3, locale = "en-US") =>
  v === null || v === undefined || v === "" ? "—" : Number(v).toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });
export const fmtDate = (v?: string | null) => (v ? String(v).slice(0, 10) : "—");
export const fmtDateTime = (v?: string | null) => (v ? new Date(v).toLocaleString("en-GB", { hour12: false }) : "—");
