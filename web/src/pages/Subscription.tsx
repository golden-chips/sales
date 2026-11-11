import { api, fmt, fmtDate } from "../api";
import { useI18n } from "../i18n";
import { ErrorBox, Loading, StatusBadge, useAsync } from "../ui";

export default function Subscription() {
  const { t, pick } = useI18n();
  const d = useAsync(() => api.get("/subscription"), []);
  if (d.loading) return <Loading />;
  if (d.error) return <ErrorBox error={d.error} />;
  const { subscription: s, usage: u, invoices } = d.data;
  const bar = (used: number, lim: number) => (
    <div style={{ background: "var(--surface-2)", borderRadius: 99, height: 8, overflow: "hidden" }}><div style={{ width: `${Math.min(100, (used / lim) * 100)}%`, background: used >= lim ? "var(--bad)" : "var(--brand)", height: "100%" }} /></div>);
  return (
    <>
      <div className="page-head"><h1>{t.subscription}</h1></div>
      <div className="grid kpis">
        <div className="card kpi"><div className="label">{t.plan}</div><div className="value">{pick(s?.plan_name_ar, s?.plan_name_en)}</div><div className="row"><StatusBadge s={s?.status} /><span className="num">{fmtDate(s?.current_period_end)}</span></div></div>
        {([["users", u.active_users, s?.max_users], [t.companies, u.companies, s?.max_companies], [t.branches, u.branches, s?.max_branches], [t.warehouses, u.warehouses, s?.max_warehouses]] as const).map(([l, used, lim]) => (
          <div className="card kpi" key={l}><div className="label">{l}</div><div className="value num">{used} / {lim}</div>{bar(Number(used), Number(lim))}</div>))}
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
