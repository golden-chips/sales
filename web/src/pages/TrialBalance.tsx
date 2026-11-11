import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, fmt, fmtDate } from "../api";
import { useI18n } from "../i18n";
import { useSession } from "../session";
import { Empty, ErrorBox, Loading, useAsync } from "../ui";

function exportCsv(name: string, header: string[], rows: (string | number)[][]) {
  const esc = (v: string | number) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const blob = new Blob(["﻿" + [header, ...rows].map((r) => r.map(esc).join(",")).join("\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click(); URL.revokeObjectURL(a.href);
}

export default function TrialBalance() {
  const { t, pick } = useI18n();
  const { companyId } = useSession();
  const [sp, setSp] = useSearchParams();
  const y = new Date().getFullYear();
  const [range, setRange] = useState({ from: `${y}-01-01`, to: `${y}-12-31` });
  const account = sp.get("account");
  const tb = useAsync(() => api.get(`/accounting/reports/trial-balance?companyId=${companyId}&from=${range.from}&to=${range.to}`), [companyId, range.from, range.to]);
  const fs = useAsync(() => api.get(`/accounting/reports/financial-statements?companyId=${companyId}&from=${range.from}&to=${range.to}`), [companyId, range.from, range.to]);
  const ledger = useAsync(() => (account ? api.get(`/accounting/reports/ledger/${account}?from=${range.from}&to=${range.to}`) : Promise.resolve(null)), [account, range.from, range.to]);
  return (
    <>
      <div className="page-head"><div><h1>{account ? t.ledger : t.trialBalance}</h1><p>{t.drillHint}</p></div>
        <div className="row">
          <label>{t.from}</label><input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} style={{ width: "auto" }} />
          <label>{t.to}</label><input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} style={{ width: "auto" }} />
          {!account && tb.data && <button className="btn" onClick={() => exportCsv(`trial-balance-${range.from}-${range.to}.csv`, [t.code, t.account, t.opening, t.debit, t.credit, t.closing],
            tb.data.rows.map((r: any) => [r.code, pick(r.name_ar, r.name_en), r.opening, r.period_debit, r.period_credit, r.closing]))}>CSV</button>}
          <button className="btn" onClick={() => window.print()}>🖶</button>
          {account && <button className="btn" onClick={() => setSp({})}>← {t.trialBalance}</button>}
        </div></div>
      {account ? (
        ledger.loading ? <Loading /> : <><ErrorBox error={ledger.error} />{ledger.data && (
          <div className="card">
            <h2><span className="num">{ledger.data.account.code}</span> {pick(ledger.data.account.name_ar, ledger.data.account.name_en)}</h2>
            <div className="table-wrap"><table>
              <thead><tr><th>{t.date}</th><th>{t.number}</th><th>{t.memo}</th><th className="end">{t.debit}</th><th className="end">{t.credit}</th><th className="end">{t.balance}</th></tr></thead>
              <tbody>
                <tr><td colSpan={5}>{t.opening}</td><td className="end num">{fmt(ledger.data.opening)}</td></tr>
                {ledger.data.lines.map((l: any) => <tr key={l.entry_id + l.line_no}><td className="num">{fmtDate(l.entry_date)}</td><td className="num"><a href={`/journal?q=${l.number}`}>{l.number}</a></td><td>{l.description || l.memo}</td><td className="end num">{Number(l.debit) ? fmt(l.debit) : ""}</td><td className="end num">{Number(l.credit) ? fmt(l.credit) : ""}</td><td className="end num">{fmt(l.running_balance)}</td></tr>)}
              </tbody>
            </table></div>
          </div>)}</>
      ) : tb.loading ? <Loading /> : (
        <>
          <ErrorBox error={tb.error || fs.error} />
          {fs.data && <div className="grid kpis" style={{ marginBottom: 16 }}>
            <div className="card kpi"><div className="label">Revenue</div><div className="value num">{fmt(fs.data.incomeStatement.revenue)}</div></div>
            <div className="card kpi"><div className="label">Expenses</div><div className="value num">{fmt(fs.data.incomeStatement.expenses)}</div></div>
            <div className="card kpi"><div className="label">Net income</div><div className="value num">{fmt(fs.data.incomeStatement.netIncome)}</div></div>
            <div className="card kpi"><div className="label">Assets = L + E</div><div className="value num">{fmt(fs.data.balanceSheet.assets)}</div><span className={`badge ${fs.data.balanceSheet.balanced ? "ok" : "bad"}`}>{fs.data.balanceSheet.balanced ? t.balanced : t.unbalanced}</span></div>
          </div>}
          {!tb.data?.rows.length ? <div className="card"><Empty /></div> : (
            <div className="table-wrap"><table>
              <thead><tr><th>{t.code}</th><th>{t.account}</th><th className="end">{t.opening}</th><th className="end">{t.debit}</th><th className="end">{t.credit}</th><th className="end">{t.closing}</th></tr></thead>
              <tbody>{tb.data.rows.map((r: any) => <tr key={r.id} style={{ cursor: "pointer" }} onClick={() => setSp({ account: r.id })}><td className="num">{r.code}</td><td>{pick(r.name_ar, r.name_en)}</td><td className="end num">{fmt(r.opening)}</td><td className="end num">{fmt(r.period_debit)}</td><td className="end num">{fmt(r.period_credit)}</td><td className="end num">{fmt(r.closing)}</td></tr>)}</tbody>
              <tfoot><tr><td colSpan={3}>{t.total} <span className={`badge ${tb.data.totals.balanced ? "ok" : "bad"}`}>{tb.data.totals.balanced ? t.balanced : t.unbalanced}</span></td><td className="end num">{fmt(tb.data.totals.debit)}</td><td className="end num">{fmt(tb.data.totals.credit)}</td><td /></tr></tfoot>
            </table></div>
          )}
        </>
      )}
    </>
  );
}
