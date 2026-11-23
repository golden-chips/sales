import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { ChevronDown, Menu, Search, Moon, Sun, Languages, LogOut, X, CornerDownLeft, SlidersHorizontal } from "lucide-react";
import { useI18n } from "./i18n";
import { useSession } from "./session";
import { HOME, findItem, visibleNav, type NavGroup, type NavItem } from "./nav";

const store = { get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* per-viewer convenience only */ } } };

/** appearance preferences, per user on this device: light/dark/auto, colour theme and text size */
export type Appearance = { theme: "" | "light" | "dark"; accent: string; scale: "" | "large" | "xlarge" };
const appearanceListeners = new Set<() => void>();
let appearance: Appearance = { theme: (store.get("theme") as any) || "", accent: store.get("accent") || "gold", scale: (store.get("scale") as any) || "" };
function applyAppearance(a: Appearance) {
  const el = document.documentElement;
  if (a.theme) el.setAttribute("data-theme", a.theme); else el.removeAttribute("data-theme");
  el.setAttribute("data-accent", a.accent || "gold");
  if (a.scale) el.setAttribute("data-scale", a.scale); else el.removeAttribute("data-scale");
}
applyAppearance(appearance);
export function setAppearance(p: Partial<Appearance>) {
  appearance = { ...appearance, ...p };
  store.set("theme", appearance.theme); store.set("accent", appearance.accent); store.set("scale", appearance.scale);
  applyAppearance(appearance);
  appearanceListeners.forEach((l) => l());
}
export function useAppearance() {
  return useSyncExternalStore((l) => { appearanceListeners.add(l); return () => appearanceListeners.delete(l); }, () => appearance);
}

export function useTheme() {
  const a = useAppearance();
  const dark = a.theme === "dark" || (!a.theme && matchMedia("(prefers-color-scheme: dark)").matches);
  return { dark, toggle: () => setAppearance({ theme: dark ? "light" : "dark" }) };
}

export function TopControls() {
  const { t, lang, setLang } = useI18n();
  const { dark, toggle } = useTheme();
  return <>
    <button className="icon-btn" onClick={toggle} title={t.darkMode} aria-label={t.darkMode}>{dark ? <Sun size={18} /> : <Moon size={18} />}</button>
    <button className="icon-btn" onClick={() => setLang(lang === "ar" ? "en" : "ar")} title={t.language} aria-label={t.language}><Languages size={18} /></button>
  </>;
}

/** the company mark: initials on the brand gradient */
export function Logo({ size = 40, text = "GC" }: { size?: number; text?: string }) {
  return <div className="logo-mark" style={{ width: size, height: size, fontSize: size * 0.36 }}>{text}</div>;
}

function Sidebar({ groups, open, onClose }: { groups: NavGroup[]; open: boolean; onClose: () => void }) {
  const { pick } = useI18n();
  const { me } = useSession();
  const loc = useLocation();
  const activeGroup = findItem(groups, loc.pathname)?.group?.key;
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => { try { return JSON.parse(store.get("nav.expanded") ?? "{}"); } catch { return {}; } });
  // one group open at a time (accordion); moving to another screen opens its group
  useEffect(() => { if (activeGroup && !expanded[activeGroup]) setExpanded({ [activeGroup]: true }); }, [activeGroup]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => store.set("nav.expanded", JSON.stringify(expanded)), [expanded]);
  const name = pick(me!.tenant.legal_name, me!.tenant.name_en);
  const initials = (me!.tenant.code ?? "GE").split(/[-_ ]/).map((w: string) => w[0]).join("").slice(0, 2).toUpperCase();
  const link = (i: NavItem) => <NavLink key={i.to} to={i.to} end className="nav-link" onClick={onClose}><i.icon size={17} strokeWidth={1.9} /><span>{pick(i.ar, i.en)}</span></NavLink>;
  return <>
    <div className={`scrim ${open ? "show" : ""}`} onClick={onClose} />
    <aside className={`sidebar ${open ? "open" : ""}`}>
      <div className="side-brand">
        <Logo text={initials} />
        <div className="side-brand-text"><b>GOLDEN ERP</b><small title={name}>{name}</small></div>
        <button className="icon-btn side-close" onClick={onClose} aria-label="close"><X size={18} /></button>
      </div>
      <nav className="side-nav">
        {link(HOME)}
        {groups.map((g) => {
          const isOpen = !!expanded[g.key];
          return <div key={g.key} className={`nav-group ${isOpen ? "open" : ""} ${activeGroup === g.key ? "has-active" : ""}`}>
            <button className="nav-group-btn" onClick={() => setExpanded(isOpen ? {} : { [g.key]: true })} aria-expanded={isOpen}>
              <g.icon size={17} strokeWidth={1.9} /><span>{pick(g.ar, g.en)}</span><ChevronDown size={15} className="chev" />
            </button>
            {isOpen && <div className="nav-items">{g.items.map(link)}</div>}
          </div>;
        })}
      </nav>
    </aside>
  </>;
}

/** Ctrl+K / ⌘K: jump to any screen by typing part of its name (Arabic or English) */
function CommandPalette({ groups, onClose }: { groups: NavGroup[]; onClose: () => void }) {
  const { pick, tt } = useI18n();
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const all = useMemo(() => [{ g: null as NavGroup | null, i: HOME }, ...groups.flatMap((g) => g.items.map((i) => ({ g, i })))], [groups]);
  const norm = (s: string) => s.toLowerCase().replace(/[أإآ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي");
  const hits = all.filter(({ g, i }) => !q || norm(`${i.ar} ${i.en} ${g?.ar ?? ""} ${g?.en ?? ""}`).includes(norm(q))).slice(0, 12);
  useEffect(() => input.current?.focus(), []);
  useEffect(() => setSel(0), [q]);
  const go = (to: string) => { nav(to); onClose(); };
  return <div className="palette-scrim" onClick={onClose}>
    <div className="palette" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={tt("بحث", "Search")}>
      <div className="palette-input"><Search size={18} />
        <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder={tt("اكتب اسم الشاشة… مثل: فاتورة، مخزون، رواتب", "Type a screen… e.g. invoice, stock, payroll")}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, hits.length - 1)); }
            if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
            if (e.key === "Enter" && hits[sel]) go(hits[sel].i.to);
            if (e.key === "Escape") onClose();
          }} />
        <kbd>Esc</kbd></div>
      <div className="palette-list">
        {hits.length ? hits.map(({ g, i }, n) => <button key={i.to} className={`palette-item ${n === sel ? "sel" : ""}`} onMouseEnter={() => setSel(n)} onClick={() => go(i.to)}>
          <span className="pi-icon"><i.icon size={17} /></span><span className="pi-text">{pick(i.ar, i.en)}{g && <small>{pick(g.ar, g.en)}</small>}</span>
          {n === sel && <CornerDownLeft size={15} className="pi-enter" />}</button>)
          : <div className="palette-empty">{tt("لا توجد نتيجة", "No match")}</div>}
      </div>
    </div>
  </div>;
}

/** theme & language inside the account menu (the only place they appear on phones) */
function MenuPrefs() {
  const { t, lang, setLang, tt } = useI18n();
  const { dark, toggle } = useTheme();
  return <>
    <button className="dropdown-item" onClick={toggle}>{dark ? <Sun size={16} /> : <Moon size={16} />}{dark ? tt("الوضع الفاتح", "Light mode") : t.darkMode}</button>
    <button className="dropdown-item" onClick={() => setLang(lang === "ar" ? "en" : "ar")}><Languages size={16} />{lang === "ar" ? "English" : "العربية"}</button>
  </>;
}

export function Shell({ children }: { children: ReactNode }) {
  const { t, pick, tt } = useI18n();
  const { me, can, signOut, companyId, setCompanyId } = useSession();
  const [open, setOpen] = useState(false);
  const [palette, setPalette] = useState(false);
  const [userMenu, setUserMenu] = useState(false);
  const loc = useLocation();
  const nav = useNavigate();
  const groups = useMemo(() => (me ? visibleNav(me.modules, can) : []), [me, can]);
  const current = findItem(groups, loc.pathname);
  useEffect(() => { setOpen(false); setUserMenu(false); window.scrollTo(0, 0); }, [loc.pathname]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPalette(true); return; }
      const tag = (e.target as HTMLElement)?.tagName;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(tag) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key.toLowerCase() === "n" && can("accounting.journal.create")) { e.preventDefault(); nav("/journal?new=1"); }
      if (e.key === "/") { const s = document.querySelector<HTMLInputElement>(".content input[type=search]"); if (s) { e.preventDefault(); s.focus(); } }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [can, nav]);
  if (!me) return null;
  const initials = me.user.full_name.split(" ").map((w: string) => w[0]).join("").slice(0, 2);
  return <div className="layout">
    <Sidebar groups={groups} open={open} onClose={() => setOpen(false)} />
    <div className="main">
      <header className="topbar">
        <button className="icon-btn menu-btn" onClick={() => setOpen(true)} aria-label="menu"><Menu size={20} /></button>
        <div className="crumbs">
          {current?.group && <span className="crumb-group">{pick(current.group.ar, current.group.en)}</span>}
          <span className="crumb-page">{current ? pick(current.item.ar, current.item.en) : ""}</span>
        </div>
        <button className="search-trigger" onClick={() => setPalette(true)}><Search size={16} /><span>{tt("ابحث أو اذهب إلى…", "Search or jump to…")}</span><kbd>Ctrl K</kbd></button>
        <div className="top-actions">
          {me.tenant.is_demo && <span className="badge demo hide-sm">DEMO</span>}
          {me.companies.length > 1 && <select className="company-select" value={companyId ?? ""} onChange={(e) => setCompanyId(e.target.value)} aria-label={t.company}>
            {me.companies.map((c) => <option key={c.id} value={c.id}>{c.code} — {pick(c.name_ar, c.name_en)}</option>)}</select>}
          <span className="hide-sm row" style={{ gap: 6 }}><TopControls /></span>
          <div className="user-menu">
            <button className="avatar-btn" onClick={() => setUserMenu(!userMenu)} aria-expanded={userMenu}><span className="avatar">{initials}</span><span className="user-name">{me.user.full_name}</span><ChevronDown size={14} /></button>
            {userMenu && <div className="dropdown" onMouseLeave={() => setUserMenu(false)}>
              <div className="dropdown-head"><b>{me.user.full_name}</b><small dir="ltr">{me.user.username ?? me.user.email}</small>
                {me.companies.length === 1 && <small>{pick(me.companies[0].name_ar, me.companies[0].name_en)}</small>}</div>
              <button className="dropdown-item" onClick={() => nav("/settings?tab=appearance")}><SlidersHorizontal size={16} />{tt("الإعدادات والمظهر", "Settings & appearance")}</button>
              <MenuPrefs />
              <button className="dropdown-item" onClick={signOut}><LogOut size={16} />{t.logout}</button>
            </div>}
          </div>
        </div>
      </header>
      <main className="content">{children}</main>
    </div>
    {palette && <CommandPalette groups={groups} onClose={() => setPalette(false)} />}
  </div>;
}
