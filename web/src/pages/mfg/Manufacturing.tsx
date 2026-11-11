import { useState } from "react";
import { api, fmt, fmtDate } from "../../api";
import { useI18n } from "../../i18n";
import { useSession } from "../../session";
import { Empty, ErrorBox, Field, Loading, Modal, StatusBadge, errMsg, useAsync, useToast } from "../../ui";
import { LinesTable, today, useLookups } from "../erp/shared";

// ------------------------------------------------------------------ formulas
export function Formulas() {
  const { t, tt, lang } = useI18n();
  const { can, companyId } = useSession();
  const { toast } = useToast();
  const { items } = useLookups();
  const list = useAsync(() => api.get(`/manufacturing/boms?companyId=${companyId}`), [companyId]);
  const [open, setOpen] = useState<string | null>(null);
  const [f, setF] = useState<any | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const detail = useAsync(() => (open ? api.get(`/manufacturing/boms/${open}`) : Promise.resolve(null)), [open]);
  const products = items.filter((i: any) => i.kind === "finished" || i.kind === "semi_finished");
  const comps = items.filter((i: any) => i.kind !== "service" && i.kind !== "finished");
  const save = async () => {
    setErr(null);
    try {
      await api.post("/manufacturing/boms", { companyId, itemId: f.itemId, batchQty: f.batchQty, stdScrapPct: f.stdScrapPct || "0", stdHours: f.stdHours || "0", notes: f.notes || undefined,
        lines: f.lines.filter((l: any) => l.itemId).map((l: any) => ({ itemId: l.itemId, qty: l.qty, scrapPct: l.scrapPct || "0", substituteItemId: l.substituteItemId || null })) });
      setF(null); list.reload(); toast(t.savedOk);
    } catch (e) { setErr(e); }
  };
  const approve = async () => { try { await api.post(`/manufacturing/boms/${open}/approve`); toast(t.savedOk); detail.reload(); list.reload(); } catch (e) { toast(errMsg(e, lang), true); } };
  const setL = (i: number, p: any) => setF({ ...f, lines: f.lines.map((l: any, j: number) => (j === i ? { ...l, ...p } : l)) });
  return <>
    <div className="page-head"><div><h1>{tt("الوصفات وقوائم المواد", "Formulas / BOMs")}</h1><p>{tt("كل تعديل على وصفة معتمدة = إصدار جديد يحتاج اعتمادًا.", "Changing an approved formula creates a new version that needs approval.")}</p></div>
      {can("manufacturing.boms.manage") && <button className="btn primary" onClick={() => setF({ itemId: "", batchQty: "1000", lines: [{ itemId: "", qty: "" }] })}>{t.add}</button>}</div>
    <ErrorBox error={list.error} />
    {list.loading ? <Loading /> : !list.data?.length ? <div className="card"><Empty /></div> : <div className="table-wrap"><table>
      <thead><tr><th>{tt("المنتج", "Product")}</th><th>{tt("الإصدار", "Version")}</th><th>{tt("حجم الدفعة", "Batch")}</th><th>{tt("المكونات", "Components")}</th><th>{tt("هدر معياري", "Std scrap")}</th><th>{t.status}</th></tr></thead>
      <tbody>{list.data.map((b: any) => <tr key={b.id} style={{ cursor: "pointer" }} onClick={() => setOpen(b.id)}><td>{b.item_code} {b.item_name_ar}</td><td className="num">v{b.version}</td>
        <td className="num">{fmt(b.batch_qty, 0)}</td><td className="num">{b.components}</td><td className="num">{Number(b.std_scrap_pct)}%</td><td><StatusBadge s={b.status === "approved" ? "posted" : b.status === "draft" ? "draft" : "closed"} /> {b.status}</td></tr>)}</tbody>
    </table></div>}
    {open && <Modal title={detail.data ? `${detail.data.item_code} v${detail.data.version}` : "…"} onClose={() => setOpen(null)}
      footer={detail.data?.status === "draft" && can("manufacturing.boms.approve") && <button className="btn primary" onClick={approve}>{tt("اعتماد الإصدار", "Approve version")}</button>}>
      {detail.loading ? <Loading /> : detail.data && <div className="grid">
        <div className="row"><span className="badge">{tt("الدفعة", "Batch")} {fmt(detail.data.batch_qty, 0)} {detail.data.uom}</span><span className="badge">{tt("ساعات قياسية", "Std hours")} {Number(detail.data.std_hours)}</span>
          {detail.data.status === "draft" && <span className="alert info" style={{ margin: 0 }}>{t.sodHint}</span>}</div>
        <LinesTable rows={detail.data.lines} cols={[{ h: tt("المكون", "Component"), v: (l) => `${l.item_code} ${l.item_name_ar}` }, { h: tt("الكمية/دفعة", "Qty/batch"), v: (l) => `${Number(l.qty)} ${l.uom}` },
          { h: tt("هدر%", "Scrap%"), v: (l) => Number(l.scrap_pct) }, { h: tt("بديل معتمد", "Substitute"), v: (l) => l.substitute_code ?? "" }]} />
        <h3>{tt("التكلفة المعيارية (بمتوسط التكلفة الحالي)", "Standard cost (current average costs)")}</h3>
        <LinesTable rows={detail.data.standardCost.parts} cols={[{ h: tt("المكون", "Component"), v: (p) => p.code }, { h: tt("الكمية مع الهدر", "Qty incl. scrap"), v: (p) => Number(p.qty) },
          { h: tt("متوسط التكلفة", "Avg cost"), v: (p) => p.unitCost === null ? <span className="badge warn">{tt("لا رصيد", "no stock")}</span> : fmt(p.unitCost, 4), end: true }, { h: t.amount, v: (p) => p.cost ? fmt(p.cost) : "—", end: true }]} />
        <div className="balance-bar"><span>{tt("مواد", "Material")} <b className="num">{fmt(detail.data.standardCost.material)}</b></span><span>{tt("تحويل", "Conversion")} <b className="num">{fmt(detail.data.standardCost.conversion)}</b></span>
          <span>{tt("تكلفة الوحدة", "Unit cost")} <b className="num">{fmt(detail.data.standardCost.unitCost, 4)}</b></span></div>
      </div>}
    </Modal>}
    {f && <Modal title={tt("وصفة / إصدار جديد", "New formula version")} onClose={() => setF(null)} footer={<><button className="btn" onClick={() => setF(null)}>{t.cancel}</button><button className="btn primary" onClick={save}>{t.save}</button></>}>
      <ErrorBox error={err} />
      <div className="form-grid" style={{ marginBottom: 12 }}>
        <Field label={tt("المنتج", "Product")}><select value={f.itemId} onChange={(e) => setF({ ...f, itemId: e.target.value })}><option value="">—</option>{products.map((i: any) => <option key={i.id} value={i.id}>{i.code} {i.name_ar}</option>)}</select></Field>
        <Field label={tt("الإنتاج لكل دفعة (وحدة أساسية)", "Output per batch (base unit)")}><input className="num" value={f.batchQty} onChange={(e) => setF({ ...f, batchQty: e.target.value })} /></Field>
        <Field label={tt("هدر معياري %", "Std scrap %")}><input className="num" value={f.stdScrapPct ?? ""} onChange={(e) => setF({ ...f, stdScrapPct: e.target.value })} /></Field>
        <Field label={tt("ساعات خط/دفعة", "Line hours/batch")}><input className="num" value={f.stdHours ?? ""} onChange={(e) => setF({ ...f, stdHours: e.target.value })} /></Field>
      </div>
      {f.lines.map((l: any, i: number) => <div className="row" key={i} style={{ marginBottom: 6 }}>
        <select value={l.itemId} onChange={(e) => setL(i, { itemId: e.target.value })} style={{ flex: 2 }}><option value="">{tt("المكون", "Component")}</option>{comps.map((x: any) => <option key={x.id} value={x.id}>{x.code} {x.name_ar} ({x.base_uom_code})</option>)}</select>
        <input className="num" placeholder={tt("الكمية/دفعة", "Qty/batch")} value={l.qty} onChange={(e) => setL(i, { qty: e.target.value })} style={{ width: 100 }} />
        <input className="num" placeholder={tt("هدر%", "Scrap%")} value={l.scrapPct ?? ""} onChange={(e) => setL(i, { scrapPct: e.target.value })} style={{ width: 80 }} />
        <select value={l.substituteItemId ?? ""} onChange={(e) => setL(i, { substituteItemId: e.target.value })} style={{ flex: 1 }}><option value="">{tt("بديل (اختياري)", "Substitute (opt.)")}</option>{comps.map((x: any) => <option key={x.id} value={x.id}>{x.code}</option>)}</select>
      </div>)}
      <button className="btn sm" onClick={() => setF({ ...f, lines: [...f.lines, { itemId: "", qty: "" }] })}>+ {t.addLine}</button>
    </Modal>}
  </>;
}

// ------------------------------------------------------------------ production orders
export function ProductionOrders() {
  const { t, tt, lang } = useI18n();
  const { can, companyId } = useSession();
  const { toast } = useToast();
  const { items, warehouses } = useLookups();
  const [status, setStatus] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [f, setF] = useState<any | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const list = useAsync(() => api.get(`/manufacturing/orders?companyId=${companyId}&pageSize=100${status ? `&status=${status}` : ""}`), [companyId, status]);
  const wcs = useAsync(() => api.get(`/manufacturing/work-centers?companyId=${companyId}`), [companyId]);
  const save = async () => {
    setErr(null);
    try { await api.post("/manufacturing/orders", { companyId, ...f, workCenterId: f.workCenterId || null }, { idempotencyKey: f.key }); setF(null); list.reload(); toast(t.savedOk); } catch (e) { setErr(e); }
  };
  const qc = warehouses.filter((w: any) => w.kind === "quarantine");
  const addWc = async () => {
    const code = prompt(tt("رمز الخط (مثل LINE1)", "Line code (e.g. LINE1)"))?.toUpperCase(); if (!code) return;
    const rate = prompt(tt("تكلفة الساعة (عمالة + طاقة + غير مباشرة)", "Cost per hour (labour + energy + overhead)"), "0") ?? "0";
    try { await api.post("/manufacturing/work-centers", { companyId, code, nameAr: code, ratePerHour: rate }); wcs.reload(); } catch (e) { toast(errMsg(e, lang), true); }
  };
  return <>
    <div className="page-head"><h1>{tt("أوامر الإنتاج", "Production orders")}</h1><div className="row">
      <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: "auto" }}><option value="">{t.status}: *</option>{["draft", "released", "in_progress", "completed"].map((s) => <option key={s}>{s}</option>)}</select>
      {can("manufacturing.orders.manage") && <button className="btn" onClick={addWc}>+ {tt("خط إنتاج", "Work center")}</button>}
      {can("manufacturing.orders.manage") && <button className="btn primary" onClick={() => setF({ key: crypto.randomUUID(), itemId: "", plannedQty: "", plannedDate: today(), materialWarehouseId: warehouses.find((w: any) => w.kind === "raw_materials")?.id ?? "", outputWarehouseId: qc[0]?.id ?? "" })}>{t.add}</button>}
    </div></div>
    <ErrorBox error={list.error} />
    {list.loading ? <Loading /> : !list.data?.data.length ? <div className="card"><Empty /></div> : <div className="table-wrap"><table>
      <thead><tr><th>{t.number}</th><th>{t.date}</th><th>{tt("المنتج", "Product")}</th><th className="end">{tt("المخطط", "Planned")}</th><th className="end">{tt("المنتج فعليًا", "Produced")}</th><th>{tt("التشغيلة", "Lot")}</th><th className="end">{tt("التكلفة الفعلية", "Actual cost")}</th><th>{t.status}</th></tr></thead>
      <tbody>{list.data.data.map((o: any) => <tr key={o.id} style={{ cursor: "pointer" }} onClick={() => setOpen(o.id)}><td className="num">{o.number ?? "—"}</td><td className="num">{fmtDate(o.planned_date)}</td>
        <td>{o.item_code} {o.item_name_ar}</td><td className="end num">{fmt(o.planned_qty, 0)}</td><td className="end num">{o.produced_qty ? fmt(o.produced_qty, 0) : ""}</td><td>{o.output_lot_no}</td>
        <td className="end num">{o.actual_cost ? fmt(o.actual_cost) : ""}</td><td><span className="badge">{o.status}</span></td></tr>)}</tbody>
    </table></div>}
    {open && <OrderDetail id={open} onClose={() => { setOpen(null); list.reload(); }} />}
    {f && <Modal title={tt("أمر إنتاج جديد", "New production order")} onClose={() => setF(null)} footer={<><button className="btn" onClick={() => setF(null)}>{t.cancel}</button><button className="btn primary" onClick={save}>{t.save}</button></>}>
      <div className="alert info">{tt("يُستلم الإنتاج التام في مخزن الحجر، ولا يُباع إلا بعد نجاح فحص الجودة والإفراج.", "Output is received into quarantine and becomes sellable only after a passed QC check and release.")}</div>
      <ErrorBox error={err} />
      <div className="form-grid">
        <Field label={tt("المنتج", "Product")}><select value={f.itemId} onChange={(e) => setF({ ...f, itemId: e.target.value })}><option value="">—</option>{items.filter((i: any) => i.kind === "finished" || i.kind === "semi_finished").map((i: any) => <option key={i.id} value={i.id}>{i.code} {i.name_ar}</option>)}</select></Field>
        <Field label={tt("الكمية المخططة", "Planned qty")}><input className="num" value={f.plannedQty} onChange={(e) => setF({ ...f, plannedQty: e.target.value })} /></Field>
        <Field label={t.date}><input type="date" value={f.plannedDate} onChange={(e) => setF({ ...f, plannedDate: e.target.value })} /></Field>
        <Field label={tt("خط الإنتاج", "Work center")}><select value={f.workCenterId ?? ""} onChange={(e) => setF({ ...f, workCenterId: e.target.value })}><option value="">—</option>{wcs.data?.map((w: any) => <option key={w.id} value={w.id}>{w.code} ({fmt(w.rate_per_hour)}/h)</option>)}</select></Field>
        <Field label={tt("مخزن المواد", "Material warehouse")}><select value={f.materialWarehouseId} onChange={(e) => setF({ ...f, materialWarehouseId: e.target.value })}>{warehouses.map((w: any) => <option key={w.id} value={w.id}>{w.code} ({w.kind})</option>)}</select></Field>
        <Field label={tt("مخزن الاستلام (حجر)", "Output (quarantine)")}><select value={f.outputWarehouseId} onChange={(e) => setF({ ...f, outputWarehouseId: e.target.value })}>{qc.map((w: any) => <option key={w.id} value={w.id}>{w.code}</option>)}</select></Field>
      </div>
    </Modal>}
  </>;
}

function OrderDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { t, tt, lang } = useI18n();
  const { can } = useSession();
  const { toast } = useToast();
  const d = useAsync(() => api.get(`/manufacturing/orders/${id}`), [id]);
  const cost = useAsync(() => api.get(`/manufacturing/orders/${id}/cost`), [id]);
  const [issue, setIssue] = useState({ itemId: "", qty: "" });
  const [hours, setHours] = useState("");
  const [done, setDone] = useState({ producedQty: "", scrapQty: "", lotNo: "", productionDate: today() });
  const run = async (fn: () => Promise<unknown>) => { try { await fn(); toast(t.savedOk); d.reload(); cost.reload(); } catch (e) { toast(errMsg(e, lang), true); } };
  const o = d.data;
  return <Modal title={o ? `${o.number ?? t.draft} — ${o.item_code}` : "…"} onClose={onClose} footer={o && <>
    {o.status === "draft" && can("manufacturing.orders.release") && <button className="btn primary" onClick={() => run(() => api.post(`/manufacturing/orders/${id}/release`))}>{tt("تحرير الأمر", "Release")}</button>}
  </>}>
    {d.loading ? <Loading /> : o && <div className="grid">
      <div className="row"><span className="badge">{o.status}</span><span className="badge">{tt("مخطط", "Planned")} {fmt(o.planned_qty, 0)} {o.uom}</span><span className="badge">v{o.bom_version}</span>
        {o.work_center_code && <span className="badge">{o.work_center_code}</span>}<span className="badge">{o.material_warehouse_code} → {o.output_warehouse_code}</span>
        {o.std_unit_cost && <span className="badge info">{tt("معياري/وحدة", "Std/unit")} {fmt(o.std_unit_cost, 4)}</span>}</div>
      <h3>{tt("الاحتياجات والتوفر", "Requirements & availability")}</h3>
      <LinesTable rows={o.requirements} cols={[{ h: tt("المادة", "Material"), v: (r) => `${r.code} ${r.name}` }, { h: tt("المطلوب", "Required"), v: (r) => fmt(r.required, 2), end: true },
        { h: tt("المصروف", "Issued"), v: (r) => fmt(r.issued, 2), end: true }, { h: tt("المتاح (صالح)", "Available (valid)"), v: (r) => fmt(r.available, 2), end: true },
        { h: tt("العجز", "Shortage"), v: (r) => Number(r.shortage) > 0 ? <b style={{ color: "var(--bad)" }}>{fmt(r.shortage, 2)}</b> : "—", end: true }]} />
      {["released", "in_progress"].includes(o.status) && <div className="card grid">
        {can("manufacturing.execution.issue") && <div className="row"><b>{tt("صرف مواد", "Issue material")}</b>
          <select value={issue.itemId} onChange={(e) => setIssue({ ...issue, itemId: e.target.value })} style={{ width: 220 }}><option value="">—</option>{o.requirements.map((r: any) => <option key={r.itemId} value={r.itemId}>{r.code}</option>)}</select>
          <input className="num" placeholder={tt("الكمية", "Qty")} value={issue.qty} onChange={(e) => setIssue({ ...issue, qty: e.target.value })} style={{ width: 100 }} />
          <button className="btn" onClick={() => run(() => api.post(`/manufacturing/orders/${id}/issue`, { ...issue, entryDate: today() }, { idempotencyKey: crypto.randomUUID() }))}>{tt("صرف (FEFO)", "Issue (FEFO)")}</button></div>}
        {can("manufacturing.execution.time") && o.work_center_code && <div className="row"><b>{tt("ساعات التشغيل", "Line hours")}</b>
          <input className="num" value={hours} onChange={(e) => setHours(e.target.value)} style={{ width: 100 }} />
          <button className="btn" onClick={() => run(() => api.post(`/manufacturing/orders/${id}/time`, { hours, entryDate: today() }, { idempotencyKey: crypto.randomUUID() }))}>{tt("تسجيل", "Record")}</button></div>}
        {o.status === "in_progress" && can("manufacturing.orders.complete") && <div className="row"><b>{tt("إغلاق واستلام الإنتاج", "Complete & receive output")}</b>
          <input className="num" placeholder={tt("المنتج فعليًا", "Produced")} value={done.producedQty} onChange={(e) => setDone({ ...done, producedQty: e.target.value })} style={{ width: 100 }} />
          <input className="num" placeholder={tt("الهالك", "Scrap")} value={done.scrapQty} onChange={(e) => setDone({ ...done, scrapQty: e.target.value })} style={{ width: 80 }} />
          <input dir="ltr" placeholder={tt("رقم التشغيلة", "Lot no.")} value={done.lotNo} onChange={(e) => setDone({ ...done, lotNo: e.target.value })} style={{ width: 120 }} />
          <input type="date" value={done.productionDate} onChange={(e) => setDone({ ...done, productionDate: e.target.value })} style={{ width: 150 }} />
          <button className="btn primary" onClick={() => run(() => api.post(`/manufacturing/orders/${id}/complete`, { ...done, scrapQty: done.scrapQty || "0", entryDate: today() }, { idempotencyKey: crypto.randomUUID() }))}>{tt("إغلاق", "Complete")}</button></div>}
      </div>}
      {o.entries.length > 0 && <><h3>{tt("الحركات", "Entries")}</h3>
        <LinesTable rows={o.entries} cols={[{ h: t.date, v: (e) => fmtDate(e.entry_date) }, { h: t.type, v: (e) => e.kind }, { h: tt("المادة", "Material"), v: (e) => e.item_code ?? `${Number(e.hours)} h` },
          { h: tt("التشغيلة", "Lot"), v: (e) => e.lot_no ?? "" }, { h: tt("الكمية", "Qty"), v: (e) => e.qty ? Number(e.qty) : "" }, { h: tt("القيمة", "Value"), v: (e) => fmt(e.value), end: true }]} /></>}
      {cost.data && cost.data.actualTotal !== "0" && <><h3>{tt("التكلفة: فعلي مقابل معياري", "Cost: actual vs standard")}</h3>
        <LinesTable rows={cost.data.components} cols={[{ h: tt("المادة", "Material"), v: (c) => c.code }, { h: tt("معياري", "Std qty"), v: (c) => fmt(c.stdQty, 2), end: true },
          { h: tt("فعلي", "Actual qty"), v: (c) => fmt(c.actualQty, 2), end: true }, { h: tt("الانحراف%", "Var %"), v: (c) => c.qtyVariancePct === null ? "" : <span style={{ color: Number(c.qtyVariancePct) > 0 ? "var(--bad)" : "var(--ok)" }}>{c.qtyVariancePct}%</span>, end: true },
          { h: tt("القيمة", "Value"), v: (c) => fmt(c.actualValue), end: true }]} />
        <div className="balance-bar"><span>{tt("الإجمالي الفعلي", "Actual total")} <b className="num">{fmt(cost.data.actualTotal)}</b></span>
          {cost.data.actualUnitCost && <span>{tt("تكلفة الوحدة", "Unit cost")} <b className="num">{fmt(cost.data.actualUnitCost, 4)}</b></span>}
          {cost.data.standardUnitCost && <span>{tt("المعياري", "Standard")} <b className="num">{fmt(cost.data.standardUnitCost, 4)}</b></span>}
          {cost.data.yieldPct && <span>{tt("المردود", "Yield")} <b className="num">{cost.data.yieldPct}%</b></span>}
          {cost.data.costVariance && <span>{tt("الانحراف", "Variance")} <b className="num" style={{ color: Number(cost.data.costVariance) > 0 ? "var(--bad)" : "var(--ok)" }}>{fmt(cost.data.costVariance)}</b></span>}</div></>}
    </div>}
  </Modal>;
}

export function Mrp() {
  const { tt } = useI18n();
  const { companyId } = useSession();
  const d = useAsync(() => api.get(`/manufacturing/mrp?companyId=${companyId}`), [companyId]);
  return <>
    <div className="page-head"><div><h1>{tt("تخطيط الاحتياجات (MRP)", "Material requirements (MRP)")}</h1><p>{tt("صافي احتياجات الأوامر المفتوحة مقابل المخزون الصالح، مع اقتراح كميات الشراء.", "Net requirements of open orders vs valid stock, with purchase suggestions.")}</p></div></div>
    <ErrorBox error={d.error} />
    {d.loading ? <Loading /> : !d.data?.lines.length ? <div className="card"><Empty /></div> : <div className="table-wrap"><table>
      <thead><tr><th>{tt("المادة", "Material")}</th><th className="end">{tt("المطلوب", "Required")}</th><th className="end">{tt("المتوفر", "On hand")}</th><th className="end">{tt("العجز", "Shortage")}</th><th className="end">{tt("اقتراح شراء", "Suggested purchase")}</th></tr></thead>
      <tbody>{d.data.lines.map((l: any) => <tr key={l.id}><td>{l.code} {l.name_ar} ({l.uom})</td><td className="end num">{fmt(l.required, 2)}</td><td className="end num">{fmt(l.on_hand, 2)}</td>
        <td className="end num" style={{ color: Number(l.shortage) > 0 ? "var(--bad)" : undefined }}>{fmt(l.shortage, 2)}</td><td className="end num"><b>{Number(l.suggestedPurchase) > 0 ? fmt(l.suggestedPurchase, 2) : "—"}</b></td></tr>)}</tbody>
    </table></div>}
  </>;
}
