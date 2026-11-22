import { useState } from "react";
import { api, fmt, fmtDate } from "../api";
import { useI18n } from "../i18n";
import { useSession } from "../session";
import { ErrorBox, Field, Loading, StatusBadge, errMsg, useAsync, useToast } from "../ui";
import { PlanCards } from "../PlanCards";

/** the customer's subscription: usage, plan comparison and the request to subscribe / change plan */
export default function Subscription() {
  const { t, tt, pick, lang } = useI18n();
  const { me } = useSession();
  const { toast } = useToast();
  const d = useAsync(() => api.get("/subscription"), []);
  const plans = useAsync(() => api.get("/public/plans"), []);
  const reqs = useAsync(() => api.get("/subscription/upgrade-requests"), []);
  const [f, setF] = useState({ planCode: "", billingCycle: "monthly", contactPhone: "", note: "" });
  const [busy, setBusy] = useState(false);
  if (d.loading) return <Loading />;
  if (d.error) return <ErrorBox error={d.error} />;
  const { subscription: s, usage: u, invoices } = d.data;
  const pending = (reqs.data ?? []).find((r: any) => r.status === "open");
  const trial = ["trial", "past_due"].includes(me?.tenant.status ?? "");
  const chosen = f.planCode || s?.plan_code;
  const planName = (code?: string) => { const p = (plans.data ?? []).find((x: any) => x.code === code); return p ? pick(p.name_ar, p.name_en) : code ?? ""; };
  const chosenPlan = (plans.data ?? []).find((p: any) => p.code === chosen);
  const canRequest = true;   // the page itself requires core.subscription.view, as does the request
  const send = async () => {
    setBusy(true);
    try {
      await api.post("/subscription/upgrade-request", { ...f, planCode: chosen, contactPhone: f.contactPhone || undefined, note: f.note || undefined });
      reqs.reload();
      toast(tt("وصل طلبك، وسيتواصل معك فريقنا لإتمام الاشتراك", "Request received — our team will contact you"));
    } catch (e) { toast(errMsg(e, lang), true); } finally { setBusy(false); }
  };
  const bar = (used: number, lim: number) => (
    <div style={{ background: "var(--surface-2)", borderRadius: 99, height: 8, overflow: "hidden" }}><div style={{ width: `${Math.min(100, (used / lim) * 100)}%`, background: used >= lim ? "var(--bad)" : "var(--brand)", height: "100%" }} /></div>);
  return (
    <>
      <div className="page-head"><h1>{t.subscription}</h1></div>
      <div className="grid kpis">
        <div className="card kpi"><div className="label">{t.plan}</div><div className="value">{pick(s?.plan_name_ar, s?.plan_name_en)}</div><div className="row"><StatusBadge s={s?.status} /><span className="num">{fmtDate(s?.current_period_end)}</span></div></div>
        {([[tt("المستخدمون", "Users"), u.active_users, s?.max_users], [t.companies, u.companies, s?.max_companies], [t.branches, u.branches, s?.max_branches], [t.warehouses, u.warehouses, s?.max_warehouses]] as const).map(([l, used, lim]) => (
          <div className="card kpi" key={l}><div className="label">{l}</div><div className="value num">{used} / {lim}</div>{bar(Number(used), Number(lim))}</div>))}
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h2>{trial ? tt("اختر باقتك واطلب الاشتراك", "Choose your plan and subscribe") : tt("الباقات المتاحة — للترقية أو التغيير", "Plans — upgrade or change")}</h2>
        <p style={{ marginTop: -4, color: "var(--muted)" }}>{tt("قارن الحدود والأقسام في كل باقة واضغط على المناسبة لك. الأقسام بعلامة ✓ مشمولة في الباقة.", "Compare limits and modules and click the plan that fits. Modules with ✓ are included.")}</p>
        <PlanCards plans={plans.data ?? []} current={s?.plan_code} selected={canRequest && !pending ? chosen : undefined} cycle={f.billingCycle as any}
          onSelect={canRequest && !pending ? (code) => setF({ ...f, planCode: code }) : undefined} />
        {pending ? <div className="alert info" style={{ marginTop: 16 }}>
            {tt(`طلبك للباقة «${planName(pending.plan_code)}» قيد المعالجة — سيتواصل معك فريقنا.`, `Your request for the ${planName(pending.plan_code)} plan is in progress — our team will contact you.`)}</div>
          : canRequest ? <div style={{ marginTop: 16 }}>
            <div className="form-grid">
              <Field label={tt("طريقة الدفع", "Billing")}><select value={f.billingCycle} onChange={(e) => setF({ ...f, billingCycle: e.target.value })}>
                <option value="monthly">{tt("شهري", "Monthly")}</option><option value="yearly">{tt("سنوي", "Yearly")}</option></select></Field>
              <Field label={tt("هاتف للتواصل", "Contact phone")}><input dir="ltr" inputMode="tel" placeholder="+2189…" value={f.contactPhone} onChange={(e) => setF({ ...f, contactPhone: e.target.value })} /></Field>
              <Field label={tt("ملاحظة (اختياري)", "Note (optional)")}><input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder={tt("مثال: نحتاج 8 مستخدمين وفرعين", "e.g. we need 8 users and 2 branches")} /></Field>
            </div>
            <div className="row" style={{ marginTop: 12 }}>
              <span>{tt("الباقة المختارة:", "Selected plan:")} <b>{chosenPlan ? pick(chosenPlan.name_ar, chosenPlan.name_en) : "—"}</b></span><span className="spacer" />
              <button className="btn primary" disabled={!chosen || busy} onClick={send}>{tt("أرسل طلب الاشتراك", "Send subscription request")}</button>
            </div>
          </div>
          : <div className="alert info" style={{ marginTop: 16 }}>{tt("طلب الاشتراك يقدّمه مالك الحساب أو مدير النظام.", "The account owner or an admin submits the subscription request.")}</div>}
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h2>{t.invoices}</h2>
        <div className="table-wrap"><table>
          <thead><tr><th>{t.number}</th><th>{t.from}</th><th>{t.to}</th><th className="end">{t.amount}</th><th>{t.status}</th></tr></thead>
          <tbody>{invoices.map((i: any) => <tr key={i.number}><td className="num">{i.number}</td><td className="num">{fmtDate(i.period_start)}</td><td className="num">{fmtDate(i.period_end)}</td><td className="end num">{fmt(Number(i.amount) - Number(i.discount))} {i.currency}</td><td><StatusBadge s={i.status} /></td></tr>)}</tbody>
        </table></div>
      </div>
    </>
  );
}
