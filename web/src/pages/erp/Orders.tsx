// Quotations, sales orders and purchase orders (v0.8).
import { useState, type ReactNode } from "react";
import { api } from "../../api";
import { useI18n } from "../../i18n";
import { useSession } from "../../session";
import { Empty, ErrorBox, Field, Loading, Modal, errMsg, useAsync, useToast } from "../../ui";
import { LinesTable, date, money, today, useLookups } from "./shared";

type Tt = (ar: string, en: string) => string;
const STATUS: Record<string, [string, string, string]> = {
  draft: ["warn", "مسودة", "Draft"], sent: ["info", "مرسل", "Sent"], accepted: ["ok", "مقبول", "Accepted"], rejected: ["bad", "مرفوض", "Rejected"], converted: ["ok", "محوّل لأمر", "Converted"],
  confirmed: ["info", "مؤكد", "Confirmed"], partially_delivered: ["warn", "مسلّم جزئيًا", "Part delivered"], delivered: ["ok", "مسلّم", "Delivered"], closed: ["", "مغلق", "Closed"], cancelled: ["bad", "ملغى", "Cancelled"],
  pending_approval: ["warn", "بانتظار الاعتماد", "Pending approval"], approved: ["info", "معتمد", "Approved"], partially_received: ["warn", "مستلم جزئيًا", "Part received"], received: ["ok", "مستلم", "Received"],
  posted: ["ok", "مرحّل", "Posted"],
};
function Badge({ s }: { s: string }) {
  const { tt } = useI18n();
  const [cls, ar, en] = STATUS[s] ?? ["", s, s];
  return <span className={`badge ${cls}`}>{tt(ar, en)}</span>;
}

/** list + detail modal for an order endpoint; actions are supplied by each screen */
function OrderList({ path, title, statuses, partyLabel, newLabel, canCreate, onNew, reloadKey, extraCols, renderDetail }: {
  path: string; title: string; statuses: string[]; partyLabel: string; newLabel: string; canCreate: boolean; onNew: () => void; reloadKey: number;
  extraCols: { h: string; v: (r: any) => ReactNode; end?: boolean }[]; renderDetail: (d: any, reload: () => void) => ReactNode;
}) {
  const { t, tt } = useI18n();
  const { companyId } = useSession();
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);
  const [k, setK] = useState(0);
  const list = useAsync(() => api.get(`${path}?companyId=${companyId}&page=${page}&pageSize=25${status ? `&status=${status}` : ""}${q ? `&q=${encodeURIComponent(q)}` : ""}`), [companyId, page, status, q, reloadKey, k]);
  const detail = useAsync(() => (openId ? api.get(`${path}/${openId}`) : Promise.resolve(null)), [openId, k]);
  const reload = () => setK(k + 1);
  return <>
    <div className="page-head"><h1>{title}</h1><div className="row">
      <input type="search" placeholder={tt("رقم أو اسم", "Number or name")} value={q} onChange={(e) => { setPage(1); setQ(e.target.value); }} style={{ width: 170 }} />
      <select value={status} onChange={(e) => { setPage(1); setStatus(e.target.value); }} style={{ width: "auto" }}>
        <option value="">{t.status}: *</option>{statuses.map((s) => <option key={s} value={s}>{tt(STATUS[s][1], STATUS[s][2])}</option>)}</select>
      {canCreate && <button className="btn primary" onClick={onNew}>{newLabel}</button>}</div></div>
    <ErrorBox error={list.error} />
    {list.loading ? <Loading /> : !list.data?.data.length ? <div className="card"><Empty action={canCreate ? <button className="btn primary" onClick={onNew}>{newLabel}</button> : undefined} /></div> : <>
      <div className="table-wrap"><table>
        <thead><tr><th>{t.number}</th><th>{t.date}</th><th>{partyLabel}</th>{extraCols.map((c) => <th key={c.h} className={c.end ? "end" : ""}>{c.h}</th>)}<th className="end">{t.total}</th><th>{t.status}</th></tr></thead>
        <tbody>{list.data.data.map((r: any) => <tr key={r.id} style={{ cursor: "pointer" }} onClick={() => setOpenId(r.id)}>
          <td className="num">{r.number}</td><td>{date(r.quote_date ?? r.order_date)}</td><td>{r.party_code} {r.party_name_ar}</td>
          {extraCols.map((c) => <td key={c.h} className={c.end ? "end num" : ""}>{c.v(r)}</td>)}<td className="end num">{money(r.total)}</td><td><Badge s={r.status} /></td></tr>)}</tbody>
      </table></div>
      <div className="row" style={{ marginTop: 8 }}><span className="num">{list.data.total}</span><span className="spacer" />
        <button className="btn sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>‹</button><span className="num">{page}</span>
        <button className="btn sm" disabled={page * 25 >= list.data.total} onClick={() => setPage(page + 1)}>›</button></div>
    </>}
    {openId && <Modal title={detail.data?.number ?? "…"} onClose={() => setOpenId(null)}>
      <ErrorBox error={detail.error} />
      {detail.loading ? <Loading /> : detail.data && <div className="grid"><div className="row"><Badge s={detail.data.status} /></div>{renderDetail(detail.data, reload)}</div>}
    </Modal>}
  </>;
}

/** runs an action, toasts the outcome, reloads */
function useAct() {
  const { lang } = useI18n();
  const { toast } = useToast();
  return async (fn: () => Promise<unknown>, okMsg: string, reload: () => void) => {
    try { await fn(); toast(okMsg); reload(); } catch (e) { toast(errMsg(e, lang), true); }
  };
}

function salesLineCols(tt: Tt, withDelivered = false) {
  return [{ h: tt("الصنف", "Item"), v: (l: any) => `${l.item_code} ${l.item_name_ar}` }, { h: tt("الكمية", "Qty"), v: (l: any) => `${Number(l.qty)} ${l.uom_code}` },
    { h: tt("السعر", "Price"), v: (l: any) => money(l.unit_price), end: true }, { h: tt("خصم %", "Disc. %"), v: (l: any) => Number(l.discount_pct) || "" },
    ...(withDelivered ? [{ h: tt("المسلّم (أساسي)", "Delivered (base)"), v: (l: any) => `${Number(l.delivered_base_qty)} / ${Number(l.base_qty)}`, end: true }] : []),
    { h: tt("الإجمالي", "Total"), v: (l: any) => money(l.line_total), end: true }];
}

// ------------------------------------------------------------------ quotations
export function Quotations() {
  const { tt } = useI18n();
  const { can } = useSession();
  const act = useAct();
  const { warehouses } = useLookups();
  const [editor, setEditor] = useState(false);
  const [k, setK] = useState(0);
  const sellable = warehouses.filter((w: any) => w.is_sellable !== false);
  return <>
    <OrderList path="/sales-quotations" title={tt("عروض الأسعار", "Quotations")} statuses={["draft", "sent", "rejected", "converted"]} partyLabel={tt("العميل", "Customer")}
      newLabel={tt("عرض سعر جديد", "New quotation")} canCreate={can("sales.quotations.manage")} onNew={() => setEditor(true)} reloadKey={k}
      extraCols={[{ h: tt("صالح حتى", "Valid until"), v: (r) => date(r.valid_until) }]}
      renderDetail={(d, reload) => <>
        <div className="row"><b>{d.customer_code} {d.customer_name_ar}</b><span className="muted">{tt("صالح حتى", "Valid until")} {date(d.valid_until)}</span>
          {d.expired && <span className="badge bad">{tt("منتهي الصلاحية", "Expired")}</span>}</div>
        <LinesTable rows={d.lines} cols={salesLineCols(tt)} />
        <div className="row"><span className="spacer" /><span>{tt("الإجمالي", "Total")}: <b className="num">{money(d.total)}</b></span></div>
        {d.reject_reason && <div className="alert">{tt("سبب الرفض", "Reason")}: {d.reject_reason}</div>}
        {["draft", "sent"].includes(d.status) && <div className="row">
          {d.status === "draft" && <button className="btn" onClick={() => act(() => api.post(`/sales-quotations/${d.id}/send`, {}), tt("عُلِّم كمرسل", "Marked as sent"), reload)}>{tt("تم الإرسال للعميل", "Mark as sent")}</button>}
          <button className="btn danger" onClick={() => { const r = prompt(tt("سبب رفض العميل", "Customer's reason")); if (r) act(() => api.post(`/sales-quotations/${d.id}/reject`, { reason: r }), tt("سُجّل الرفض", "Rejected"), reload); }}>{tt("رفض العميل", "Rejected")}</button>
          {can("sales.orders.manage") && !d.expired && <button className="btn primary" onClick={() => act(() => api.post(`/sales-quotations/${d.id}/convert`, { warehouseId: sellable[0]?.id, orderDate: today() }),
            tt("أُنشئ أمر بيع مسودة — راجعه في أوامر البيع", "Draft sales order created — see Sales orders"), reload)}>{tt("قَبِل العميل: حوّل إلى أمر بيع", "Accepted: convert to order")}</button>}
        </div>}
      </>} />
    {editor && <SalesDocEditor kind="quotation" onClose={() => setEditor(false)} onSaved={() => { setEditor(false); setK(k + 1); }} />}
  </>;
}

// ------------------------------------------------------------------ sales orders
export function SalesOrders() {
  const { tt } = useI18n();
  const { can } = useSession();
  const act = useAct();
  const [editor, setEditor] = useState(false);
  const [k, setK] = useState(0);
  return <>
    <OrderList path="/sales-orders" title={tt("أوامر البيع", "Sales orders")} statuses={["draft", "confirmed", "partially_delivered", "delivered", "closed", "cancelled"]} partyLabel={tt("العميل", "Customer")}
      newLabel={tt("أمر بيع جديد", "New sales order")} canCreate={can("sales.orders.manage")} onNew={() => setEditor(true)} reloadKey={k}
      extraCols={[{ h: tt("التسليم", "Delivery"), v: (r) => r.delivery_date ? date(r.delivery_date) : "" }, { h: tt("الدفع", "Payment"), v: (r) => r.payment_type === "cash" ? tt("نقدي", "Cash") : tt("آجل", "Credit") }]}
      renderDetail={(d, reload) => <>
        <div className="row"><b>{d.customer_code} {d.customer_name_ar}</b><span className="badge">{d.warehouse_code}</span>{d.quotation_number && <span className="muted">{tt("من العرض", "From quote")} {d.quotation_number}</span>}</div>
        <LinesTable rows={d.lines} cols={salesLineCols(tt, true)} />
        <div className="row"><span className="spacer" /><span>{tt("الإجمالي", "Total")}: <b className="num">{money(d.total)}</b></span></div>
        {d.invoices.length > 0 && <div><b>{tt("الفواتير", "Invoices")}</b>
          <LinesTable rows={d.invoices} cols={[{ h: tt("الرقم", "No."), v: (i: any) => i.number ?? tt("مسودة", "Draft") }, { h: tt("التاريخ", "Date"), v: (i: any) => date(i.invoice_date) },
            { h: tt("الحالة", "Status"), v: (i: any) => <Badge s={i.status} /> }, { h: tt("الإجمالي", "Total"), v: (i: any) => money(i.total), end: true }]} />
          {d.invoices.some((i: any) => i.status === "draft") && <div className="alert info">{tt("الفاتورة المسودة تُرحَّل من شاشة فواتير المبيعات (شخص آخر غير منشئها)؛ عند ترحيلها يُخصم المخزون ويُحدَّث الأمر.",
            "Post the draft invoice from Sales invoices (by someone other than its creator); posting moves stock and updates the order.")}</div>}</div>}
        <div className="row">
          {d.status === "draft" && <button className="btn primary" onClick={() => act(() => api.post(`/sales-orders/${d.id}/confirm`, {}), tt("تأكّد الأمر وحُجزت الكميات", "Confirmed and stock reserved"), reload)}>{tt("تأكيد وحجز الكميات", "Confirm & reserve")}</button>}
          {d.status === "draft" && <button className="btn" onClick={() => act(() => api.post(`/sales-orders/${d.id}/confirm`, { allowBackorder: true }), tt("تأكّد الأمر (طلب مؤجل)", "Confirmed as backorder"), reload)}>{tt("تأكيد كطلب مؤجل", "Confirm as backorder")}</button>}
          {["confirmed", "partially_delivered"].includes(d.status) && can("sales.invoices.create") && <button className="btn primary" onClick={() => act(() => api.post(`/sales-orders/${d.id}/invoice`, { invoiceDate: today() }),
            tt("أُنشئت فاتورة مسودة بالكميات المتبقية", "Draft invoice created for the remaining quantities"), reload)}>{tt("فوترة المتبقي", "Invoice remaining")}</button>}
          {!["delivered", "closed", "cancelled"].includes(d.status) && <button className="btn danger" onClick={() => { const r = prompt(tt("سبب الإلغاء / الإغلاق", "Reason")); if (r) act(() => api.post(`/sales-orders/${d.id}/close`, { reason: r }), tt("أُغلق الأمر", "Order closed"), reload); }}>
            {d.status === "partially_delivered" ? tt("إغلاق المتبقي", "Close the rest") : tt("إلغاء الأمر", "Cancel order")}</button>}
        </div>
      </>} />
    {editor && <SalesDocEditor kind="order" onClose={() => setEditor(false)} onSaved={() => { setEditor(false); setK(k + 1); }} />}
  </>;
}

function SalesDocEditor({ kind, onClose, onSaved }: { kind: "quotation" | "order"; onClose: () => void; onSaved: () => void }) {
  const { t, tt } = useI18n();
  const { companyId } = useSession();
  const { items, warehouses } = useLookups();
  const customers = useAsync(() => api.get(`/customers?companyId=${companyId}&pageSize=200&active=true`), [companyId]);
  const [key] = useState(() => crypto.randomUUID());
  const [h, setH] = useState({ customerId: "", warehouseId: "", date: today(), deliveryDate: "", paymentType: "credit", notes: "" });
  const [lines, setLines] = useState<any[]>([{ itemId: "", uomId: "", qty: "", unitPrice: "", discountPct: "" }]);
  const [err, setErr] = useState<unknown>(null);
  const set = (i: number, p: any) => setLines(lines.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const sellable = warehouses.filter((w: any) => w.is_sellable !== false);
  const save = async () => {
    setErr(null);
    const ls = lines.filter((l) => l.itemId).map((l) => ({ itemId: l.itemId, uomId: l.uomId || null, qty: l.qty, ...(l.unitPrice ? { unitPrice: l.unitPrice } : {}), ...(l.discountPct ? { discountPct: l.discountPct } : {}) }));
    try {
      if (kind === "quotation") await api.post("/sales-quotations", { companyId, customerId: h.customerId, quoteDate: h.date, notes: h.notes || undefined, lines: ls }, { idempotencyKey: key });
      else await api.post("/sales-orders", { companyId, customerId: h.customerId, warehouseId: h.warehouseId || sellable[0]?.id, orderDate: h.date, deliveryDate: h.deliveryDate || undefined,
        paymentType: h.paymentType, notes: h.notes || undefined, lines: ls }, { idempotencyKey: key });
      onSaved();
    } catch (e) { setErr(e); }
  };
  return <Modal title={kind === "quotation" ? tt("عرض سعر جديد", "New quotation") : tt("أمر بيع جديد", "New sales order")} onClose={onClose}
    footer={<><button className="btn" onClick={onClose}>{t.cancel}</button><button className="btn primary" onClick={save}>{t.save}</button></>}>
    <ErrorBox error={err} />
    <div className="form-grid" style={{ marginBottom: 12 }}>
      <Field label={tt("العميل", "Customer")}><select value={h.customerId} onChange={(e) => setH({ ...h, customerId: e.target.value })}><option value="">—</option>
        {customers.data?.data.map((c: any) => <option key={c.id} value={c.id}>{c.code} {c.name_ar}</option>)}</select></Field>
      {kind === "order" && <Field label={t.warehouse}><select value={h.warehouseId} onChange={(e) => setH({ ...h, warehouseId: e.target.value })}>{sellable.map((w: any) => <option key={w.id} value={w.id}>{w.code} {w.name_ar}</option>)}</select></Field>}
      <Field label={t.date}><input type="date" value={h.date} onChange={(e) => setH({ ...h, date: e.target.value })} /></Field>
      {kind === "order" && <Field label={tt("تاريخ التسليم", "Delivery date")}><input type="date" value={h.deliveryDate} onChange={(e) => setH({ ...h, deliveryDate: e.target.value })} /></Field>}
      {kind === "order" && <Field label={tt("الدفع", "Payment")}><select value={h.paymentType} onChange={(e) => setH({ ...h, paymentType: e.target.value })}>
        <option value="credit">{tt("آجل (يُفحص حد الائتمان)", "Credit (limit checked)")}</option><option value="cash">{tt("نقدي", "Cash")}</option></select></Field>}
      <Field label={tt("ملاحظات", "Notes")}><input value={h.notes} onChange={(e) => setH({ ...h, notes: e.target.value })} /></Field>
    </div>
    <div className="table-wrap"><table>
      <thead><tr><th>{tt("الصنف", "Item")}</th><th>{tt("الوحدة", "Unit")}</th><th>{tt("الكمية", "Qty")}</th><th>{tt("السعر (اتركه للسعر المعتمد)", "Price (blank = list/customer)")}</th><th>{tt("خصم %", "Disc. %")}</th><th /></tr></thead>
      <tbody>{lines.map((l, i) => {
        const item = items.find((x: any) => x.id === l.itemId);
        return <tr key={i}>
          <td style={{ minWidth: 180 }}><select value={l.itemId} onChange={(e) => set(i, { itemId: e.target.value, uomId: "" })}><option value="">—</option>{items.filter((x: any) => x.kind === "finished" || x.kind === "service" || x.sales_price).map((x: any) => <option key={x.id} value={x.id}>{x.code} {x.name_ar}</option>)}</select></td>
          <td><select value={l.uomId} onChange={(e) => set(i, { uomId: e.target.value })}><option value="">{item?.base_uom_code ?? "—"}</option>{item?.units?.map((u: any) => <option key={u.uomId} value={u.uomId}>{u.code} ×{Number(u.factor)}</option>)}</select></td>
          <td><input className="num" style={{ width: 80 }} value={l.qty} onChange={(e) => set(i, { qty: e.target.value })} /></td>
          <td><input className="num" style={{ width: 110 }} value={l.unitPrice} onChange={(e) => set(i, { unitPrice: e.target.value })} placeholder={item?.sales_price ? String(Number(item.sales_price)) : ""} /></td>
          <td><input className="num" style={{ width: 70 }} value={l.discountPct} onChange={(e) => set(i, { discountPct: e.target.value })} /></td>
          <td>{lines.length > 1 && <button className="btn sm" onClick={() => setLines(lines.filter((_, j) => j !== i))}>✕</button>}</td>
        </tr>;
      })}</tbody></table></div>
    <button className="btn sm" style={{ marginTop: 8 }} onClick={() => setLines([...lines, { itemId: "", uomId: "", qty: "", unitPrice: "", discountPct: "" }])}>+ {tt("سطر", "Line")}</button>
  </Modal>;
}

// ------------------------------------------------------------------ purchase orders
export function PurchaseOrders() {
  const { tt } = useI18n();
  const { can, me } = useSession();
  const act = useAct();
  const [editor, setEditor] = useState(false);
  const [receiving, setReceiving] = useState<any>(null);
  const [k, setK] = useState(0);
  return <>
    <OrderList path="/purchase-orders" title={tt("أوامر الشراء", "Purchase orders")} statuses={["draft", "pending_approval", "approved", "partially_received", "received", "rejected", "closed", "cancelled"]}
      partyLabel={tt("المورد", "Supplier")} newLabel={tt("أمر شراء جديد", "New purchase order")} canCreate={can("purchasing.orders.manage")} onNew={() => setEditor(true)} reloadKey={k}
      extraCols={[{ h: tt("متوقع", "Expected"), v: (r) => r.expected_date ? date(r.expected_date) : "" }]}
      renderDetail={(d, reload) => <>
        <div className="row"><b>{d.supplier_code} {d.supplier_name_ar}</b><span className="badge">{d.warehouse_code}</span>
          <span className="muted">{tt("أنشأه", "By")} {d.created_by_name}{d.approved_by_name ? ` · ${tt("اعتمده", "approved by")} ${d.approved_by_name}` : ""}</span></div>
        <LinesTable rows={d.lines} cols={[{ h: tt("الصنف", "Item"), v: (l: any) => `${l.item_code} ${l.item_name_ar}` }, { h: tt("الكمية", "Qty"), v: (l: any) => `${Number(l.qty)} ${l.uom_code}` },
          { h: tt("التكلفة", "Cost"), v: (l: any) => money(l.unit_cost), end: true }, { h: tt("المستلم (أساسي)", "Received (base)"), v: (l: any) => `${Number(l.received_base_qty)} / ${Number(l.base_qty)}`, end: true },
          { h: tt("الإجمالي", "Total"), v: (l: any) => money(l.line_total), end: true }]} />
        <div className="row"><span className="spacer" /><span>{tt("الإجمالي", "Total")}: <b className="num">{money(d.total)}</b></span></div>
        {d.decision_reason && <div className="alert">{tt("ملاحظة القرار", "Decision note")}: {d.decision_reason}</div>}
        {d.receipts.length > 0 && <LinesTable rows={d.receipts} cols={[{ h: tt("إذن الاستلام", "Receipt"), v: (r: any) => r.number ?? tt("مسودة", "Draft") }, { h: tt("التاريخ", "Date"), v: (r: any) => date(r.receipt_date) },
          { h: tt("الحالة", "Status"), v: (r: any) => <Badge s={r.status} /> }, { h: tt("الإجمالي", "Total"), v: (r: any) => money(r.total), end: true }]} />}
        {d.status === "pending_approval" && d.created_by === me!.user.id && <div className="alert info">{tt("يعتمده شخص آخر لديه صلاحية اعتماد أوامر الشراء (فصل المهام).", "Another user with approval rights must approve it (segregation of duties).")}</div>}
        <div className="row">
          {d.status === "draft" && can("purchasing.orders.manage") && <button className="btn primary" onClick={() => act(() => api.post(`/purchase-orders/${d.id}/submit`, {}), tt("أُرسل الأمر", "Submitted"), reload)}>{tt("إرسال للاعتماد", "Submit")}</button>}
          {d.status === "pending_approval" && can("purchasing.orders.approve") && d.created_by !== me!.user.id && <>
            <button className="btn primary" onClick={() => act(() => api.post(`/purchase-orders/${d.id}/decide`, { decision: "approved" }), tt("اعتُمد الأمر", "Approved"), reload)}>{tt("اعتماد", "Approve")}</button>
            <button className="btn danger" onClick={() => { const r = prompt(tt("سبب الرفض", "Reason")); if (r) act(() => api.post(`/purchase-orders/${d.id}/decide`, { decision: "rejected", reason: r }), tt("رُفض الأمر", "Rejected"), reload); }}>{tt("رفض", "Reject")}</button></>}
          {["approved", "partially_received"].includes(d.status) && can("purchasing.receipts.create") && <button className="btn primary" onClick={() => setReceiving(d)}>{tt("استلام بضاعة", "Receive goods")}</button>}
          {!["received", "closed", "cancelled", "rejected"].includes(d.status) && can("purchasing.orders.manage") && <button className="btn danger" onClick={() => { const r = prompt(tt("السبب", "Reason")); if (r) act(() => api.post(`/purchase-orders/${d.id}/close`, { reason: r }), tt("أُغلق الأمر", "Closed"), reload); }}>
            {d.status === "partially_received" ? tt("إغلاق المتبقي", "Close the rest") : tt("إلغاء", "Cancel")}</button>}
        </div>
      </>} />
    {editor && <PoEditor onClose={() => setEditor(false)} onSaved={() => { setEditor(false); setK(k + 1); }} />}
    {receiving && <ReceiveFromPo po={receiving} onClose={() => setReceiving(null)} onSaved={() => { setReceiving(null); setK(k + 1); }} />}
  </>;
}

function PoEditor({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { t, tt } = useI18n();
  const { companyId } = useSession();
  const { items, warehouses } = useLookups();
  const suppliers = useAsync(() => api.get(`/suppliers?companyId=${companyId}&pageSize=200&active=true`), [companyId]);
  const settings = useAsync(() => api.get(`/order-settings?companyId=${companyId}`), [companyId]);
  const [key] = useState(() => crypto.randomUUID());
  const [h, setH] = useState({ supplierId: "", warehouseId: "", orderDate: today(), expectedDate: "", notes: "" });
  const [lines, setLines] = useState<any[]>([{ itemId: "", uomId: "", qty: "", unitCost: "" }]);
  const [err, setErr] = useState<unknown>(null);
  const set = (i: number, p: any) => setLines(lines.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const total = lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unitCost) || 0), 0);
  const save = async () => {
    setErr(null);
    try {
      await api.post("/purchase-orders", { companyId, ...h, warehouseId: h.warehouseId || warehouses[0]?.id, expectedDate: h.expectedDate || undefined, notes: h.notes || undefined,
        lines: lines.filter((l) => l.itemId).map((l) => ({ itemId: l.itemId, uomId: l.uomId || null, qty: l.qty, unitCost: l.unitCost })) }, { idempotencyKey: key });
      onSaved();
    } catch (e) { setErr(e); }
  };
  const th = Number(settings.data?.po_approval_threshold ?? 0);
  return <Modal title={tt("أمر شراء جديد", "New purchase order")} onClose={onClose} footer={<><button className="btn" onClick={onClose}>{t.cancel}</button><button className="btn primary" onClick={save}>{t.save}</button></>}>
    <ErrorBox error={err} />
    {settings.data && <div className="alert info">{th > 0 ? tt(`الأوامر حتى ${th} تُعتمد تلقائيًا عند الإرسال، وما فوقها يحتاج اعتمادًا من شخص آخر.`, `Orders up to ${th} are auto-approved on submit; above that another user must approve.`)
      : tt("كل أمر شراء يحتاج اعتمادًا من شخص آخر.", "Every purchase order needs approval by another user.")}</div>}
    <div className="form-grid" style={{ marginBottom: 12 }}>
      <Field label={tt("المورد", "Supplier")}><select value={h.supplierId} onChange={(e) => setH({ ...h, supplierId: e.target.value })}><option value="">—</option>{suppliers.data?.data.map((s: any) => <option key={s.id} value={s.id}>{s.code} {s.name_ar}</option>)}</select></Field>
      <Field label={tt("مخزن الاستلام", "Receiving warehouse")}><select value={h.warehouseId} onChange={(e) => setH({ ...h, warehouseId: e.target.value })}>{warehouses.map((w: any) => <option key={w.id} value={w.id}>{w.code} {w.name_ar}</option>)}</select></Field>
      <Field label={t.date}><input type="date" value={h.orderDate} onChange={(e) => setH({ ...h, orderDate: e.target.value })} /></Field>
      <Field label={tt("الوصول المتوقع", "Expected")}><input type="date" value={h.expectedDate} onChange={(e) => setH({ ...h, expectedDate: e.target.value })} /></Field>
    </div>
    <div className="table-wrap"><table>
      <thead><tr><th>{tt("الصنف", "Item")}</th><th>{tt("الوحدة", "Unit")}</th><th>{tt("الكمية", "Qty")}</th><th>{tt("تكلفة الوحدة", "Unit cost")}</th><th /></tr></thead>
      <tbody>{lines.map((l, i) => {
        const item = items.find((x: any) => x.id === l.itemId);
        return <tr key={i}>
          <td style={{ minWidth: 180 }}><select value={l.itemId} onChange={(e) => set(i, { itemId: e.target.value, uomId: "" })}><option value="">—</option>{items.filter((x: any) => x.kind !== "service").map((x: any) => <option key={x.id} value={x.id}>{x.code} {x.name_ar}</option>)}</select></td>
          <td><select value={l.uomId} onChange={(e) => set(i, { uomId: e.target.value })}><option value="">{item?.base_uom_code ?? "—"}</option>{item?.units?.map((u: any) => <option key={u.uomId} value={u.uomId}>{u.code} ×{Number(u.factor)}</option>)}</select></td>
          <td><input className="num" style={{ width: 80 }} value={l.qty} onChange={(e) => set(i, { qty: e.target.value })} /></td>
          <td><input className="num" style={{ width: 100 }} value={l.unitCost} onChange={(e) => set(i, { unitCost: e.target.value })} /></td>
          <td>{lines.length > 1 && <button className="btn sm" onClick={() => setLines(lines.filter((_, j) => j !== i))}>✕</button>}</td>
        </tr>;
      })}</tbody></table></div>
    <div className="row" style={{ marginTop: 8 }}><button className="btn sm" onClick={() => setLines([...lines, { itemId: "", uomId: "", qty: "", unitCost: "" }])}>+ {tt("سطر", "Line")}</button>
      <span className="spacer" /><span>{tt("الإجمالي التقديري", "Estimated total")}: <b className="num">{money(total.toFixed(3))}</b></span></div>
  </Modal>;
}

function ReceiveFromPo({ po, onClose, onSaved }: { po: any; onClose: () => void; onSaved: () => void }) {
  const { t, tt } = useI18n();
  const [key] = useState(() => crypto.randomUUID());
  const open = po.lines.filter((l: any) => Number(l.remaining_base_qty) > 0);
  const [rows, setRows] = useState<any[]>(() => open.map((l: any) => ({ orderLineId: l.id, qty: String(Number(l.remaining_base_qty) / Number(l.factor)), lotNo: "", productionDate: "", expiryDate: "" })));
  const [h, setH] = useState({ receiptDate: today(), supplierRef: "" });
  const [err, setErr] = useState<unknown>(null);
  const set = (i: number, p: any) => setRows(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const save = async () => {
    setErr(null);
    try {
      await api.post(`/purchase-orders/${po.id}/receive`, { ...h, supplierRef: h.supplierRef || undefined,
        lines: rows.filter((r) => Number(r.qty) > 0).map((r) => ({ orderLineId: r.orderLineId, qty: r.qty, ...(r.lotNo ? { lotNo: r.lotNo } : {}),
          ...(r.productionDate ? { productionDate: r.productionDate } : {}), ...(r.expiryDate ? { expiryDate: r.expiryDate } : {}) })) }, { idempotencyKey: key });
      onSaved();
    } catch (e) { setErr(e); }
  };
  return <Modal title={`${tt("استلام من", "Receive from")} ${po.number}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>{t.cancel}</button><button className="btn primary" onClick={save}>{t.save} ({t.draft})</button></>}>
    <div className="alert info">{tt("يُنشأ إذن استلام مسودة بتكلفة أمر الشراء؛ يرحّله شخص آخر من شاشة أذونات الاستلام فيدخل المخزون.", "A draft goods receipt is created at the ordered cost; another user posts it from Goods receipts to add the stock.")}</div>
    <ErrorBox error={err} />
    <div className="form-grid" style={{ marginBottom: 12 }}>
      <Field label={t.date}><input type="date" value={h.receiptDate} onChange={(e) => setH({ ...h, receiptDate: e.target.value })} /></Field>
      <Field label={tt("مرجع المورد", "Supplier ref.")}><input value={h.supplierRef} onChange={(e) => setH({ ...h, supplierRef: e.target.value })} /></Field>
    </div>
    <div className="table-wrap"><table>
      <thead><tr><th>{tt("الصنف", "Item")}</th><th>{tt("المتبقي", "Remaining")}</th><th>{tt("المستلم الآن", "Receive now")}</th><th>{tt("التشغيلة", "Lot")}</th><th>{tt("إنتاج", "Prod.")}</th><th>{tt("انتهاء", "Expiry")}</th></tr></thead>
      <tbody>{open.map((l: any, i: number) => <tr key={l.id}>
        <td>{l.item_code} {l.item_name_ar}</td><td className="num">{Number(l.remaining_base_qty) / Number(l.factor)} {l.uom_code}</td>
        <td><input className="num" style={{ width: 80 }} value={rows[i].qty} onChange={(e) => set(i, { qty: e.target.value })} /></td>
        <td><input dir="ltr" style={{ width: 100 }} value={rows[i].lotNo} onChange={(e) => set(i, { lotNo: e.target.value })} placeholder={l.track_lots ? t.required : ""} /></td>
        <td><input type="date" value={rows[i].productionDate} onChange={(e) => set(i, { productionDate: e.target.value })} /></td>
        <td><input type="date" value={rows[i].expiryDate} onChange={(e) => set(i, { expiryDate: e.target.value })} /></td>
      </tr>)}</tbody></table></div>
  </Modal>;
}
