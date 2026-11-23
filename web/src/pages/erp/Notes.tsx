// Customer credit notes (discount after the sale) and supplier debit notes (discount / settlement from the supplier).
import { useState } from "react";
import { api, fmt } from "../../api";
import { useI18n } from "../../i18n";
import { useSession } from "../../session";
import { ErrorBox, Field, Modal, useAsync } from "../../ui";
import { DocList, date, money, today } from "./shared";

type Kind = "customer" | "supplier";
const cfg = {
  customer: { path: "/sales/credit-notes", create: "sales.notes.create", post: "sales.notes.post", invoices: "/sales/invoices" },
  supplier: { path: "/purchasing/debit-notes", create: "purchasing.notes.create", post: "purchasing.notes.post", invoices: "/purchasing/invoices" },
};

function NotesPage({ kind }: { kind: Kind }) {
  const { t, tt } = useI18n();
  const [editor, setEditor] = useState(false);
  const [k, setK] = useState(0);
  const c = cfg[kind];
  return <>
    <DocList path={c.path} reloadKey={k} createPerm={c.create} postPerm={c.post} onNew={() => setEditor(true)}
      title={kind === "customer" ? tt("الإشعارات الدائنة للعملاء", "Customer credit notes") : tt("الإشعارات المدينة للموردين", "Supplier debit notes")}
      newLabel={kind === "customer" ? tt("إشعار دائن جديد", "New credit note") : tt("إشعار مدين جديد", "New debit note")}
      columns={[{ h: t.date, v: (r) => date(r.note_date) }, { h: kind === "customer" ? tt("العميل", "Customer") : tt("المورد", "Supplier"), v: (r) => r.party_name_ar },
        { h: t.reason, v: (r) => r.reason }, { h: t.amount, v: (r) => money(r.amount), end: true }]}
      renderDetail={(d) => <div className="grid" style={{ gap: 6 }}>
        <div className="row"><b>{d.party_code} {d.party_name_ar}</b><span className="badge">{tt("على الفاتورة", "On invoice")} {d.invoice_number}</span></div>
        <div>{tt("المبلغ", "Amount")}: <b className="num">{money(d.amount)}</b></div>
        <div>{tt("الحساب المقابل", "Other account")}: <span className="num">{d.account_code}</span> {d.account_name}</div>
        <div>{t.reason}: {d.reason}</div>
      </div>} />
    {editor && <NoteEditor kind={kind} onClose={() => setEditor(false)} onSaved={() => { setEditor(false); setK(k + 1); }} />}
  </>;
}

function NoteEditor({ kind, onClose, onSaved }: { kind: Kind; onClose: () => void; onSaved: () => void }) {
  const { t, tt } = useI18n();
  const { companyId } = useSession();
  const c = cfg[kind];
  const invoices = useAsync(() => api.get(`${c.invoices}?companyId=${companyId}&status=posted&pageSize=200`), [companyId]);
  const accounts = useAsync(() => api.get(`/accounting/accounts?companyId=${companyId}&postableOnly=true`), [companyId]);
  const [key] = useState(() => crypto.randomUUID());
  const [f, setF] = useState({ invoiceId: "", amount: "", reason: "", accountId: "", noteDate: today() });
  const [err, setErr] = useState<unknown>(null);
  const openOf = (i: any) => Number(i.total) - Number(i.amount_paid) - Number(kind === "customer" ? i.amount_returned : 0);
  const open = (invoices.data?.data ?? []).filter((i: any) => openOf(i) > 0.0005 && (kind === "supplier" || i.payment_type === "credit"));
  const sel = open.find((i: any) => i.id === f.invoiceId);
  const accts = (accounts.data ?? []).filter((a: any) => !["ar", "ap"].includes(a.role));
  const save = async () => {
    setErr(null);
    try { await api.post(c.path, { invoiceId: f.invoiceId, noteDate: f.noteDate, amount: f.amount, reason: f.reason, accountId: f.accountId || undefined }, { idempotencyKey: key }); onSaved(); }
    catch (e) { setErr(e); }
  };
  return <Modal title={kind === "customer" ? tt("إشعار دائن للعميل", "Customer credit note") : tt("إشعار مدين للمورد", "Supplier debit note")} onClose={onClose}
    footer={<><button className="btn" onClick={onClose}>{t.cancel}</button><button className="btn primary" disabled={!f.invoiceId || !f.amount || f.reason.length < 3} onClick={save}>{t.save} ({t.draft})</button></>}>
    <div className="alert info">{kind === "customer"
      ? tt("خصم أو تسوية للعميل بعد البيع بدون إرجاع بضاعة: يُنقص المتبقي على الفاتورة ويُسجَّل في «خصم مسموح به» (أو حساب تختاره). لتحصيل مبلغ إضافي من العميل استعمل فاتورة بصنف خدمة.",
        "A discount after the sale with no goods back: reduces the invoice balance, posted to Sales discounts (or an account you choose). To charge more, issue an invoice with a service item.")
      : tt("خصم أو تعويض من المورد على فاتورته: يُنقص المبلغ المستحق له. اختر الحساب المقابل (مثلًا عجز وزيادة المخزون، أو إيرادات أخرى).",
        "A discount or settlement from the supplier: reduces what you owe. Choose the other account (e.g. stock differences or other income).")}</div>
    <ErrorBox error={err} />
    <div className="form-grid">
      <Field label={tt("الفاتورة", "Invoice")}><select value={f.invoiceId} onChange={(e) => setF({ ...f, invoiceId: e.target.value })}><option value="">—</option>
        {open.map((i: any) => <option key={i.id} value={i.id}>{i.number} · {i.party_name_ar} · {tt("المتبقي", "open")} {fmt(String(openOf(i)))}</option>)}</select></Field>
      <Field label={tt("المبلغ", "Amount")}><input className="num" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} placeholder={sel ? String(openOf(sel)) : ""} /></Field>
      <Field label={t.date}><input type="date" value={f.noteDate} onChange={(e) => setF({ ...f, noteDate: e.target.value })} /></Field>
      <Field label={t.reason}><input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder={kind === "customer" ? tt("مثال: خصم كمية متفق عليه", "e.g. agreed volume discount") : tt("مثال: تعويض عن تلف", "e.g. damage compensation")} /></Field>
      <Field label={kind === "customer" ? tt("الحساب المقابل (اختياري — الافتراضي خصم مسموح به)", "Other account (optional)") : tt("الحساب المقابل", "Other account")}>
        <select value={f.accountId} onChange={(e) => setF({ ...f, accountId: e.target.value })}><option value="">{kind === "customer" ? tt("خصم مسموح به (افتراضي)", "Sales discounts (default)") : "—"}</option>
          {accts.map((a: any) => <option key={a.id} value={a.id}>{a.code} — {a.name_ar}</option>)}</select></Field>
    </div>
  </Modal>;
}

export const CreditNotes = () => <NotesPage kind="customer" />;
export const DebitNotes = () => <NotesPage kind="supplier" />;
