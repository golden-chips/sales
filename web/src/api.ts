// Thin API client. The short-lived access token is kept in sessionStorage (tab-scoped).
// On the web the refresh token lives in an httpOnly cookie that scripts cannot read; it is used
// together with a CSRF token (readable cookie echoed in a header) and rotates on every use.
// Inside the Android app (another origin) the refresh token stays in the app's private storage.
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public messageAr: string, public details?: any) { super(message); }
}

type Scope = "tenant" | "platform";
/** "" on the web (same origin); the server's address inside the Android app (VITE_API_BASE at build time) */
export const API_BASE = ((import.meta as any).env?.VITE_API_BASE ?? "").replace(/\/$/, "");
const KEY = { tenant: "ge.session", platform: "ge.platform" };

/** refreshToken: native app only; cookie: the refresh token is in the httpOnly cookie (web) */
export interface Session { accessToken: string; refreshToken?: string; cookie?: boolean }
/** the web app is served from the API's origin → cookie sessions */
export const COOKIE_MODE = API_BASE === "" && !(globalThis as any).Capacitor?.isNativePlatform?.();
const readCookie = (name: string) => {
  for (const part of document.cookie.split(";")) { const [k, ...v] = part.trim().split("="); if (k === name) return decodeURIComponent(v.join("=")); }
  return null;
};
/** a browser session exists (another tab signed in): this tab can sign in silently */
export const hasCookieSession = () => COOKIE_MODE && !!readCookie("ge_csrf");
const canRefresh = (s: Session | null) => !!(s?.refreshToken || s?.cookie || (!s && hasCookieSession()));
export function getSession(scope: Scope): Session | null {
  try { const v = sessionStorage.getItem(KEY[scope]); return v ? JSON.parse(v) : null; } catch { return null; }
}
export function setSession(scope: Scope, s: Session | null) {
  try { s ? sessionStorage.setItem(KEY[scope], JSON.stringify(s)) : sessionStorage.removeItem(KEY[scope]); } catch { /* storage blocked: session lives in memory only */ }
}

let refreshing: Promise<boolean> | null = null;
async function refreshOnce(): Promise<Response> {
  const s = getSession("tenant");
  if (s?.refreshToken) return fetch(`${API_BASE}/api/v1/auth/refresh`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refreshToken: s.refreshToken }) });
  return fetch(`${API_BASE}/api/v1/auth/refresh`, { method: "POST", credentials: "same-origin",
    headers: { "content-type": "application/json", "x-session-mode": "cookie", "x-csrf-token": readCookie("ge_csrf") ?? "" }, body: "{}" });
}
async function doRefresh(): Promise<boolean> {
  let r = await refreshOnce();
  // another tab rotated the cookie a moment ago: the browser already holds the new one
  for (let i = 0; i < 3 && r.status === 422; i++) { await new Promise((ok) => setTimeout(ok, 300)); r = await refreshOnce(); }
  if (!r.ok) { if (r.status === 401 || r.status === 403) setSession("tenant", null); return false; }   // a server restart (5xx) keeps the session
  const j = await r.json();
  setSession("tenant", j.refreshToken ? { accessToken: j.accessToken, refreshToken: j.refreshToken } : { accessToken: j.accessToken, cookie: true });
  return true;
}
/** one refresh at a time — across tabs too where the browser supports Web Locks */
export async function refresh(): Promise<boolean> {
  if (!canRefresh(getSession("tenant"))) return false;
  const locks = (navigator as any).locks;
  refreshing ??= (locks ? locks.request("ge-refresh", doRefresh) : doRefresh()).finally(() => { refreshing = null; });
  return refreshing!;
}

export async function request<T = any>(method: string, path: string, body?: unknown, opts: { scope?: Scope; idempotencyKey?: string } = {}): Promise<T> {
  const scope = opts.scope ?? "tenant";
  const go = () => {
    const s = getSession(scope);
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (s) headers.authorization = `Bearer ${s.accessToken}`;
    if (opts.idempotencyKey) headers["idempotency-key"] = opts.idempotencyKey;
    if (COOKIE_MODE) headers["x-session-mode"] = "cookie";   // sign-in answers set the httpOnly cookie instead of returning the token
    return fetch(`${API_BASE}/api/v1${path}`, { method, headers, credentials: "same-origin", body: body === undefined ? undefined : JSON.stringify(body) });
  };
  let res = await go();
  if (res.status === 401 && scope === "tenant" && canRefresh(getSession("tenant")) && !path.startsWith("/auth/login") && !path.startsWith("/auth/refresh")) {
    if (await refresh()) res = await go();
  }
  // too many requests: a read is retried once after the server's suggested pause
  if (res.status === 429 && method === "GET") {
    const wait = Math.min(Number(res.headers.get("retry-after") ?? 2) || 2, 10);
    await new Promise((r) => setTimeout(r, wait * 1000));
    res = await go();
  }
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }   // e.g. a proxy's HTML error page during an update
  if (!res.ok) {
    if (res.status === 429) throw new ApiError(429, "RATE_LIMITED", "Too many requests — please wait a few seconds and try again", "طلبات كثيرة خلال وقت قصير — انتظر ثوانيَ ثم أعد المحاولة");
    if (!json && res.status >= 500) throw new ApiError(res.status, "SERVER_UNAVAILABLE", "The server is not reachable right now — try again shortly", "الخادم غير متاح الآن — أعد المحاولة بعد قليل");
    const e = json?.error ?? {};
    if (res.status === 401) window.dispatchEvent(new CustomEvent("ge:unauthorized", { detail: scope }));
    throw new ApiError(res.status, e.code ?? "HTTP_" + res.status, e.message ?? res.statusText, e.message_ar ?? e.message ?? res.statusText, e.details);
  }
  return json as T;
}

export const api = {
  get: <T = any>(p: string, scope?: Scope) => request<T>("GET", p, undefined, { scope }),
  post: <T = any>(p: string, b?: unknown, o?: { scope?: Scope; idempotencyKey?: string }) => request<T>("POST", p, b ?? {}, o),
  put: <T = any>(p: string, b: unknown, o?: { scope?: Scope }) => request<T>("PUT", p, b, o),
  patch: <T = any>(p: string, b: unknown) => request<T>("PATCH", p, b),
  del: <T = any>(p: string) => request<T>("DELETE", p),
};

export const fmt = (v: string | number | null | undefined, digits = 3, locale = "en-US") =>
  v === null || v === undefined || v === "" ? "—" : Number(v).toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });
export const fmtDate = (v?: string | null) => (v ? String(v).slice(0, 10) : "—");
export const fmtDateTime = (v?: string | null) => (v ? new Date(v).toLocaleString("en-GB", { hour12: false }) : "—");
