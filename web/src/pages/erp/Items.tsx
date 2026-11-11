import { useState } from "react";
import { api, fmt } from "../../api";
import { useI18n } from "../../i18n";
import { useSession } from "../../session";
import { Empty, ErrorBox, Field, Loading, Modal, useAsync, useToast, errMsg } from "../../ui";

const KINDS = ["raw", "packaging", "semi_finished", "finished", "service"] as const;
const KIND_AR: Record<string, string> = { raw: "مادة خام", packaging: "تعبئة وتغليف", semi_finished: "نصف مصنع", finished: "منتج تام", service: "خدمة" };

export default function Items() {
  const { t, tt, pick, lang } = useI18n();
  const { can, companyId } = useSession();
  const { toast } = useToast();
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("");
  const [f, setF] = useState<any | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const list = useAsync(() => api.get(`/items?companyId=${companyId}&pageSize=200${q ? `&q=${encodeURIComponent(q)}` : ""}${kind ? `&kind=${kind}` : ""}`), [companyId, q, kind]);
  const uoms = useAsync(() => api.get("/uoms"), []);
  const manage = can("inventory.items.manage");
  const addUom = async () => {
    const code = prompt(tt("رمز الوحدة (مثل BAG أو CTN أو KG)", "Unit code (e.g. BAG, CTN, KG)"))?.trim().toUpperCase();
    if (!code) return;
    try { await api.post("/uoms", { code, nameAr: code }); uoms.reload(); } catch (e) { toast(errMsg(e, lang), true); }
  };
  const save = async () => {
    setErr(null);
    try {
      await api.post("/items", { companyId, code: f.code, nameAr: f.nameAr, nameEn: f.nameEn || undefined, kind: f.kind, baseUomId: f.baseUomId, barcode: f.barcode || undefined,
        trackLots: !!f.trackLots, shelfLifeDays: f.shelfLifeDays ? Number(f.shelfLifeDays) : undefined, salesPrice: f.salesPrice || undefined, reorderLevel: f.reorderLevel || undefined,
        units: f.altUomId && f.altFactor ? [{ uomId: f.altUomId, factor: f.altFactor }] : [] });
      setF(null); toast(t.savedOk); list.reload();
    } catch (e) { setErr(e); }
  };
  return (
    <>
      <div className="page-head"><h1>{tt("الأصناف", "Items")}</h1><div className="row">
        <input type="search" placeholder={t.search} value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 200 }} />
        <select value={kind} onChange={(e) => setKind(e.target.value)} style={{ width: "auto" }}><option value="">{t.type}: *</option>{KINDS.map((k) => <option key={k} value={k}>{lang === "ar" ? KIND_AR[k] : k}</option>)}</select>
        {manage && <button className="btn primary" onClick={() => setF({ kind: "finished", baseUomId: uoms.data?.[0]?.id })}>{t.add}</button>}</div></div>
      <ErrorBox error={list.error} />
      {list.loading ? <Loading /> : !list.data?.data.length ? <div className="card"><Empty /></div> : (
        <div className="table-wrap"><table>
          <thead><tr><th>{t.code}</th><th>{t.name}</th><th>{t.type}</th><th>{tt("الوحدة", "Unit")}</th><th>{tt("وحدات بديلة", "Alt. units")}</th><th>{tt("تشغيلات", "Lots")}</th>
            <th className="end">{tt("سعر البيع", "Price")}</th><th className="end">{tt("الرصيد", "On hand")}</th><th className="end">{tt("القيمة", "Value")}</th></tr></thead>
          <tbody>{list.data.data.map((i: any) => (
            <tr key={i.id}><td className="num">{i.code}</td><td>{pick(i.name_ar, i.name_en)} {i.is_demo && <span className="badge demo">DEMO</span>}</td><td>{lang === "ar" ? KIND_AR[i.kind] : i.kind}</td>
              <td>{i.base_uom_code}</td><td>{i.units.map((u: any) => `${u.code}=${Number(u.factor)}`).join(", ")}</td><td>{i.track_lots ? `✔ ${i.shelf_life_days ? `(${i.shelf_life_days}d)` : ""}` : "—"}</td>
              <td className="end num">{i.sales_price ? fmt(i.sales_price) : "—"}</td>
              <td className="end num" style={{ color: i.reorder_level && Number(i.on_hand) <= Number(i.reorder_level) ? "var(--bad)" : undefined }}>{fmt(i.on_hand, 0)}</td><td className="end num">{fmt(i.stock_value)}</td></tr>))}</tbody>
        </table></div>
      )}
      {f && <Modal title={tt("صنف جديد", "New item")} onClose={() => setF(null)} footer={<><button className="btn" onClick={() => setF(null)}>{t.cancel}</button><button className="btn primary" onClick={save}>{t.save}</button></>}>
        <ErrorBox error={err} />
        <div className="form-grid">
          <Field label={t.code}><input dir="ltr" value={f.code ?? ""} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></Field>
          <Field label={t.name}><input value={f.nameAr ?? ""} onChange={(e) => setF({ ...f, nameAr: e.target.value })} /></Field>
          <Field label="English"><input dir="ltr" value={f.nameEn ?? ""} onChange={(e) => setF({ ...f, nameEn: e.target.value })} /></Field>
          <Field label={t.type}><select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{KINDS.map((k) => <option key={k} value={k}>{lang === "ar" ? KIND_AR[k] : k}</option>)}</select></Field>
          <Field label={tt("الوحدة الأساسية", "Base unit")}><div className="row" style={{ flexWrap: "nowrap" }}><select value={f.baseUomId ?? ""} onChange={(e) => setF({ ...f, baseUomId: e.target.value })}>
            <option value="">—</option>{uoms.data?.map((u: any) => <option key={u.id} value={u.id}>{u.code}</option>)}</select><button className="btn sm" onClick={addUom}>+</button></div></Field>
          <Field label={tt("وحدة بديلة", "Alternative unit")}><select value={f.altUomId ?? ""} onChange={(e) => setF({ ...f, altUomId: e.target.value })}><option value="">—</option>{uoms.data?.map((u: any) => <option key={u.id} value={u.id}>{u.code}</option>)}</select></Field>
          <Field label={tt("= كم وحدة أساسية", "= base units")}><input className="num" value={f.altFactor ?? ""} onChange={(e) => setF({ ...f, altFactor: e.target.value })} placeholder="24" /></Field>
          <Field label={tt("سعر البيع (للوحدة الأساسية)", "Sales price (base unit)")}><input className="num" value={f.salesPrice ?? ""} onChange={(e) => setF({ ...f, salesPrice: e.target.value })} /></Field>
          <Field label={tt("حد إعادة الطلب", "Reorder level")}><input className="num" value={f.reorderLevel ?? ""} onChange={(e) => setF({ ...f, reorderLevel: e.target.value })} /></Field>
          <Field label={tt("الباركود", "Barcode")}><input dir="ltr" value={f.barcode ?? ""} onChange={(e) => setF({ ...f, barcode: e.target.value })} /></Field>
          <Field label={tt("تتبع التشغيلات والصلاحية", "Track lots & expiry")}><select value={String(!!f.trackLots)} onChange={(e) => setF({ ...f, trackLots: e.target.value === "true" })}><option value="false">—</option><option value="true">✔</option></select></Field>
          {f.trackLots && <Field label={tt("مدة الصلاحية (أيام)", "Shelf life (days)")}><input className="num" value={f.shelfLifeDays ?? ""} onChange={(e) => setF({ ...f, shelfLifeDays: e.target.value })} /></Field>}
        </div>
      </Modal>}
    </>
  );
}
