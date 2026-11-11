import { useState } from "react";
import { api, fmt } from "../../api";
import { useI18n } from "../../i18n";
import { useSession } from "../../session";
import { ErrorBox, Field, Modal, errMsg, useAsync, useToast } from "../../ui";
import { DocList, LinesTable, date, money, today, useLookups } from "./shared";

export default function SalesInvoices() {
  const { t, tt } = useI18n();
  const [editor, setEditor] = useState(false);
  const [ret, setRet] = useState<any | null>(null);
  const [k, setK] = useState(0);
  return (
    <>
      <DocList path="/sales/invoices" title={tt("فواتير المبيعات", "Sales invoices")} newLabel={tt("فاتورة جديدة", "New invoice")} onNew={() => setEditor(true)} reloadKey={k}
        createPerm="sales.invoices.create" postPerm="sales.invoices.post"
        columns={[{ h: t.date, v: (r) => date(r.invoice_date) }, { h: tt("العميل", "Customer"), v: (r) => r.party_name_ar }, { h: tt("الدفع", "Payment"), v: (r) => r.payment_type === "cash" ? tt("نقدي", "Cash") : tt("آجل", "Credit") },
          { h: t.total, v: (r) => money(r.total), end: true }, { h: tt("المتبقي", "Open"), v: (r) => money(Number(r.total) - Number(r.amount_paid) - Number(r.amount_returned)), end: true }]}
        renderDetail={(d) => <>
          <div className="row"><b>{d.customer_name_ar}</b><span className="num">{d.invoice_date}</span>{d.due_date && <span className="badge">{tt("الاستحقاق", "Due")} {d.due_date}</span>}<span className="badge">{d.warehouse_code}</span></div>
          <LinesTable rows={d.lines} cols={[{ h: tt("الصنف", "Item"), v: (l) => `${l.item_code} ${l.item_name_ar}` }, { h: tt("الكمية", "Qty"), v: (l) => `${Number(l.qty)} ${l.uom_code}` },
            { h: tt("السعر", "Price"), v: (l) => money(l.unit_price), end: true }, { h: tt("خصم%", "Disc%"), v: (l) => Number(l.discount_pct) }, { h: tt("التشغيلة", "Lot"), v: (l) => l.lot_no ?? "" },
            { h: t.total, v: (l) => money(l.line_total), end: true }, { h: tt("التكلفة", "Cost"), v: (l) => l.cost_amount ? money(l.cost_amount) : "", end: true }]} />
          <div className="balance-bar"><span>{tt("الإجمالي قبل الخصم", "Gross")} <b className="num">{fmt(d.subtotal)}</b></span><span>{tt("الخصم", "Discount")} <b className="num">{fmt(d.discount_total)}</b></span>
            <span>{tt("الضريبة", "Tax")} <b className="num">{fmt(d.tax_total)}</b></span><span>{t.total} <b className="num">{fmt(d.total)}</b></span>
            {d.status === "posted" && <span>{tt("الربح الإجمالي", "Gross margin")} <b className="num">{fmt(Number(d.total) - Number(d.tax_total) - Number(d.cogs_total))}</b></span>}</div>
          {d.status === "posted" && <button className="btn" onClick={() => setRet(d)}>{tt("مرتجع من هذه الفاتورة", "Return from this invoice")}</button>}
        </>} />
      {editor && <InvoiceEditor onClose={() => setEditor(false)} onSaved={() => { setEditor(false); setK(k + 1); }} />}
      {ret && <ReturnEditor invoice={ret} onClose={() => setRet(null)} />}
    </>
  );
}

function InvoiceEditor({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { t, tt } = useI18n();
  const { companyId } = useSession();
  const { items, warehouses } = useLookups();
  const customers = useAsync(() => api.get(`/customers?companyId=${companyId}&pageSize=200&active=true`), [companyId]);
  const [key] = useState(() => crypto.randomUUID());
  const [h, setH] = useState({ customerId: "", warehouseId: "", invoiceDate: today(), paymentType: "credit" });
  const [lines, setLines] = useState<any[]>([{ itemId: "", uomId: "", qty: "1", unitPrice: "", discountPct: "" }]);
  const [err, setErr] = useState<unknown>(null);
  const set = (i: number, p: any) => setLines(lines.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const sellable = warehouses.filter((w: any) => w.is_sellable);
  const save = async () => {
    setErr(null);
    try {
      await api.post("/sales/invoices", { companyId, ...h, warehouseId: h.warehouseId || sellable[0]?.id,
        lines: lines.filter((l) => l.itemId).map((l) => ({ itemId: l.itemId, uomId: l.uomId || null, qty: l.qty, ...(l.unitPrice ? { unitPrice: l.unitPrice } : {}), ...(l.discountPct ? { discountPct: l.discountPct } : {}) })) },
        { idempotencyKey: key });
      onSaved();
    } catch (e) { setErr(e); }
  };
  return (
    <Modal title={tt("فاتورة مبيعات جديدة", "New sales invoice")} onClose={onClose} footer={<><button className="btn" onClick={onClose}>{t.cancel}</button><button className="btn primary" onClick={save}>{t.save} ({t.draft})</button></>}>
      <ErrorBox error={err} />
      <div className="form-grid" style={{ marginBottom: 12 }}>
        <Field label={tt("العميل", "Customer")}><select value={h.customerId} onChange={(e) => setH({ ...h, customerId: e.target.value })}><option value="">—</option>{customers.data?.data.map((c: any) => <option key={c.id} value={c.id}>{c.code} {c.name_ar}</option>)}</select></Field>
        <Field label={t.warehouse}><select value={h.warehouseId} onChange={(e) => setH({ ...h, warehouseId: e.target.value })}>{sellable.map((w: any) => <option key={w.id} value={w.id}>{w.code} {w.name_ar}</option>)}</select></Field>
        <Field label={t.date}><input type="date" value={h.invoiceDate} onChange={(e) => setH({ ...h, invoiceDate: e.target.value })} /></Field>
        <Field label={tt("الدفع", "Payment")}><select value={h.paymentType} onChange={(e) => setH({ ...h, paymentType: e.target.value })}><option value="credit">{tt("آجل", "Credit")}</option><option value="cash">{tt("نقدي", "Cash")}</option></select></Field>
      </div>
      <div className="table-wrap"><table>
        <thead><tr><th>{tt("الصنف", "Item")}</th><th>{tt("الوحدة", "Unit")}</th><th>{tt("الكمية", "Qty")}</th><th>{tt("السعر (فارغ = قائمة/خاص)", "Price (empty = list)")}</th><th>{tt("خصم%", "Disc%")}</th><th /></tr></thead>
        <tbody>{lines.map((l, i) => {
          const item = items.find((x: any) => x.id === l.itemId);
          return <tr key={i}>
            <td style={{ minWidth: 200 }}><select value={l.itemId} onChange={(e) => set(i, { itemId: e.target.value, uomId: "" })}><option value="">—</option>{items.filter((x: any) => x.kind === "finished" || x.kind === "service" || x.kind === "semi_finished").map((x: any) => <option key={x.id} value={x.id}>{x.code} {x.name_ar}</option>)}</select></td>
            <td><select value={l.uomId} onChange={(e) => set(i, { uomId: e.target.value })}><option value="">{item?.base_uom_code ?? "—"}</option>{item?.units.map((u: any) => <option key={u.uomId} value={u.uomId}>{u.code} ×{Number(u.factor)}</option>)}</select></td>
            <td><input className="num" value={l.qty} onChange={(e) => set(i, { qty: e.target.value })} style={{ width: 80 }} /></td>
            <td><input className="num" value={l.unitPrice} onChange={(e) => set(i, { unitPrice: e.target.value })} style={{ width: 110 }} placeholder={item?.sales_price ? fmt(item.sales_price) : ""} /></td>
            <td><input className="num" value={l.discountPct} onChange={(e) => set(i, { discountPct: e.target.value })} style={{ width: 70 }} /></td>
            <td>{lines.length > 1 && <button className="btn sm" onClick={() => setLines(lines.filter((_, j) => j !== i))}>✕</button>}</td>
          </tr>;
        })}</tbody>
      </table></div>
      <button className="btn sm" style={{ marginTop: 8 }} onClick={() => setLines([...lines, { itemId: "", uomId: "", qty: "1", unitPrice: "", discountPct: "" }])}>+ {t.addLine}</button>
    </Modal>
  );
}

function ReturnEditor({ invoice, onClose }: { invoice: any; onClose: () => void }) {
  const { t, tt, lang } = useI18n();
  const { toast } = useToast();
  const { warehouses } = useLookups();
  const qc = warehouses.filter((w: any) => w.kind === "quarantine");
  const [wh, setWh] = useState("");
  const [reason, setReason] = useState("");
  const [qty, setQty] = useState<Record<string, string>>({});
  const [err, setErr] = useState<unknown>(null);
  const save = async () => {
    setErr(null);
    try {
      await api.post("/sales/returns", { invoiceId: invoice.id, warehouseId: wh || qc[0]?.id, returnDate: today(), reason,
        lines: Object.entries(qty).filter(([, v]) => Number(v) > 0).map(([invoiceLineId, q]) => ({ invoiceLineId, qty: q })) });
      toast(tt("حُفظ المرتجع كمسودة — يُرحّل من صفحة المرتجعات", "Return saved as draft — post it from Returns")); onClose();
    } catch (e) { setErr(e); toast(errMsg(e, lang), true); }
  };
  return (
    <Modal title={`${tt("مرتجع على", "Return on")} ${invoice.number}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>{t.cancel}</button><button className="btn primary" onClick={save}>{t.save}</button></>}>
      <div className="alert warn">{tt("المرتجعات تدخل مخزن الحجر ولا تعود للبيع إلا بعد إفراج الجودة.", "Returns go to quarantine and are sellable again only after a Quality release.")}</div>
      <ErrorBox error={err} />
      {!qc.length && <div className="alert bad">{tt("أنشئ مخزن حجر (quarantine) أولًا من صفحة المخازن", "Create a quarantine warehouse first")}</div>}
      <div className="form-grid" style={{ marginBottom: 12 }}>
        <Field label={tt("مخزن الحجر", "Quarantine warehouse")}><select value={wh} onChange={(e) => setWh(e.target.value)}>{qc.map((w: any) => <option key={w.id} value={w.id}>{w.code} {w.name_ar}</option>)}</select></Field>
        <Field label={t.reason}><input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </div>
      <LinesTable rows={invoice.lines} cols={[{ h: tt("الصنف", "Item"), v: (l) => `${l.item_code} ${l.item_name_ar}` }, { h: tt("المباع (وحدة أساسية)", "Sold (base)"), v: (l) => Number(l.base_qty) },
        { h: tt("الكمية المرتجعة", "Return qty"), v: (l) => <input className="num" style={{ width: 90 }} value={qty[l.id] ?? ""} onChange={(e) => setQty({ ...qty, [l.id]: e.target.value })} /> }]} />
    </Modal>
  );
}

export function SalesReturns() {
  const { t, tt } = useI18n();
  return <DocList path="/sales/returns" title={tt("مرتجعات المبيعات", "Sales returns")} createPerm="sales.returns.create" postPerm="sales.returns.post"
    columns={[{ h: t.date, v: (r) => date(r.return_date) }, { h: t.reason, v: (r) => r.reason }, { h: t.total, v: (r) => money(r.total), end: true }, { h: tt("التكلفة", "Cost"), v: (r) => money(r.cost_total), end: true }]}
    renderDetail={(d) => <LinesTable rows={d.lines} cols={[{ h: "#", v: (l) => l.line_no }, { h: tt("الكمية", "Qty"), v: (l) => Number(l.base_qty) }, { h: t.amount, v: (l) => money(l.amount), end: true }]} />} />;
}

export function Receipts() {
  const { t, tt } = useI18n();
  const { companyId } = useSession();
  const [f, setF] = useState<any | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [k, setK] = useState(0);
  const customers = useAsync(() => api.get(`/customers?companyId=${companyId}&pageSize=200`), [companyId]);
  const save = async () => { setErr(null); try { await api.post("/sales/receipts", { companyId, ...f }); setF(null); setK(k + 1); } catch (e) { setErr(e); } };
  return <>
    <DocList path="/sales/receipts" title={tt("سندات القبض", "Customer receipts")} newLabel={tt("سند قبض", "New receipt")} onNew={() => setF({ partyId: "", method: "cash", paymentDate: today(), amount: "" })} reloadKey={k}
      createPerm="sales.receipts.create" postPerm="sales.receipts.post"
      columns={[{ h: t.date, v: (r) => date(r.payment_date) }, { h: tt("العميل", "Customer"), v: (r) => r.party_name_ar }, { h: tt("الطريقة", "Method"), v: (r) => r.method }, { h: t.amount, v: (r) => money(r.amount), end: true }]}
      renderDetail={(d) => <><p>{tt("يُوزّع المبلغ على أقدم الفواتير المفتوحة، والزائد يُسجل دفعة مقدمة للعميل.", "Applied to the oldest open invoices; any excess becomes a customer advance.")}</p>
        <LinesTable rows={d.allocations ?? []} cols={[{ h: tt("الفاتورة", "Invoice"), v: (a) => <code>{a.sales_invoice_id?.slice(0, 8)}</code> }, { h: t.amount, v: (a) => money(a.amount), end: true }]} /></>} />
    {f && <Modal title={tt("سند قبض", "Customer receipt")} onClose={() => setF(null)} footer={<><button className="btn" onClick={() => setF(null)}>{t.cancel}</button><button className="btn primary" onClick={save}>{t.save}</button></>}>
      <ErrorBox error={err} />
      <div className="form-grid">
        <Field label={tt("العميل", "Customer")}><select value={f.partyId} onChange={(e) => setF({ ...f, partyId: e.target.value })}><option value="">—</option>{customers.data?.data.map((c: any) => <option key={c.id} value={c.id}>{c.code} {c.name_ar} ({fmt(c.balance)})</option>)}</select></Field>
        <Field label={tt("الطريقة", "Method")}><select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}><option value="cash">{tt("نقدًا", "Cash")}</option><option value="bank">{tt("مصرف/حوالة", "Bank")}</option><option value="rep_custody">{tt("عهدة مندوب", "Rep custody")}</option></select></Field>
        <Field label={t.date}><input type="date" value={f.paymentDate} onChange={(e) => setF({ ...f, paymentDate: e.target.value })} /></Field>
        <Field label={t.amount}><input className="num" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
        <Field label={t.reference}><input value={f.reference ?? ""} onChange={(e) => setF({ ...f, reference: e.target.value })} /></Field>
      </div>
    </Modal>}
  </>;
}

export function ArAging() {
  const { tt } = useI18n();
  const { companyId } = useSession();
  const [asOf, setAsOf] = useState(today());
  const d = useAsync(() => api.get(`/sales/ar-aging?companyId=${companyId}&asOf=${asOf}`), [companyId, asOf]);
  const cols = ["not_due", "d1_30", "d31_60", "d61_90", "d90_plus"];
  const lbl = [tt("غير مستحق", "Not due"), "1–30", "31–60", "61–90", "+90"];
  return <>
    <div className="page-head"><h1>{tt("أعمار الديون", "Receivables aging")}</h1><input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} style={{ width: "auto" }} /></div>
    <ErrorBox error={d.error} />
    {d.data && <div className="table-wrap"><table>
      <thead><tr><th>{tt("العميل", "Customer")}</th>{lbl.map((l) => <th key={l} className="end">{l}</th>)}<th className="end">{tt("الإجمالي", "Total")}</th><th className="end">{tt("حد الائتمان", "Limit")}</th></tr></thead>
      <tbody>{d.data.rows.map((r: any) => <tr key={r.id}><td>{r.code} {r.name_ar}</td>{cols.map((c) => <td key={c} className="end num" style={{ color: c === "d90_plus" && r[c] ? "var(--bad)" : undefined }}>{r[c] ? fmt(r[c]) : ""}</td>)}
        <td className="end num"><b>{fmt(r.total)}</b></td><td className="end num">{r.credit_limit ? fmt(r.credit_limit) : "∞"}</td></tr>)}</tbody>
    </table></div>}
  </>;
}
