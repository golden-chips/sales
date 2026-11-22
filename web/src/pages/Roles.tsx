// Roles & permissions: built-in roles are read-only templates (copy them to customise);
// custom roles are edited here — grouped by module, with sensitive permissions flagged.
import { useMemo, useState } from "react";
import { Copy, Lock, Pencil, Save, Search, ShieldAlert, Trash2, Users } from "lucide-react";
import { api } from "../api";
import { useI18n } from "../i18n";
import { useSession } from "../session";
import { ErrorBox, Field, Loading, Modal, errMsg, useAsync, useToast } from "../ui";
import { MODULE_NAMES } from "../PlanCards";

const MOD: Record<string, [string, string]> = { core: ["الأساسيات والإدارة", "Core & administration"], ...MODULE_NAMES };

export default function Roles() {
  const { tt, pick, lang } = useI18n();
  const { can, me } = useSession();
  const { toast, confirm } = useToast();
  const roles = useAsync(() => api.get("/roles"), []);
  const perms = useAsync(() => api.get("/permissions"), []);
  const [selId, setSelId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Set<string> | null>(null);
  const [q, setQ] = useState("");
  const [copying, setCopying] = useState<any | null>(null);
  const [renaming, setRenaming] = useState<any | null>(null);
  const manage = can("core.roles.manage");
  const role = roles.data?.find((r: any) => r.id === selId) ?? roles.data?.[0];
  const editable = manage && role && !role.is_system;
  const current: Set<string> = draft ?? new Set(role?.permissions ?? []);
  const dirty = !!draft;
  const mine = (code: string) => me!.user.is_owner || can(code);   // you can only grant what you hold

  const groups = useMemo(() => {
    const by: Record<string, any[]> = {};
    for (const p of perms.data ?? []) {
      const text = `${p.name_ar} ${p.name_en} ${p.code} ${MOD[p.module_code]?.[0] ?? ""}`.toLowerCase();
      if (q && !text.includes(q.toLowerCase())) continue;
      (by[p.module_code] ??= []).push(p);
    }
    const order = Object.keys(MOD);
    return Object.entries(by).sort(([a], [b]) => order.indexOf(a) - order.indexOf(b));
  }, [perms.data, q]);

  if (roles.loading || perms.loading) return <Loading />;
  const pickRole = async (id: string) => {
    if (dirty && !(await confirm(tt("لديك تعديلات غير محفوظة — تجاهلها؟", "Discard unsaved changes?")))) return;
    setDraft(null); setSelId(id);
  };
  const toggle = (code: string) => { const n = new Set(current); n.has(code) ? n.delete(code) : n.add(code); setDraft(n); };
  const toggleModule = (ps: any[], on: boolean) => { const n = new Set(current); for (const p of ps) if (mine(p.code)) on ? n.add(p.code) : n.delete(p.code); setDraft(n); };
  const save = async () => {
    try { await api.put(`/roles/${role.id}/permissions`, { permissions: [...current].sort() }); toast(tt("حُفظت صلاحيات الدور", "Role saved")); setDraft(null); roles.reload(); }
    catch (e) { toast(errMsg(e, lang), true); }
  };
  const remove = async () => {
    if (!(await confirm(tt(`حذف الدور «${pick(role.name_ar, role.name_en)}»؟`, `Delete role ${role.name_en}?`)))) return;
    try { await api.del(`/roles/${role.id}`); toast(tt("حُذف الدور", "Role deleted")); setSelId(null); setDraft(null); roles.reload(); }
    catch (e) { toast(errMsg(e, lang), true); }
  };
  const builtIn = (roles.data ?? []).filter((r: any) => r.is_system);
  const custom = (roles.data ?? []).filter((r: any) => !r.is_system);
  const roleLink = (r: any) => <button key={r.id} className={`role-link ${r.id === role?.id ? "active" : ""}`} onClick={() => pickRole(r.id)}>
    <span>{pick(r.name_ar, r.name_en)}</span><span className="badge num" title={tt("عدد المستخدمين", "Users")}><Users size={12} /> {r.user_count}</span></button>;

  return <>
    <div className="page-head"><div><h1>{tt("الأدوار والصلاحيات", "Roles & permissions")}</h1>
      <p>{tt("كل مستخدم يأخذ صلاحيات أدواره. الأدوار الجاهزة قوالب ثابتة — انسخ أي دور لتعديله حسب شركتك.", "Users get the permissions of their roles. Built-in roles are templates — copy one to customise it.")}</p></div></div>
    <ErrorBox error={roles.error || perms.error} />
    <div className="roles-layout">
      <div className="card roles-list">
        {custom.length > 0 && <><div className="roles-head">{tt("أدوار شركتك", "Your roles")}</div>{custom.map(roleLink)}</>}
        <div className="roles-head">{tt("أدوار جاهزة", "Built-in roles")}</div>{builtIn.map(roleLink)}
      </div>
      {role && <div className="card">
        <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
          <h2 style={{ margin: 0 }}>{pick(role.name_ar, role.name_en)}</h2>
          {role.is_system ? <span className="badge"><Lock size={12} /> {tt("قالب جاهز", "Built-in")}</span> : <span className="badge info">{tt("دور خاص", "Custom")}</span>}
          <span className="badge num">{current.size} {tt("صلاحية", "permissions")}</span>
          <span className="spacer" />
          {manage && <button className="btn sm" onClick={() => setCopying(role)}><Copy size={15} />{tt("نسخ وتعديل", "Copy & edit")}</button>}
          {editable && <><button className="btn sm" onClick={() => setRenaming(role)}><Pencil size={15} />{tt("إعادة تسمية", "Rename")}</button>
            <button className="btn sm danger" onClick={remove}><Trash2 size={15} />{tt("حذف", "Delete")}</button>
            <button className="btn sm primary" disabled={!dirty} onClick={save}><Save size={15} />{tt("حفظ التعديلات", "Save")}</button></>}
        </div>
        {role.is_system && <div className="alert info" style={{ marginTop: 12 }}>{tt("هذا دور جاهز يحدّثه النظام تلقائيًا عند إضافة ميزات جديدة، لذلك لا يُعدّل مباشرة. اضغط «نسخ وتعديل» لعمل نسخة خاصة بشركتك ثم أسندها للمستخدمين من شاشة المستخدمين.",
          "Built-in roles are updated by the system when features are added, so they are not edited directly. Use “Copy & edit”, then assign the copy to users.")}</div>}
        <div className="input-icon" style={{ margin: "14px 0" }}><Search size={17} /><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={tt("ابحث عن صلاحية… مثل: ترحيل، رواتب، خصم", "Search a permission… e.g. post, payroll")} /></div>
        <div className="perm-groups">{groups.map(([m, ps]) => {
          const on = ps.filter((p) => current.has(p.code)).length;
          return <div key={m} className="perm-group">
            <div className="perm-group-head"><b>{MOD[m] ? pick(...MOD[m]) : m}</b><span className="badge num">{on}/{ps.length}</span><span className="spacer" />
              {editable && <><button className="btn sm" onClick={() => toggleModule(ps, true)}>{tt("الكل", "All")}</button><button className="btn sm" onClick={() => toggleModule(ps, false)}>{tt("لا شيء", "None")}</button></>}</div>
            {ps.map((p) => { const has = current.has(p.code); const allowed = mine(p.code);
              return <label key={p.code} className={`perm-item ${has ? "on" : ""}`} title={editable && !allowed ? tt("لا يمكنك منح صلاحية لا تملكها", "You cannot grant a permission you do not hold") : p.code}>
                <input type="checkbox" style={{ width: "auto", minHeight: 0 }} checked={has} disabled={!editable || (!allowed && !has)} onChange={() => toggle(p.code)} />
                <span>{pick(p.name_ar, p.name_en)}</span>
                {p.is_sensitive && <span className="badge warn" title={tt("صلاحية حساسة: تمس المال أو الاعتماد أو البيانات الحساسة", "Sensitive: money, approvals or sensitive data")}><ShieldAlert size={12} /> {tt("حساسة", "sensitive")}</span>}
              </label>; })}
          </div>; })}</div>
      </div>}
    </div>
    {copying && <CopyRole source={copying} onClose={() => setCopying(null)} onDone={(id) => { setCopying(null); roles.reload(); setDraft(null); setSelId(id); }} />}
    {renaming && <RenameRole role={renaming} onClose={() => setRenaming(null)} onDone={() => { setRenaming(null); roles.reload(); }} />}
  </>;
}

function CopyRole({ source, onClose, onDone }: { source: any; onClose: () => void; onDone: (id: string) => void }) {
  const { tt, pick } = useI18n();
  const { me, can } = useSession();
  const [f, setF] = useState({ nameAr: `${source.name_ar} (نسخة)`, nameEn: `${source.name_en} (copy)` });
  const [err, setErr] = useState<unknown>(null);
  const grantable = source.permissions.filter((p: string) => me!.user.is_owner || can(p));
  const save = async () => {
    setErr(null);
    const code = `custom_${Date.now().toString(36)}`;
    try { const r = await api.post("/roles", { code, ...f, permissions: grantable }); onDone(r.id); } catch (e) { setErr(e); }
  };
  return <Modal title={tt(`نسخ الدور «${pick(source.name_ar, source.name_en)}»`, `Copy role ${source.name_en}`)} onClose={onClose}
    footer={<><button className="btn" onClick={onClose}>{tt("إلغاء", "Cancel")}</button><button className="btn primary" onClick={save}>{tt("إنشاء النسخة", "Create copy")}</button></>}>
    <ErrorBox error={err} />
    <div className="form-grid">
      <Field label={tt("اسم الدور بالعربي", "Arabic name")}><input value={f.nameAr} onChange={(e) => setF({ ...f, nameAr: e.target.value })} /></Field>
      <Field label={tt("اسم الدور بالإنجليزي", "English name")}><input dir="ltr" value={f.nameEn} onChange={(e) => setF({ ...f, nameEn: e.target.value })} /></Field>
    </div>
    <p style={{ color: "var(--muted)", marginBottom: 0 }}>{tt(`تبدأ النسخة بنفس صلاحيات الدور (${grantable.length})، ثم عدّلها كما تريد.`, `The copy starts with the same ${grantable.length} permissions; then edit it.`)}
      {grantable.length < source.permissions.length && tt(` (${source.permissions.length - grantable.length} صلاحية لا تملكها لن تُنسخ)`, ` (${source.permissions.length - grantable.length} you do not hold are left out)`)}</p>
  </Modal>;
}

function RenameRole({ role, onClose, onDone }: { role: any; onClose: () => void; onDone: () => void }) {
  const { tt } = useI18n();
  const [f, setF] = useState({ nameAr: role.name_ar, nameEn: role.name_en });
  const [err, setErr] = useState<unknown>(null);
  const save = async () => { setErr(null); try { await api.patch(`/roles/${role.id}`, f); onDone(); } catch (e) { setErr(e); } };
  return <Modal title={tt("إعادة تسمية الدور", "Rename role")} onClose={onClose} footer={<><button className="btn" onClick={onClose}>{tt("إلغاء", "Cancel")}</button><button className="btn primary" onClick={save}>{tt("حفظ", "Save")}</button></>}>
    <ErrorBox error={err} />
    <div className="form-grid">
      <Field label={tt("الاسم بالعربي", "Arabic name")}><input value={f.nameAr} onChange={(e) => setF({ ...f, nameAr: e.target.value })} /></Field>
      <Field label={tt("الاسم بالإنجليزي", "English name")}><input dir="ltr" value={f.nameEn} onChange={(e) => setF({ ...f, nameEn: e.target.value })} /></Field>
    </div>
  </Modal>;
}
