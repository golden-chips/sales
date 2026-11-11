import { useState } from "react";
import { api, fmt, fmtDate } from "../../api";
import { useI18n } from "../../i18n";
import { useSession } from "../../session";
import { Empty, ErrorBox, Loading, Modal, useAsync } from "../../ui";

export default function Stock() {
  const { tt, t } = useI18n();
  const { companyId } = useSession();
  const [wh, setWh] = useState("");
  const [low, setLow] = useState(false);
  const [lot, setLot] = useState<string | null>(null);
  const whs = useAsync(() => api.get("/warehouses"), []);
  const stock = useAsync(() => api.get(`/inventory/stock?companyId=${companyId}${wh ? `&warehouseId=${wh}` : ""}${low ? "&belowReorder=true" : ""}`), [companyId, wh, low]);
  const check = useAsync(() => api.get(`/inventory/valuation-check?companyId=${companyId}`), [companyId]);
  const trace = useAsync(() => (lot ? api.get(`/inventory/lots/${lot}/trace`) : Promise.resolve(null)), [lot]);
  const total = (stock.data ?? []).reduce((s: number, r: any) => s + Number(r.value), 0);
  return (
    <>
      <div className="page-head"><div><h1>{tt("أرصدة المخزون", "Stock on hand")}</h1>
        {check.data && <p><span className={`badge ${check.data.reconciled ? "ok" : "bad"}`}>{check.data.reconciled ? tt("مطابق للأستاذ العام", "Reconciled with GL") : `${tt("فرق مع الأستاذ", "GL difference")} ${check.data.difference}`}</span></p>}</div>
        <div className="row">
          <select value={wh} onChange={(e) => setWh(e.target.value)} style={{ width: "auto" }}><option value="">{t.warehouses}: *</option>{whs.data?.map((w: any) => <option key={w.id} value={w.id}>{w.code} {w.name_ar}</option>)}</select>
          <label className="row"><input type="checkbox" checked={low} onChange={(e) => setLow(e.target.checked)} style={{ width: "auto" }} />{tt("تحت حد الطلب", "Below reorder")}</label>
        </div></div>
      <ErrorBox error={stock.error} />
      {stock.loading ? <Loading /> : !stock.data?.length ? <div className="card"><Empty /></div> : (
        <div className="table-wrap"><table>
          <thead><tr><th>{t.warehouse}</th><th>{tt("الصنف", "Item")}</th><th className="end">{tt("الكمية", "Qty")}</th><th className="end">{tt("متوسط التكلفة", "Avg cost")}</th><th className="end">{tt("القيمة", "Value")}</th><th>{tt("التشغيلات / الصلاحية", "Lots / expiry")}</th></tr></thead>
          <tbody>{stock.data.map((r: any) => (
            <tr key={r.warehouse_id + r.item_id}>
              <td>{r.warehouse_code} {!r.is_sellable && <span className="badge warn">{r.warehouse_kind}</span>}</td><td><span className="num">{r.item_code}</span> {r.item_name_ar}</td>
              <td className="end num">{fmt(r.qty, 0)} {r.uom}</td><td className="end num">{fmt(r.avg_cost, 4)}</td><td className="end num">{fmt(r.value)}</td>
              <td style={{ whiteSpace: "normal" }}>{r.lots.map((l: any) => (
                <a key={l.lotId} href="#" onClick={(e) => { e.preventDefault(); setLot(l.lotId); }} className={`badge ${l.daysToExpiry !== null && l.daysToExpiry < 30 ? "bad" : l.daysToExpiry !== null && l.daysToExpiry < 90 ? "warn" : ""}`} style={{ marginInlineEnd: 4 }}>
                  {l.lotNo} · {fmt(l.qty, 0)} · {fmtDate(l.expiryDate)}</a>))}</td>
            </tr>))}</tbody>
          <tfoot><tr><td colSpan={4}>{t.total}</td><td className="end num">{fmt(total)}</td><td /></tr></tfoot>
        </table></div>
      )}
      {lot && <Modal title={`${tt("تتبع التشغيلة", "Lot trace")} ${trace.data?.lot.lot_no ?? ""}`} onClose={() => setLot(null)}>
        {trace.loading ? <Loading /> : trace.data && <div className="grid">
          <div className="row"><span>{trace.data.lot.item_code} {trace.data.lot.item_name_ar}</span><span className="badge">{tt("إنتاج", "Prod.")} {fmtDate(trace.data.lot.production_date)}</span>
            <span className="badge warn">{tt("انتهاء", "Expiry")} {fmtDate(trace.data.lot.expiry_date)}</span>{trace.data.lot.supplier_name_ar && <span className="badge info">{tt("المورد", "Supplier")}: {trace.data.lot.supplier_name_ar}</span>}</div>
          <h3>{tt("العملاء الذين استلموا التشغيلة", "Customers who received this lot")}</h3>
          {!trace.data.customers.length ? <p style={{ color: "var(--muted)" }}>{t.none}</p> : <div className="table-wrap"><table><thead><tr><th>{t.code}</th><th>{t.name}</th><th>{tt("الهاتف", "Phone")}</th><th className="end">{tt("مباع", "Sold")}</th><th className="end">{tt("مرتجع", "Returned")}</th><th className="end">{tt("بالسوق", "In market")}</th></tr></thead>
            <tbody>{trace.data.customers.map((c: any) => <tr key={c.id}><td className="num">{c.code}</td><td>{c.name_ar}</td><td className="num">{c.phone}</td><td className="end num">{fmt(c.sold, 0)}</td><td className="end num">{fmt(c.returned, 0)}</td><td className="end num">{fmt(c.net_in_market, 0)}</td></tr>)}</tbody></table></div>}
          <h3>{tt("الحركات", "Movements")}</h3>
          <div className="table-wrap"><table><thead><tr><th>{t.date}</th><th>{t.warehouse}</th><th>{t.source}</th><th>{t.number}</th><th className="end">{tt("الكمية", "Qty")}</th></tr></thead>
            <tbody>{trace.data.moves.map((m: any, i: number) => <tr key={i}><td className="num">{fmtDate(m.move_date)}</td><td>{m.warehouse_code}</td><td><code>{m.source_type}</code></td><td className="num">{m.document_number}</td><td className="end num">{fmt(m.qty, 0)}</td></tr>)}</tbody></table></div>
        </div>}
      </Modal>}
    </>
  );
}
