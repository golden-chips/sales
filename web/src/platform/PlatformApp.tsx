import { useState, type FormEvent } from "react";
import { api, fmt, fmtDate, getSession, setSession } from "../api";
import { useI18n } from "../i18n";
import { Empty, ErrorBox, Field, Loading, Modal, StatusBadge, errMsg, useAsync, useToast } from "../ui";
import { TopControls } from "../App";

const P = "platform" as const;

export default function PlatformApp() {
  const [authed, setAuthed] = useState(!!getSession(P));
  return authed ? <Console onOut={() => { setSession(P, null); setAuthed(false); }} /> : <PLogin onIn={() => setAuthed(true)} />;
}

function PLogin({ onIn }: { onIn: () => void }) {
  const { t } = useI18n();
  const [f, setF] = useState({ email: "", password: "", otp: "" });
  const [err, setErr] = useState<unknown>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr(null);
    try { const r = await api.post("/platform/auth/login", { email: f.email, password: f.password, ...(f.otp ? { otp: f.otp } : {}) }, { scope: P }); setSession(P, { accessToken: r.accessToken }); onIn(); } catch (x) { setErr(x); }
  };
  return (
    <div className="login-wrap"><form className="card login grid" onSubmit={submit}>
      <div className="row"><h1>{t.platform}</h1><span className="spacer" /><TopControls /></div>
      <ErrorBox error={err} />
      <Field label={t.email}><input dir="ltr" type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
      <Field label={t.password}><input dir="ltr" type="password" required value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
      <Field label={t.otp}><input dir="ltr" inputMode="numeric" value={f.otp} onChange={(e) => setF({ ...f, otp: e.target.value })} /></Field>
      <button className="btn primary">{t.login}</button><a href="/" style={{ fontSize: 12, textAlign: "center" }}>← {t.app}</a>
    </form></div>
  );
}

function Console({ onOut }: { onOut: () => void }) {
  const { t, pick, lang } = useI18n();
  const { toast } = useToast();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [prov, setProv] = useState(false);
  const tenants = useAsync(() => api.get(`/platform/tenants?pageSize=200${q ? `&q=${encodeURIComponent(q)}` : ""}`, P), [q]);
  const plans = useAsync(() => api.get("/platform/plans", P), []);
  const detail = useAsync(() => (sel ? api.get(`/platform/tenants/${sel}`, P) : Promise.resolve(null)), [sel]);
  const act = async (path: string, body: unknown) => { try { await api.post(`/platform/tenants/${sel}/${path}`, body, { scope: P }); toast(t.savedOk); detail.reload(); tenants.reload(); } catch (e) { toast(errMsg(e, lang), true); } };
  return (
    <div className="content" style={{ maxWidth: 1300, margin: "0 auto" }}>
      <div className="page-head"><div><h1>{t.platform}</h1><p>{t.tenants} · {t.plans}</p></div>
        <div className="row"><TopControls /><button className="btn" onClick={async () => { try { const r = await api.post("/platform/subscriptions/sweep", {}, { scope: P }); toast(JSON.stringify(r)); tenants.reload(); } catch (e) { toast(errMsg(e, lang), true); } }}>sweep</button>
          <button className="btn primary" onClick={() => setProv(true)}>{t.provision}</button><button className="btn" onClick={onOut}>{t.logout}</button></div></div>
      <div className="card" style={{ marginBottom: 16 }}>
        <h2>{t.plans}</h2>
        {plans.loading ? <Loading rows={2} /> : <div className="table-wrap"><table>
          <thead><tr><th>{t.code}</th><th>{t.name}</th><th className="end">/month</th><th className="end">/year</th><th>users</th><th>{t.branches}</th><th>{t.warehouses}</th><th>modules</th></tr></thead>
          <tbody>{plans.data?.map((p: any) => <tr key={p.id}><td className="num">{p.code}</td><td>{pick(p.name_ar, p.name_en)}</td><td className="end num">{fmt(p.price_monthly)} {p.currency}</td><td className="end num">{fmt(p.price_yearly)}</td><td className="num">{p.max_users}</td><td className="num">{p.max_branches}</td><td className="num">{p.max_warehouses}</td><td style={{ whiteSpace: "normal", maxWidth: 360 }}>{p.modules.join(", ")}</td></tr>)}</tbody>
        </table></div>}
      </div>
      <div className="card">
        <div className="row"><h2>{t.tenants}</h2><span className="spacer" /><input type="search" placeholder={t.search} value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 220 }} /></div>
        <ErrorBox error={tenants.error} />
        {tenants.loading ? <Loading /> : !tenants.data?.data.length ? <Empty /> : <div className="table-wrap"><table>
          <thead><tr><th>{t.code}</th><th>{t.name}</th><th>{t.plan}</th><th>{t.status}</th><th>{t.to}</th></tr></thead>
          <tbody>{tenants.data.data.map((x: any) => <tr key={x.id} style={{ cursor: "pointer" }} onClick={() => setSel(x.id)}><td className="num">{x.code}</td><td>{x.legal_name} {x.is_demo && <span className="badge demo">DEMO</span>}</td><td>{x.plan_code}</td><td><StatusBadge s={x.status} /></td><td className="num">{fmtDate(x.current_period_end)}</td></tr>)}</tbody>
        </table></div>}
      </div>
      {sel && <Modal title={detail.data?.tenant.legal_name ?? "…"} onClose={() => setSel(null)} footer={detail.data && <>
        {detail.data.tenant.status !== "suspended" ? <button className="btn danger" onClick={() => { const r = prompt(t.reason); if (r) act("suspend", { reason: r }); }}>{t.suspend}</button>
          : <button className="btn primary" onClick={() => { const r = prompt(t.reason); if (r) act("reactivate", { reason: r }); }}>{t.reactivate}</button>}
        <select id="cp" style={{ width: "auto" }} defaultValue="">{[<option key="" value="">{t.changePlan}…</option>, ...(plans.data ?? []).map((p: any) => <option key={p.code} value={p.code}>{p.code}</option>)]}</select>
        <button className="btn" onClick={() => { const v = (document.getElementById("cp") as HTMLSelectElement).value; if (v) act("change-plan", { planCode: v }); }}>{t.changePlan}</button>
      </>}>
        {detail.loading ? <Loading /> : detail.data && <div className="grid">
          <div className="row"><StatusBadge s={detail.data.tenant.status} /><span className="num">{detail.data.tenant.code}</span><span>{detail.data.tenant.base_currency} · {detail.data.tenant.timezone}</span>{detail.data.tenant.status_reason && <span className="badge warn">{detail.data.tenant.status_reason}</span>}</div>
          <div className="grid kpis">{Object.entries(detail.data.usage).map(([k, v]) => <div key={k} className="card kpi"><div className="label">{k}</div><div className="value num">{String(v)}</div></div>)}</div>
          <h3>{t.subscription}</h3>
          <div className="table-wrap"><table><thead><tr><th>{t.plan}</th><th>{t.status}</th><th>{t.from}</th><th>{t.to}</th></tr></thead>
            <tbody>{detail.data.subscriptions.map((s: any) => <tr key={s.id}><td>{s.plan_code}</td><td><StatusBadge s={s.status} /></td><td className="num">{fmtDate(s.current_period_start)}</td><td className="num">{fmtDate(s.current_period_end)}</td></tr>)}</tbody></table></div>
          <h3>{t.invoices}</h3>
          <div className="table-wrap"><table><thead><tr><th>{t.number}</th><th className="end">{t.amount}</th><th>{t.status}</th><th /></tr></thead>
            <tbody>{detail.data.invoices.map((i: any) => <tr key={i.id}><td className="num">{i.number}</td><td className="end num">{fmt(i.amount)} {i.currency}</td><td><StatusBadge s={i.status} /></td>
              <td>{i.status === "issued" && <button className="btn sm" onClick={async () => { try { await api.post(`/platform/invoices/${i.id}/mark-paid`, {}, { scope: P }); detail.reload(); } catch (e) { toast(errMsg(e, lang), true); } }}>paid</button>}</td></tr>)}</tbody></table></div>
          <h3>events</h3>
          <ul style={{ margin: 0 }}>{detail.data.events.map((e: any) => <li key={e.id}><code>{e.event_type}</code> · <span className="num">{fmtDate(e.created_at)}</span> {e.note}</li>)}</ul>
          <p style={{ color: "var(--muted)", fontSize: 12 }}>Platform staff see metadata and usage counts only — tenant business data is isolated by the database.</p>
        </div>}
      </Modal>}
      {prov && plans.data && <Provision plans={plans.data} onClose={() => setProv(false)} onDone={() => { setProv(false); tenants.reload(); toast(t.savedOk); }} />}
    </div>
  );
}

function Provision({ plans, onClose, onDone }: { plans: any[]; onClose: () => void; onDone: () => void }) {
  const { t } = useI18n();
  const [f, setF] = useState({ code: "", legalName: "", nameEn: "", planCode: plans[0]?.code ?? "", baseCurrency: "LYD", timezone: "Africa/Tripoli", companyCode: "MAIN", ownerName: "", ownerEmail: "", ownerPassword: "" });
  const [err, setErr] = useState<unknown>(null);
  const s = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    setErr(null);
    try {
      await api.post("/platform/tenants", { code: f.code, legalName: f.legalName, nameEn: f.nameEn || undefined, planCode: f.planCode, baseCurrency: f.baseCurrency, timezone: f.timezone,
        company: { code: f.companyCode, nameAr: f.legalName, nameEn: f.nameEn || undefined }, owner: { email: f.ownerEmail, fullName: f.ownerName, password: f.ownerPassword } }, { scope: P });
      onDone();
    } catch (e) { setErr(e); }
  };
  return (
    <Modal title={t.provision} onClose={onClose} footer={<><button className="btn" onClick={onClose}>{t.cancel}</button><button className="btn primary" onClick={save}>{t.create}</button></>}>
      <ErrorBox error={err} />
      <div className="form-grid">
        <Field label={t.tenant}><input dir="ltr" value={f.code} onChange={s("code")} placeholder="acme-foods" /></Field>
        <Field label={t.name}><input value={f.legalName} onChange={s("legalName")} /></Field>
        <Field label="English"><input dir="ltr" value={f.nameEn} onChange={s("nameEn")} /></Field>
        <Field label={t.plan}><select value={f.planCode} onChange={s("planCode")}>{plans.map((p) => <option key={p.code}>{p.code}</option>)}</select></Field>
        <Field label={t.currency}><select value={f.baseCurrency} onChange={s("baseCurrency")}>{["LYD", "USD", "EUR", "TND", "EGP", "TRY", "SAR", "AED"].map((c) => <option key={c}>{c}</option>)}</select></Field>
        <Field label="Timezone"><input dir="ltr" value={f.timezone} onChange={s("timezone")} /></Field>
        <Field label={`${t.company} ${t.code}`}><input dir="ltr" value={f.companyCode} onChange={(e) => setF({ ...f, companyCode: e.target.value.toUpperCase() })} /></Field>
        <Field label={`${t.owner}: ${t.fullName}`}><input value={f.ownerName} onChange={s("ownerName")} /></Field>
        <Field label={`${t.owner}: ${t.email}`}><input dir="ltr" type="email" value={f.ownerEmail} onChange={s("ownerEmail")} /></Field>
        <Field label={`${t.owner}: ${t.password}`}><input dir="ltr" type="password" value={f.ownerPassword} onChange={s("ownerPassword")} /></Field>
      </div>
    </Modal>
  );
}
