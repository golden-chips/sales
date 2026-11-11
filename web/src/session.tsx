import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, getSession, setSession } from "./api";

export interface Me {
  user: { id: string; email: string; full_name: string; locale: string; is_owner: boolean; mfa_enabled: boolean };
  tenant: { id: string; code: string; legal_name: string; name_en: string | null; status: string; base_currency: string; timezone: string; brand_color: string | null; is_demo: boolean };
  companies: { id: string; code: string; name_ar: string; name_en: string | null; base_currency: string }[];
  roles: { code: string; name_ar: string; name_en: string; branch_id: string | null }[];
  permissions: string[]; modules: string[];
}
const Ctx = createContext<{ me: Me | null; loading: boolean; companyId: string | null; setCompanyId: (id: string) => void; can: (p: string) => boolean; signIn: (s: { accessToken: string; refreshToken: string }) => Promise<void>; signOut: () => void }>(null as any);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(!!getSession("tenant"));
  const [companyId, setCompanyIdState] = useState<string | null>(() => { try { return localStorage.getItem("ge.company"); } catch { return null; } });
  const load = async () => {
    if (!getSession("tenant")) { setMe(null); setLoading(false); return; }
    try {
      const m = await api.get<Me>("/auth/me");
      setMe(m);
      if (!m.companies.find((c) => c.id === companyId)) setCompanyIdState(m.companies[0]?.id ?? null);
      if (m.tenant.brand_color) document.documentElement.style.setProperty("--brand", m.tenant.brand_color);
    } catch { setSession("tenant", null); setMe(null); } finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);
  useEffect(() => {
    const h = (e: Event) => { if ((e as CustomEvent).detail === "tenant") { setSession("tenant", null); setMe(null); } };
    window.addEventListener("ge:unauthorized", h);
    return () => window.removeEventListener("ge:unauthorized", h);
  }, []);
  const setCompanyId = (id: string) => { setCompanyIdState(id); try { localStorage.setItem("ge.company", id); } catch { /* not persisted */ } };
  return (
    <Ctx.Provider value={{
      me, loading, companyId, setCompanyId, can: (p) => !!me?.permissions.includes(p),
      signIn: async (s) => { setSession("tenant", s); setLoading(true); await load(); },
      signOut: () => { api.post("/auth/logout").catch(() => undefined).finally(() => { setSession("tenant", null); setMe(null); }); },
    }}>{children}</Ctx.Provider>
  );
}
export const useSession = () => useContext(Ctx);
