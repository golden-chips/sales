import { useState } from "react";
import { api, fmt } from "../../api";
import { useI18n } from "../../i18n";
import { useSession } from "../../session";
import { ErrorBox, Field, Modal, errMsg, useAsync, useToast } from "../../ui";
import { DocList, LinesTable, date, money, today, useLookups } from "./shared";

export default function PurchaseReceipts() {
  const { t, tt, lang } = useI18n();
  const { can } = useSession();
  const { toast } = useToast();
  const [editor, setEditor] = useState(false);
  const [k, setK] = useState(0);
  const [invoicing, setInvoicing] = useState<any | null>(null);
  return <>
    <DocList path="/purchasing/receipts" title={tt("أذونات الاستلام", "Goods receipts")} newLabel={tt("استلام جديد", "New receipt")} onNew={() => setEditor(true)} reloadKey={k}
      createPerm="purchasing.receipts.create" postPerm="purchasing.receipts.post"
      columns={[{ h: t.date, v: (r) => date(r.receipt_date) }, { h: tt("المورد", "Supplier"), v: (r) => r.party_name_ar }, { h: t.reference, v: (r) => r.supplier_ref },
        { h: t.total, v: (r) => money(r.total), end: true }, { h: tt("مفوتر", "Invoiced"), v: (r) => money(r.amount_invoiced), end: true }]}
      renderDetail={(d) => <>
        <div className="row"><b>{d.supplier_name_ar}</b><span className="badge">{d.warehouse_code}</span></div>
        <LinesTable rows={d.lines} cols={[{ h: tt("الصنف", "Item"), v: (l) => `${l.item_code} ${l.item_name_ar}` }, { h: tt("الكمية", "Qty"), v: (l) => `${Number(l.qty)} ${l.uom_code}` },
          { h: tt("التكلفة", "Cost"), v: (l) => money(l.unit_cost), end: true }, { h: tt("التشغيلة", "Lot"), v: (l) => l.lot_no ?? "" }, { h: tt("الانتهاء", "Expiry"), v: (l) => l.expiry_date ?? "" },
          { h: t.total, v: (l) => money(l.line_total), end: true }]} />
        {d.status === "posted" && Number(d.amount_invoiced) < Number(d.total) && can("purchasing.invoices.create") && <button className="btn" onClick={() => setInvoicing(d)}>{tt("تسجيل فاتورة المورد", "Record supplier invoice")}</button>}
      </>} />
    {editor && <ReceiptEditor onClose={() => setEditor(false)} onSaved={() => { setEditor(false); setK(k + 1); }} />}
    {invoicing && <SupplierInvoiceEditor receipt={invoicing} onClose={() => setInvoicing(null)} onSaved={() => { setInvoicing(null); toast(tt("حُفظت فاتورة المورد كمسودة", "Supplier invoice saved as draft")); setK(k + 1); }} />}
  </>;
}

/** supplier invoice for a posted receipt; "final" closes the receipt and books any price difference */
function SupplierInvoiceEditor({ receipt, onClose, onSaved }: { receipt: any; onClose: () => void; onSaved: () => void }) {
  const { t, tt } = useI18n();
  const remaining = Number(receipt.total) - Number(receipt.amount_invoiced);
  const [f, setF] = useState({ no: "", total: String(remaining), date: today(), isFinal: true });
  const [key] = useState(() => crypto.randomUUID());
  const [err, setErr] = useState<unknown>(null);
  const diff = Number(f.total || 0) - remaining;
  const save = async () => {
    setErr(null);
    try { await api.post("/purchasing/invoices", { receiptId: receipt.id, supplierInvoiceNo: f.no, invoiceDate: f.date, total: f.total, isFinal: f.isFinal }, { idempotencyKey: key }); onSaved(); }
    catch (e) { setErr(e); }
  };
  return <Modal title={`${tt("فاتورة المورد على الاستلام", "Supplier invoice for receipt")} ${receipt.number}`} onClose={onClose}
    footer={<><button className="btn" onClick={onClose}>{t.cancel}</button><button className="btn primary" disabled={!f.no || !(Number(f.total) > 0)} onClick={save}>{t.save} ({t.draft})</button></>}>
    <ErrorBox error={err} />
    <div className="form-grid">
      <Field label={tt("رقم فاتورة المورد", "Supplier's invoice number")}><input dir="ltr" value={f.no} onChange={(e) => setF({ ...f, no: e.target.value })} /></Field>
      <Field label={tt("قيمة الفاتورة", "Invoice total")}><input className="num" value={f.total} onChange={(e) => setF({ ...f, total: e.target.value })} /></Field>
      <Field label={t.date}><input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
    </div>
    <p style={{ color: "var(--muted)" }}>{tt("قيمة الاستلام غير المفوترة:", "Uninvoiced receipt value:")} <b className="num">{fmt(String(remaining))}</b></p>
    <label className="setting-row"><span><b>{tt("فاتورة نهائية لهذا الاستلام", "Final invoice for this receipt")}</b>
      <small>{tt("تُقفل الاستلام؛ أي فرق في السعر يُضاف لقيمة البضاعة الموجودة بالمخزن (وحصة ما استُهلك منها لفروق المخزون).", "Closes the receipt; a price difference goes to the goods still in stock (the used share to stock differences).")}</small></span>
      <input type="checkbox" className="toggle" checked={f.isFinal} onChange={(e) => setF({ ...f, isFinal: e.target.checked })} /></label>
    {f.isFinal && Math.abs(diff) > 0.0005 && <div className={`alert ${diff > 0 ? "warn" : "info"}`}>{diff > 0
      ? tt(`السعر أعلى من الاستلام بـ ${fmt(diff.toFixed(3))} — سيُرفع تكلفة البضاعة`, `Price is ${diff.toFixed(3)} higher than received — stock cost goes up`)
      : tt(`السعر أقل من الاستلام بـ ${fmt((-diff).toFixed(3))} — ستنخفض تكلفة البضاعة`, `Price is ${(-diff).toFixed(3)} lower — stock cost goes down`)}</div>}
    {!f.isFinal && diff > 0.0005 && <div className="alert bad">{tt("فاتورة جزئية لا تتجاوز المتبقي — علّمها «نهائية» إن تغيّر السعر.", "A partial invoice cannot exceed the remaining value — mark it final if the price changed.")}</div>}
  </Modal>;
}

// ------------------------------------------------------------------ landed costs
export function LandedCosts() {
  const { t, tt } = useI18n();
  const [editor, setEditor] = useState(false);
  const [k, setK] = useState(0);
  return <>
    <DocList path="/purchasing/landed-costs" title={tt("التكاليف الإضافية للمشتريات", "Landed costs")} newLabel={tt("تكلفة إضافية", "New landed cost")} onNew={() => setEditor(true)} reloadKey={k}
      createPerm="purchasing.landed.create" postPerm="purchasing.landed.post"
      columns={[{ h: t.date, v: (r) => date(r.cost_date) }, { h: tt("البيان", "Description"), v: (r) => r.description }, { h: t.amount, v: (r) => money(r.amount), end: true },
        { h: tt("على المخزون", "To stock"), v: (r) => r.capitalized ? money(r.capitalized) : "—", end: true }]}
      renderDetail={(d) => <div className="grid" style={{ gap: 6 }}>
        <div className="row"><b>{tt("الاستلام", "Receipt")} {d.receipt_number}</b><span>{d.supplier_name_ar}</span></div>
        <div>{tt("التوزيع", "Split")}: {d.split === "qty" ? tt("حسب الكمية", "by quantity") : tt("حسب القيمة", "by value")} · {tt("دُفعت من", "Paid from")}: <span className="num">{d.account_code}</span> {d.account_name}</div>
        {d.capitalized && <div>{tt("أضيف لقيمة المخزون", "Added to stock")}: <b className="num">{money(d.capitalized)}</b> · {tt("لفروق المخزون (بضاعة مستهلكة)", "To stock differences (used goods)")}: <b className="num">{money(d.expensed)}</b></div>}
      </div>} />
    {editor && <LandedEditor onClose={() => setEditor(false)} onSaved={() => { setEditor(false); setK(k + 1); }} />}
  </>;
}

function LandedEditor({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { t, tt } = useI18n();
  const { companyId } = useSession();
  const receipts = useAsync(() => api.get(`/purchasing/receipts?companyId=${companyId}&status=posted&pageSize=100`), [companyId]);
  const accounts = useAsync(() => api.get(`/accounting/accounts?companyId=${companyId}&postableOnly=true`), [companyId]);
  const [key] = useState(() => crypto.randomUUID());
  const [f, setF] = useState({ receiptId: "", description: "", amount: "", split: "value", creditAccountId: "", costDate: today() });
  const [err, setErr] = useState<unknown>(null);
  const payFrom = (accounts.data ?? []).filter((a: any) => ["asset", "liability"].includes(a.type) && !["ar", "ap"].includes(a.role));
  const save = async () => { setErr(null); try { await api.post("/purchasing/landed-costs", f, { idempotencyKey: key }); onSaved(); } catch (e) { setErr(e); } };
  return <Modal title={tt("تكلفة إضافية على استلام", "Landed cost on a receipt")} onClose={onClose}
    footer={<><button className="btn" onClick={onClose}>{t.cancel}</button><button className="btn primary" disabled={!f.receiptId || !f.creditAccountId || !(Number(f.amount) > 0) || f.description.length < 3} onClick={save}>{t.save} ({t.draft})</button></>}>
    <div className="alert info">{tt("شحن، جمارك، تفريغ… تُضاف لتكلفة أصناف الاستلام الموجودة في المخزن، وتوزَّع حسب القيمة أو الكمية. لفاتورة من شركة شحن آجلة استعمل حسابًا وسيطًا (مستحقات).",
      "Shipping, customs, unloading… added to the cost of the receipt's goods still in stock, split by value or quantity.")}</div>
    <ErrorBox error={err} />
    <div className="form-grid">
      <Field label={tt("إذن الاستلام", "Goods receipt")}><select value={f.receiptId} onChange={(e) => setF({ ...f, receiptId: e.target.value })}><option value="">—</option>
        {(receipts.data?.data ?? []).map((r: any) => <option key={r.id} value={r.id}>{r.number} · {r.party_name_ar} · {fmt(r.total)}</option>)}</select></Field>
      <Field label={tt("البيان", "Description")}><input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder={tt("مثال: شحن من الميناء", "e.g. freight from port")} /></Field>
      <Field label={t.amount}><input className="num" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
      <Field label={tt("التوزيع على الأصناف", "Split over items")}><select value={f.split} onChange={(e) => setF({ ...f, split: e.target.value })}>
        <option value="value">{tt("حسب القيمة", "By value")}</option><option value="qty">{tt("حسب الكمية", "By quantity")}</option></select></Field>
      <Field label={tt("دُفعت من", "Paid from")}><select value={f.creditAccountId} onChange={(e) => setF({ ...f, creditAccountId: e.target.value })}><option value="">—</option>
        {payFrom.map((a: any) => <option key={a.id} value={a.id}>{a.code} — {a.name_ar}</option>)}</select></Field>
      <Field label={t.date}><input type="date" value={f.costDate} onChange={(e) => setF({ ...f, costDate: e.target.value })} /></Field>
    </div>
  </Modal>;
}

function ReceiptEditor({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { t, tt } = useI18n();
  const { companyId } = useSession();
  const { items, warehouses } = useLookups();
  const suppliers = useAsync(() => api.get(`/suppliers?companyId=${companyId}&pageSize=200&active=true`), [companyId]);
  const [key] = useState(() => crypto.randomUUID());
  const [h, setH] = useState({ supplierId: "", warehouseId: "", receiptDate: today(), supplierRef: "" });
  const [lines, setLines] = useState<any[]>([{ itemId: "", uomId: "", qty: "", unitCost: "", lotNo: "", productionDate: "", expiryDate: "" }]);
  const [err, setErr] = useState<unknown>(null);
  const set = (i: number, p: any) => setLines(lines.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const save = async () => {
    setErr(null);
    try {
      await api.post("/purchasing/receipts", { companyId, ...h, warehouseId: h.warehouseId || warehouses[0]?.id, supplierRef: h.supplierRef || undefined,
        lines: lines.filter((l) => l.itemId).map((l) => ({ itemId: l.itemId, uomId: l.uomId || null, qty: l.qty, unitCost: l.unitCost, ...(l.lotNo ? { lotNo: l.lotNo } : {}),
          ...(l.productionDate ? { productionDate: l.productionDate } : {}), ...(l.expiryDate ? { expiryDate: l.expiryDate } : {}) })) }, { idempotencyKey: key });
      onSaved();
    } catch (e) { setErr(e); }
  };
  return (
    <Modal title={tt("إذن استلام جديد", "New goods receipt")} onClose={onClose} footer={<><button className="btn" onClick={onClose}>{t.cancel}</button><button className="btn primary" onClick={save}>{t.save} ({t.draft})</button></>}>
      <div className="alert info">{tt("للفحص قبل القبول: استلم في مخزن حجر ثم أفرج عنه بعد فحص الجودة.", "To inspect before acceptance: receive into a quarantine warehouse, then release after the quality check.")}</div>
      <ErrorBox error={err} />
      <div className="form-grid" style={{ marginBottom: 12 }}>
        <Field label={tt("المورد", "Supplier")}><select value={h.supplierId} onChange={(e) => setH({ ...h, supplierId: e.target.value })}><option value="">—</option>{suppliers.data?.data.map((s: any) => <option key={s.id} value={s.id}>{s.code} {s.name_ar}</option>)}</select></Field>
        <Field label={t.warehouse}><select value={h.warehouseId} onChange={(e) => setH({ ...h, warehouseId: e.target.value })}>{warehouses.map((w: any) => <option key={w.id} value={w.id}>{w.code} {w.name_ar} ({w.kind})</option>)}</select></Field>
        <Field label={t.date}><input type="date" value={h.receiptDate} onChange={(e) => setH({ ...h, receiptDate: e.target.value })} /></Field>
        <Field label={tt("مرجع المورد", "Supplier ref.")}><input value={h.supplierRef} onChange={(e) => setH({ ...h, supplierRef: e.target.value })} /></Field>
      </div>
      <div className="table-wrap"><table>
        <thead><tr><th>{tt("الصنف", "Item")}</th><th>{tt("الوحدة", "Unit")}</th><th>{tt("الكمية", "Qty")}</th><th>{tt("تكلفة الوحدة", "Unit cost")}</th><th>{tt("التشغيلة", "Lot")}</th><th>{tt("إنتاج", "Prod.")}</th><th>{tt("انتهاء", "Expiry")}</th><th /></tr></thead>
        <tbody>{lines.map((l, i) => {
          const item = items.find((x: any) => x.id === l.itemId);
          return <tr key={i}>
            <td style={{ minWidth: 180 }}><select value={l.itemId} onChange={(e) => set(i, { itemId: e.target.value, uomId: "" })}><option value="">—</option>{items.filter((x: any) => x.kind !== "service").map((x: any) => <option key={x.id} value={x.id}>{x.code} {x.name_ar}</option>)}</select></td>
            <td><select value={l.uomId} onChange={(e) => set(i, { uomId: e.target.value })}><option value="">{item?.base_uom_code ?? "—"}</option>{item?.units.map((u: any) => <option key={u.uomId} value={u.uomId}>{u.code} ×{Number(u.factor)}</option>)}</select></td>
            <td><input className="num" style={{ width: 80 }} value={l.qty} onChange={(e) => set(i, { qty: e.target.value })} /></td>
            <td><input className="num" style={{ width: 90 }} value={l.unitCost} onChange={(e) => set(i, { unitCost: e.target.value })} /></td>
            <td><input dir="ltr" style={{ width: 100 }} value={l.lotNo} onChange={(e) => set(i, { lotNo: e.target.value })} placeholder={item?.track_lots ? t.required : ""} /></td>
            <td><input type="date" value={l.productionDate} onChange={(e) => set(i, { productionDate: e.target.value })} /></td>
            <td><input type="date" value={l.expiryDate} onChange={(e) => set(i, { expiryDate: e.target.value })} /></td>
            <td>{lines.length > 1 && <button className="btn sm" onClick={() => setLines(lines.filter((_, j) => j !== i))}>✕</button>}</td>
          </tr>;
        })}</tbody>
      </table></div>
      <button className="btn sm" style={{ marginTop: 8 }} onClick={() => setLines([...lines, { itemId: "", uomId: "", qty: "", unitCost: "", lotNo: "", productionDate: "", expiryDate: "" }])}>+ {t.addLine}</button>
    </Modal>
  );
}

export function SupplierInvoices() {
  const { t, tt } = useI18n();
  return <DocList path="/purchasing/invoices" title={tt("فواتير الموردين", "Supplier invoices")} createPerm="purchasing.invoices.create" postPerm="purchasing.invoices.post"
    columns={[{ h: t.date, v: (r) => date(r.invoice_date) }, { h: tt("المورد", "Supplier"), v: (r) => r.party_name_ar }, { h: tt("رقم المورد", "Supplier no."), v: (r) => r.supplier_invoice_no },
      { h: t.total, v: (r) => money(r.total), end: true }, { h: tt("المسدد", "Paid"), v: (r) => money(r.amount_paid), end: true }]}
    renderDetail={(d) => <div className="balance-bar"><span>{t.total} <b className="num">{fmt(d.total)}</b></span><span>{tt("المسدد", "Paid")} <b className="num">{fmt(d.amount_paid)}</b></span><span>{tt("الاستحقاق", "Due")} <b className="num">{d.due_date ?? "—"}</b></span></div>} />;
}

const REASONS = ["opening", "count", "damage", "transfer", "quarantine_release"] as const;
export function StockDocuments() {
  const { t, tt, lang } = useI18n();
  const { companyId } = useSession();
  const { items, warehouses } = useLookups();
  const [f, setF] = useState<any | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [k, setK] = useState(0);
  const RL: Record<string, string> = { opening: tt("رصيد افتتاحي", "Opening"), count: tt("تسوية جرد", "Count adjustment"), damage: tt("إتلاف", "Damage write-off"), transfer: tt("تحويل", "Transfer"), quarantine_release: tt("إفراج من الحجر", "Quarantine release") };
  const needsTo = f && (f.reason === "transfer" || f.reason === "quarantine_release");
  const save = async () => {
    setErr(null);
    try {
      await api.post("/inventory/documents", { companyId, reason: f.reason, warehouseId: f.warehouseId || warehouses[0]?.id, toWarehouseId: needsTo ? f.toWarehouseId : null, docDate: f.docDate, notes: f.notes || undefined,
        lines: f.lines.filter((l: any) => l.itemId).map((l: any) => ({ itemId: l.itemId, qtyDelta: l.qty, ...(l.unitCost ? { unitCost: l.unitCost } : {}), ...(l.lotNo ? { lotNo: l.lotNo } : {}), ...(l.expiryDate ? { expiryDate: l.expiryDate } : {}) })) });
      setF(null); setK(k + 1);
    } catch (e) { setErr(e); }
  };
  const setL = (i: number, p: any) => setF({ ...f, lines: f.lines.map((l: any, j: number) => (j === i ? { ...l, ...p } : l)) });
  return <>
    <DocList path="/inventory/documents" title={tt("المستندات المخزنية", "Stock documents")} onNew={() => setF({ reason: "opening", docDate: today(), lines: [{ itemId: "", qty: "" }] })} reloadKey={k}
      createPerm="inventory.moves.create" postPerm="inventory.moves.post"
      columns={[{ h: t.date, v: (r) => date(r.doc_date) }, { h: t.type, v: (r) => RL[r.reason] }, { h: t.memo, v: (r) => r.notes }]}
      renderDetail={(d) => <LinesTable rows={d.lines} cols={[{ h: tt("الصنف", "Item"), v: (l) => `${l.item_code} ${l.item_name_ar}` }, { h: tt("الكمية", "Qty"), v: (l) => Number(l.qty_delta) },
        { h: tt("التكلفة", "Cost"), v: (l) => l.unit_cost ? money(l.unit_cost) : "" }, { h: tt("التشغيلة", "Lot"), v: (l) => l.lot ?? l.lot_no ?? "" }]} />} />
    {f && <Modal title={tt("مستند مخزني", "Stock document")} onClose={() => setF(null)} footer={<><button className="btn" onClick={() => setF(null)}>{t.cancel}</button><button className="btn primary" onClick={save}>{t.save}</button></>}>
      <ErrorBox error={err} />
      <div className="form-grid" style={{ marginBottom: 12 }}>
        <Field label={t.type}><select value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })}>{REASONS.map((r) => <option key={r} value={r}>{RL[r]}</option>)}</select></Field>
        <Field label={needsTo ? tt("من مخزن", "From") : t.warehouse}><select value={f.warehouseId ?? ""} onChange={(e) => setF({ ...f, warehouseId: e.target.value })}>{warehouses.map((w: any) => <option key={w.id} value={w.id}>{w.code} ({w.kind})</option>)}</select></Field>
        {needsTo && <Field label={tt("إلى مخزن", "To")}><select value={f.toWarehouseId ?? ""} onChange={(e) => setF({ ...f, toWarehouseId: e.target.value })}><option value="">—</option>{warehouses.map((w: any) => <option key={w.id} value={w.id}>{w.code} ({w.kind})</option>)}</select></Field>}
        <Field label={t.date}><input type="date" value={f.docDate} onChange={(e) => setF({ ...f, docDate: e.target.value })} /></Field>
        <Field label={t.memo}><input value={f.notes ?? ""} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      </div>
      <p style={{ color: "var(--muted)", fontSize: 12 }}>{lang === "ar" ? "الكمية بالوحدة الأساسية: موجبة للزيادة، سالبة للنقص أو الإتلاف. تكلفة الوحدة إلزامية للزيادات." : "Quantities in base unit: positive to add, negative to reduce/write off. Unit cost is required for increases."}</p>
      {f.lines.map((l: any, i: number) => <div className="row" key={i} style={{ marginBottom: 6 }}>
        <select value={l.itemId} onChange={(e) => setL(i, { itemId: e.target.value })} style={{ flex: 2 }}><option value="">—</option>{items.filter((x: any) => x.kind !== "service").map((x: any) => <option key={x.id} value={x.id}>{x.code} {x.name_ar}</option>)}</select>
        <input className="num" placeholder={tt("الكمية", "Qty")} value={l.qty} onChange={(e) => setL(i, { qty: e.target.value })} style={{ width: 90 }} />
        {(f.reason === "opening" || f.reason === "count") && <><input className="num" placeholder={tt("التكلفة", "Cost")} value={l.unitCost ?? ""} onChange={(e) => setL(i, { unitCost: e.target.value })} style={{ width: 90 }} />
          <input dir="ltr" placeholder={tt("التشغيلة", "Lot")} value={l.lotNo ?? ""} onChange={(e) => setL(i, { lotNo: e.target.value })} style={{ width: 100 }} />
          <input type="date" value={l.expiryDate ?? ""} onChange={(e) => setL(i, { expiryDate: e.target.value })} style={{ width: 150 }} /></>}
      </div>)}
      <button className="btn sm" onClick={() => setF({ ...f, lines: [...f.lines, { itemId: "", qty: "" }] })}>+ {t.addLine}</button>
    </Modal>}
  </>;
}
