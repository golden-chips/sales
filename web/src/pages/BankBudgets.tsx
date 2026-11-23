// Bank reconciliation and budgets (K5).
import { useMemo, useState } from "react";
import { CheckCircle2, Wand2 } from "lucide-react";
import { api, fmt, fmtDate } from "../api";
import { useI18n } from "../i18n";
import { useSession } from "../session";
import { Empty, ErrorBox, Field, Loading, Modal, StatusBadge, errMsg, useAsync, useToast } from "../ui";

const today = () => new Date().toISOString().slice(0, 10);

// ================================================================== bank reconciliation
export function BankReconciliation() {
  const { tt } = useI18n();
  const { companyId } = useSession();
  const list = useAsync(() => api.get(`/accounting/bank-statements?companyId=${companyId}`), [companyId]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  return <>
    <div className="page-head"><div><h1>{tt("التسويات البنكية", "Bank reconciliation")}</h1>
      <p>{tt("أدخل كشف المصرف، يطابقه النظام مع الدفتر تلقائيًا، ثم عالج الفروق.", "Enter the bank statement; it is matched to the ledger automatically, then resolve differences.")}</p></div>
      <button className="btn primary" onClick={() => setCreating(true)}>{tt("كشف مصرف جديد", "New bank statement")}</button></div>
    <ErrorBox error={list.error} />
    {list.loading ? <Loading /> : !list.data?.length ? <div className="card"><Empty text={tt("لا توجد كشوفات بعد", "No statements yet")} /></div> :
      <div className="table-wrap"><table><thead><tr><th>{tt("التاريخ", "Date")}</th><th>{tt("الحساب", "Account")}</th><th className="end">{tt("الرصيد الختامي", "Closing")}</th>
        <th>{tt("الأسطر", "Lines")}</th><th>{tt("غير مطابق", "Unmatched")}</th><th>{tt("الحالة", "Status")}</th></tr></thead>
        <tbody>{list.data.map((s: any) => <tr key={s.id} style={{ cursor: "pointer" }} onClick={() => setOpenId(s.id)}><td className="num">{fmtDate(s.statement_date)}</td>
          <td><span className="num">{s.account_code}</span> {s.account_name}</td><td className="end num">{fmt(s.closing_balance)}</td><td className="num">{s.lines}</td>
          <td>{s.unmatched ? <span className="badge warn num">{s.unmatched}</span> : <span className="badge ok">0</span>}</td>
          <td>{s.status === "reconciled" ? <span className="badge ok">{tt("مسوّى", "Reconciled")}</span> : <span className="badge warn">{tt("مفتوح", "Open")}</span>}</td></tr>)}</tbody></table></div>}
    {creating && <StatementEditor onClose={() => setCreating(false)} onSaved={(id) => { setCreating(false); list.reload(); setOpenId(id); }} />}
    {openId && <StatementView id={openId} onClose={() => { setOpenId(null); list.reload(); }} />}
  </>;
}

function StatementEditor({ onClose, onSaved }: { onClose: () => void; onSaved: (id: string) => void }) {
  const { t, tt } = useI18n();
  const { companyId } = useSession();
  const accounts = useAsync(() => api.get(`/accounting/accounts?companyId=${companyId}&postableOnly=true`), [companyId]);
  const banks = (accounts.data ?? []).filter((a: any) => a.type === "asset" && ["bank_main", "cash_main", "pos_cash"].includes(a.role) || /^11[12]/.test(a.code));
  const [h, setH] = useState({ accountId: "", statementDate: today(), reference: "", openingBalance: "0", closingBalance: "" });
  const [paste, setPaste] = useState("");
  const [err, setErr] = useState<unknown>(null);
  // lines pasted from Excel / the bank's file: date ⇥ description ⇥ amount (+ in, − out)
  const lines = useMemo(() => paste.split(/\r?\n/).map((r) => r.split(/\t|;|,(?=\s*-?\d)/).map((x) => x.trim())).filter((c) => c.length >= 3 && c[0])
    .map((c) => ({ txnDate: c[0].replace(/\//g, "-").replace(/^(\d{2})-(\d{2})-(\d{4})$/, "$3-$2-$1"), description: c[1], amount: c[c.length - 1].replace(/,/g, "") })), [paste]);
  const sum = lines.reduce((x, l) => x + (Number(l.amount) || 0), 0);
  const expected = Math.round((Number(h.openingBalance || 0) + sum) * 1000) / 1000;
  const save = async () => {
    setErr(null);
    try { const r = await api.post("/accounting/bank-statements", { companyId, ...h, reference: h.reference || undefined, closingBalance: h.closingBalance || String(expected), lines }); onSaved(r.id); }
    catch (e) { setErr(e); }
  };
  return <Modal wide title={tt("كشف مصرف جديد", "New bank statement")} onClose={onClose}
    footer={<><button className="btn" onClick={onClose}>{t.cancel}</button><button className="btn primary" disabled={!h.accountId || !lines.length} onClick={save}>{tt("حفظ ومطابقة", "Save & match")}</button></>}>
    <ErrorBox error={err} />
    <div className="form-grid">
      <Field label={tt("حساب المصرف", "Bank account")}><select value={h.accountId} onChange={(e) => setH({ ...h, accountId: e.target.value })}><option value="">—</option>
        {banks.map((a: any) => <option key={a.id} value={a.id}>{a.code} — {a.name_ar}</option>)}</select></Field>
      <Field label={tt("تاريخ الكشف", "Statement date")}><input type="date" value={h.statementDate} onChange={(e) => setH({ ...h, statementDate: e.target.value })} /></Field>
      <Field label={tt("الرصيد الافتتاحي في الكشف", "Opening balance")}><input className="num" value={h.openingBalance} onChange={(e) => setH({ ...h, openingBalance: e.target.value })} /></Field>
      <Field label={tt("الرصيد الختامي في الكشف", "Closing balance")}><input className="num" value={h.closingBalance} placeholder={String(expected)} onChange={(e) => setH({ ...h, closingBalance: e.target.value })} /></Field>
    </div>
    <Field label={tt("حركات الكشف — الصقها من Excel: التاريخ ⇥ البيان ⇥ المبلغ (موجب للإيداع، سالب للسحب)", "Statement lines — paste from Excel: date ⇥ description ⇥ amount (+ in, − out)")}>
      <textarea rows={7} dir="ltr" value={paste} onChange={(e) => setPaste(e.target.value)} placeholder={"2026-03-03\tإيداع نقدي\t500\n2026-03-06\tصرف شيك 1021\t-120"} /></Field>
    <div className="row" style={{ marginTop: 8 }}><span>{tt("عدد الأسطر", "Lines")}: <b className="num">{lines.length}</b></span><span>{tt("صافي الحركات", "Net movement")}: <b className="num">{fmt(sum.toFixed(3))}</b></span>
      <span>{tt("الختامي المحسوب", "Computed closing")}: <b className="num">{fmt(expected.toFixed(3))}</b></span>
      {h.closingBalance && Math.abs(Number(h.closingBalance) - expected) > 0.0005 && <span className="badge bad">{tt("لا يطابق الختامي المُدخل", "Does not match the closing entered")}</span>}</div>
  </Modal>;
}

function StatementView({ id, onClose }: { id: string; onClose: () => void }) {
  const { tt, lang } = useI18n();
  const { companyId } = useSession();
  const { toast } = useToast();
  const s = useAsync(() => api.get(`/accounting/bank-statements/${id}`), [id]);
  const accounts = useAsync(() => api.get(`/accounting/accounts?companyId=${companyId}&postableOnly=true`), [companyId]);
  const [adjusting, setAdjusting] = useState<any | null>(null);
  const [adjAcc, setAdjAcc] = useState("");
  const run = async (fn: () => Promise<unknown>, msg: string) => { try { await fn(); toast(msg); s.reload(); } catch (e) { toast(errMsg(e, lang), true); } };
  const d = s.data;
  const open = d?.status === "open";
  return <Modal wide title={d ? `${tt("كشف", "Statement")} ${d.account_code} — ${fmtDate(d.statement_date)}` : "…"} onClose={onClose}
    footer={d && open ? <><button className="btn" onClick={() => run(() => api.post(`/accounting/bank-statements/${id}/auto-match`), tt("تمت المطابقة التلقائية", "Auto-matched"))}><Wand2 size={16} />{tt("مطابقة تلقائية", "Auto-match")}</button>
      <button className="btn primary" disabled={!d.canReconcile} onClick={() => run(() => api.post(`/accounting/bank-statements/${id}/reconcile`), tt("تمت التسوية", "Reconciled"))}><CheckCircle2 size={16} />{tt("إتمام التسوية", "Finish reconciliation")}</button></> : undefined}>
    {s.loading ? <Loading /> : d && <div className="grid" style={{ gap: 14 }}>
      <div className="grid kpis">
        <div className="card kpi"><div className="label">{tt("رصيد الدفتر", "Ledger balance")}</div><div className="value num">{fmt(d.glBalance)}</div></div>
        <div className="card kpi"><div className="label">{tt("حركات لم تظهر في المصرف بعد", "Not yet at the bank")}</div><div className="value num">{fmt(d.unclearedTotal)}</div></div>
        <div className="card kpi"><div className="label">{tt("الرصيد في كشف المصرف", "Bank statement balance")}</div><div className="value num">{fmt(d.closing_balance)}</div></div>
        <div className="card kpi"><div className="label">{tt("الفرق", "Difference")}</div><div className="value num" style={{ color: Number(d.difference) ? "var(--bad)" : "var(--ok)" }}>{fmt(d.difference)}</div>
          {d.status === "reconciled" && <span className="badge ok">{tt("مسوّى", "Reconciled")}</span>}</div>
      </div>
      <p style={{ margin: 0, color: "var(--muted)" }}>{tt(`بداية التسوية لهذا الحساب: ${fmtDate(d.reconciliationStart)} — حركات الدفتر قبلها داخلة في الرصيد الافتتاحي للكشف الأول. الرصيد المتوقع في المصرف: `,
        `Reconciliation starts ${fmtDate(d.reconciliationStart)} — older ledger items are inside the first statement's opening balance. Expected bank balance: `)}<b className="num">{fmt(d.expectedClosing)}</b></p>
      <h3 style={{ margin: 0 }}>{tt("حركات كشف المصرف", "Bank statement lines")}</h3>
      <div className="table-wrap"><table><thead><tr><th>{tt("التاريخ", "Date")}</th><th>{tt("البيان", "Description")}</th><th className="end">{tt("المبلغ", "Amount")}</th><th>{tt("المطابقة", "Match")}</th><th /></tr></thead>
        <tbody>{d.lines.map((l: any) => <tr key={l.id}><td className="num">{fmtDate(l.txn_date)}</td><td>{l.description}</td><td className="end num" style={{ color: Number(l.amount) < 0 ? "var(--bad)" : undefined }}>{fmt(l.amount)}</td>
          <td>{l.journal_line_id ? <span className="badge ok">{tt("مطابق", "Matched")} · <span className="num">{l.matched_entry}</span></span>
            : l.draft_entry_id ? <span className="badge warn">{tt("قيد تسوية مسودة — ينتظر الترحيل", "Adjusting entry waiting to be posted")}</span>
            : <span className="badge bad">{tt("غير مطابق", "Unmatched")}</span>}</td>
          <td>{open && (l.journal_line_id
            ? <button className="btn sm" onClick={() => run(() => api.post(`/accounting/bank-statement-lines/${l.id}/match`, { journalLineId: null }), tt("أُلغيت المطابقة", "Unmatched"))}>{tt("فك", "Unmatch")}</button>
            : <>{d.uncleared.filter((u: any) => Number(u.amount) === Number(l.amount)).slice(0, 3).map((u: any) =>
                <button key={u.id} className="btn sm" onClick={() => run(() => api.post(`/accounting/bank-statement-lines/${l.id}/match`, { journalLineId: u.id }), tt("تمت المطابقة", "Matched"))}>
                  {tt("طابق مع", "Match")} <span className="num">{u.number}</span></button>)}
              {!l.draft_entry_id && <button className="btn sm" onClick={() => { setAdjusting(l); setAdjAcc(""); }}>{tt("قيد تسوية (عمولة/فوائد)", "Adjusting entry")}</button>}</>)}</td></tr>)}</tbody></table></div>
      {d.uncleared.length > 0 && <>
        <h3 style={{ margin: 0 }}>{tt("حركات في الدفتر لم تظهر في كشف المصرف بعد", "Ledger items not yet at the bank")}</h3>
        <p style={{ margin: 0, color: "var(--muted)" }}>{tt("مثل شيكات لم تُصرف بعد أو إيداعات في الطريق — تبقى مفتوحة وتُطابق في كشف لاحق.", "e.g. cheques not cashed yet or deposits in transit — matched on a later statement.")}</p>
        <div className="table-wrap"><table><thead><tr><th>{tt("التاريخ", "Date")}</th><th>{tt("القيد", "Entry")}</th><th>{tt("البيان", "Description")}</th><th className="end">{tt("المبلغ", "Amount")}</th></tr></thead>
          <tbody>{d.uncleared.map((u: any) => <tr key={u.id}><td className="num">{fmtDate(u.entry_date)}</td><td className="num">{u.number}</td><td>{u.description}</td><td className="end num">{fmt(u.amount)}</td></tr>)}</tbody></table></div></>}
    </div>}
    {adjusting && <Modal title={tt("قيد تسوية لحركة في المصرف فقط", "Adjusting entry for a bank-only item")} onClose={() => setAdjusting(null)}
      footer={<><button className="btn" onClick={() => setAdjusting(null)}>{tt("إلغاء", "Cancel")}</button><button className="btn primary" disabled={!adjAcc}
        onClick={() => { run(() => api.post(`/accounting/bank-statement-lines/${adjusting.id}/adjust`, { accountId: adjAcc, memo: adjusting.description }), tt("أُنشئ قيد مسودة — يرحّله زميل ثم اضغط «مطابقة تلقائية»", "Draft entry created — a colleague posts it, then auto-match")); setAdjusting(null); }}>{tt("إنشاء قيد مسودة", "Create draft entry")}</button></>}>
      <p>{adjusting.description} · <b className="num">{fmt(adjusting.amount)}</b></p>
      <Field label={tt("الحساب المقابل (مثل عمولات مصرفية أو فوائد)", "Other account (e.g. bank charges, interest)")}><select value={adjAcc} onChange={(e) => setAdjAcc(e.target.value)}><option value="">—</option>
        {(accounts.data ?? []).filter((a: any) => !["ar", "ap"].includes(a.role) && a.id !== d?.account_id).map((a: any) => <option key={a.id} value={a.id}>{a.code} — {a.name_ar}</option>)}</select></Field>
    </Modal>}
  </Modal>;
}

// ================================================================== budgets
export function Budgets() {
  const { tt, lang } = useI18n();
  const { companyId, can } = useSession();
  const { toast } = useToast();
  const list = useAsync(() => api.get(`/accounting/budgets?companyId=${companyId}`), [companyId]);
  const years = useAsync(() => api.get(`/accounting/fiscal-years?companyId=${companyId}`), [companyId]);
  const [creating, setCreating] = useState(false);
  const [f, setF] = useState({ name: tt("الموازنة الأساسية", "Main budget"), fiscalYearId: "", copyActualFromYearId: "", growthPct: "10" });
  const [openId, setOpenId] = useState<string | null>(null);
  const create = async () => {
    try {
      const r = await api.post("/accounting/budgets", { companyId, name: f.name, fiscalYearId: f.fiscalYearId || years.data?.[0]?.id,
        ...(f.copyActualFromYearId ? { copyActualFromYearId: f.copyActualFromYearId, growthPct: Number(f.growthPct || 0) } : {}) });
      setCreating(false); list.reload(); setOpenId(r.id);
    } catch (e) { toast(errMsg(e, lang), true); }
  };
  return <>
    <div className="page-head"><div><h1>{tt("الموازنات التقديرية", "Budgets")}</h1><p>{tt("خطط الإيرادات والمصروفات شهريًا وقارنها بالفعلي.", "Plan revenue and expenses by month and compare with actuals.")}</p></div>
      {can("accounting.budgets.manage") && <button className="btn primary" onClick={() => setCreating(true)}>{tt("موازنة جديدة", "New budget")}</button>}</div>
    <ErrorBox error={list.error} />
    {list.loading ? <Loading /> : !list.data?.length ? <div className="card"><Empty text={tt("لا توجد موازنات بعد", "No budgets yet")} /></div> :
      <div className="table-wrap"><table><thead><tr><th>{tt("الاسم", "Name")}</th><th>{tt("السنة", "Year")}</th><th className="end">{tt("الإجمالي", "Total")}</th><th>{tt("الحالة", "Status")}</th></tr></thead>
        <tbody>{list.data.map((b: any) => <tr key={b.id} style={{ cursor: "pointer" }} onClick={() => setOpenId(b.id)}><td>{b.name}</td><td>{b.year_name}</td><td className="end num">{fmt(b.total)}</td>
          <td>{b.status === "approved" ? <span className="badge ok">{tt("معتمدة", "Approved")}</span> : <StatusBadge s="draft" />}</td></tr>)}</tbody></table></div>}
    {creating && <Modal title={tt("موازنة جديدة", "New budget")} onClose={() => setCreating(false)} footer={<><button className="btn" onClick={() => setCreating(false)}>{tt("إلغاء", "Cancel")}</button><button className="btn primary" onClick={create}>{tt("إنشاء", "Create")}</button></>}>
      <div className="form-grid">
        <Field label={tt("الاسم", "Name")}><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label={tt("السنة المالية", "Fiscal year")}><select value={f.fiscalYearId} onChange={(e) => setF({ ...f, fiscalYearId: e.target.value })}>{(years.data ?? []).map((y: any) => <option key={y.id} value={y.id}>{y.name}</option>)}</select></Field>
        <Field label={tt("ابدأ من فعلي سنة سابقة (اختياري)", "Start from a past year's actuals (optional)")}><select value={f.copyActualFromYearId} onChange={(e) => setF({ ...f, copyActualFromYearId: e.target.value })}>
          <option value="">{tt("لا — موازنة فارغة", "No — empty budget")}</option>{(years.data ?? []).map((y: any) => <option key={y.id} value={y.id}>{y.name}</option>)}</select></Field>
        {f.copyActualFromYearId && <Field label={tt("نسبة النمو %", "Growth %")}><input className="num" value={f.growthPct} onChange={(e) => setF({ ...f, growthPct: e.target.value })} /></Field>}
      </div>
    </Modal>}
    {openId && <BudgetView id={openId} onClose={() => { setOpenId(null); list.reload(); }} />}
  </>;
}

function BudgetView({ id, onClose }: { id: string; onClose: () => void }) {
  const { tt, lang } = useI18n();
  const { companyId, can } = useSession();
  const { toast } = useToast();
  const b = useAsync(() => api.get(`/accounting/budgets/${id}`), [id]);
  const vs = useAsync(() => api.get(`/accounting/budgets/${id}/vs-actual?asOf=${today()}`), [id]);
  const accounts = useAsync(() => api.get(`/accounting/accounts?companyId=${companyId}&postableOnly=true`), [companyId]);
  const [tab, setTab] = useState<"plan" | "actual">("actual");
  const [rows, setRows] = useState<any[] | null>(null);
  const [add, setAdd] = useState("");
  const data = rows ?? b.data?.lines?.map((l: any) => ({ accountId: l.account_id, code: l.code, name: l.name_ar, amounts: l.amounts.map((x: string) => String(Number(x))) })) ?? [];
  const draft = b.data?.status === "draft";
  const months = Array.from({ length: 12 }, (_, i) => i + 1);
  const set = (i: number, m: number, v: string) => setRows(data.map((r: any, j: number) => j === i ? { ...r, amounts: r.amounts.map((x: string, k: number) => k === m ? v : x) } : r));
  const spread = (i: number) => { const total = Number(prompt0(data[i])); setRows(data.map((r: any, j: number) => j === i ? { ...r, amounts: Array(12).fill((Math.round(total / 12 * 1000) / 1000).toString()) } : r)); };
  const prompt0 = (r: any) => r.amounts.reduce((x: number, v: string) => x + (Number(v) || 0), 0);
  const save = async () => { try { await api.put(`/accounting/budgets/${id}/lines`, { lines: data.map((r: any) => ({ accountId: r.accountId, amounts: r.amounts.map((x: string) => x || "0") })) }); toast(tt("حُفظت الموازنة", "Saved")); setRows(null); b.reload(); vs.reload(); } catch (e) { toast(errMsg(e, lang), true); } };
  const approve = async () => { try { await api.post(`/accounting/budgets/${id}/approve`); toast(tt("اعتُمدت الموازنة", "Approved")); b.reload(); } catch (e) { toast(errMsg(e, lang), true); } };
  const pl = (accounts.data ?? []).filter((a: any) => ["revenue", "expense"].includes(a.type) && !data.some((r: any) => r.accountId === a.id));
  return <Modal wide title={b.data ? `${b.data.name} — ${b.data.year_name}` : "…"} onClose={onClose}
    footer={b.data && <>{draft && can("accounting.budgets.manage") && <button className="btn" disabled={!rows} onClick={save}>{tt("حفظ", "Save")}</button>}
      {draft && can("accounting.budgets.approve") && <button className="btn primary" onClick={approve}>{tt("اعتماد", "Approve")}</button>}</>}>
    <div className="seg" style={{ marginBottom: 12 }}><button className={tab === "actual" ? "on" : ""} onClick={() => setTab("actual")}>{tt("الموازنة مقابل الفعلي", "Budget vs actual")}</button>
      <button className={tab === "plan" ? "on" : ""} onClick={() => setTab("plan")}>{tt("المبالغ الشهرية", "Monthly amounts")}</button></div>
    {tab === "actual" ? (vs.loading ? <Loading /> : <div className="table-wrap"><table>
      <thead><tr><th>{tt("الحساب", "Account")}</th><th className="end">{tt("موازنة حتى اليوم", "Budget YTD")}</th><th className="end">{tt("الفعلي حتى اليوم", "Actual YTD")}</th><th className="end">{tt("الفرق", "Variance")}</th><th className="end">%</th><th className="end">{tt("موازنة السنة", "Year budget")}</th></tr></thead>
      <tbody>{(vs.data?.rows ?? []).map((r: any) => <tr key={`${r.account_id}${r.cost_center_id ?? ""}`}><td><span className="num">{r.code}</span> {r.name_ar}{r.cost_center_code ? ` · ${r.cost_center_code}` : ""}</td>
        <td className="end num">{fmt(r.budget_ytd)}</td><td className="end num">{fmt(r.actual_ytd)}</td>
        <td className="end num" style={{ color: r.favourable ? "var(--ok)" : "var(--bad)" }}>{fmt(r.variance)}</td><td className="end num" style={{ color: r.favourable ? "var(--ok)" : "var(--bad)" }}>{r.variance_pct ?? "—"}</td>
        <td className="end num">{fmt(r.budget_year)}</td></tr>)}</tbody></table></div>)
    : <>
      <div className="table-wrap"><table><thead><tr><th>{tt("الحساب", "Account")}</th>{months.map((m) => <th key={m} className="end num">{m}</th>)}<th className="end">{tt("السنة", "Year")}</th>{draft && <th />}</tr></thead>
        <tbody>{data.map((r: any, i: number) => <tr key={r.accountId}><td style={{ whiteSpace: "nowrap" }}><span className="num">{r.code}</span> {r.name}</td>
          {months.map((m) => <td key={m}>{draft ? <input className="num" style={{ width: 70, minHeight: 32, padding: "4px 6px" }} value={r.amounts[m - 1]} onChange={(e) => set(i, m - 1, e.target.value)} /> : <span className="num">{fmt(r.amounts[m - 1])}</span>}</td>)}
          <td className="end num"><b>{fmt(String(prompt0(r)))}</b></td>
          {draft && <td><button className="btn sm" title={tt("وزّع الإجمالي بالتساوي على الأشهر", "Spread the total evenly")} onClick={() => spread(i)}>÷12</button></td>}</tr>)}</tbody></table></div>
      {draft && <div className="row" style={{ marginTop: 10 }}><select value={add} onChange={(e) => setAdd(e.target.value)} style={{ maxWidth: 360 }}><option value="">{tt("أضف حساب إيراد أو مصروف…", "Add a revenue or expense account…")}</option>
        {pl.map((a: any) => <option key={a.id} value={a.id}>{a.code} — {a.name_ar}</option>)}</select>
        <button className="btn" disabled={!add} onClick={() => { const a = pl.find((x: any) => x.id === add); setRows([...data, { accountId: a.id, code: a.code, name: a.name_ar, amounts: Array(12).fill("0") }]); setAdd(""); }}>{tt("إضافة", "Add")}</button></div>}
    </>}
  </Modal>;
}
