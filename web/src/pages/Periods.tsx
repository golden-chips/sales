import { useState } from "react";
import { api } from "../api";
import { useI18n } from "../i18n";
import { useSession } from "../session";
import { Empty, ErrorBox, Loading, StatusBadge, errMsg, useAsync, useToast } from "../ui";

export default function Periods() {
  const { t, lang } = useI18n();
  const { can, companyId } = useSession();
  const { toast, confirm } = useToast();
  const years = useAsync(() => api.get(`/accounting/fiscal-years?companyId=${companyId}`), [companyId]);
  const [start, setStart] = useState(`${new Date().getFullYear() + 1}-01-01`);
  const manage = can("accounting.periods.manage");
  const run = async (fn: () => Promise<unknown>) => { try { await fn(); toast(t.savedOk); years.reload(); } catch (e) { toast(errMsg(e, lang), true); } };
  if (years.loading) return <Loading />;
  return (
    <>
      <div className="page-head"><h1>{t.periods}</h1>
        {manage && <div className="row"><input type="date" value={start} onChange={(e) => setStart(e.target.value)} style={{ width: "auto" }} />
          <button className="btn primary" onClick={() => run(() => api.post("/accounting/fiscal-years", { companyId, name: `FY${start.slice(0, 4)}`, startDate: start }))}>{t.create}</button></div>}
      </div>
      <ErrorBox error={years.error} />
      {!years.data?.length ? <div className="card"><Empty /></div> : years.data.map((fy: any) => (
        <div className="card" key={fy.id} style={{ marginBottom: 16 }}>
          <div className="row"><h2>{fy.name}</h2><StatusBadge s={fy.status} /><span className="num" style={{ color: "var(--muted)" }}>{fy.start_date} → {fy.end_date}</span></div>
          <div className="table-wrap"><table>
            <thead><tr><th>#</th><th>{t.from}</th><th>{t.to}</th><th>{t.status}</th>{manage && <th>{t.actions}</th>}</tr></thead>
            <tbody>{fy.periods.map((p: any) => (
              <tr key={p.id}><td className="num">{p.period_no}</td><td className="num">{p.start_date}</td><td className="num">{p.end_date}</td><td><StatusBadge s={p.status} /></td>
                {manage && <td>{p.status === "open"
                  ? <button className="btn sm" onClick={async () => (await confirm(`${t.closePeriod} ${p.start_date.slice(0, 7)}?`)) && run(() => api.post(`/accounting/periods/${p.id}/close`))}>{t.closePeriod}</button>
                  : <button className="btn sm" onClick={() => { const reason = prompt(t.reason); if (reason) run(() => api.post(`/accounting/periods/${p.id}/reopen`, { reason })); }}>{t.reopenPeriod}</button>}</td>}
              </tr>))}</tbody>
          </table></div>
        </div>
      ))}
    </>
  );
}
