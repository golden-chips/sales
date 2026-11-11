import { useState } from "react";
import { api, fmt } from "../../api";
import { useI18n } from "../../i18n";
import { useSession } from "../../session";
import { Empty, ErrorBox, Field, Loading, Modal, useAsync, useToast } from "../../ui";

export default function Parties({ kind }: { kind: "customer" | "supplier" }) {
  const { t, tt, pick } = useI18n();
  const { can, companyId } = useSession();
  const { toast } = useToast();
  const path = kind === "customer" ? "/customers" : "/suppliers";
  const [q, setQ] = useState("");
  const [f, setF] = useState<any | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const list = useAsync(() => api.get(`${path}?companyId=${companyId}&pageSize=200${q ? `&q=${encodeURIComponent(q)}` : ""}`), [companyId, q]);
  const manage = can(kind === "customer" ? "sales.customers.manage" : "purchasing.suppliers.manage");
  const save = async () => {
    setErr(null);
    try { await api.post(path, { companyId, ...f, creditLimit: f.creditLimit || null, paymentTermsDays: Number(f.paymentTermsDays || 0) }); setF(null); toast(t.savedOk); list.reload(); } catch (e) { setErr(e); }
  };
  const title = kind === "customer" ? tt("العملاء", "Customers") : tt("الموردون", "Suppliers");
  return (
    <>
      <div className="page-head"><h1>{title}</h1><div className="row"><input type="search" placeholder={t.search} value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 220 }} />
        {manage && <button className="btn primary" onClick={() => setF({ code: "", nameAr: "", paymentTermsDays: kind === "customer" ? 30 : 0 })}>{t.add}</button>}</div></div>
      <ErrorBox error={list.error} />
      {list.loading ? <Loading /> : !list.data?.data.length ? <div className="card"><Empty /></div> : (
        <div className="table-wrap"><table>
          <thead><tr><th>{t.code}</th><th>{t.name}</th><th>{tt("الهاتف", "Phone")}</th><th>{tt("المدينة", "City")}</th>{kind === "customer" && <th className="end">{tt("حد الائتمان", "Credit limit")}</th>}
            <th>{tt("مدة السداد", "Terms")}</th><th className="end">{t.balance}</th><th>{t.status}</th></tr></thead>
          <tbody>{list.data.data.map((p: any) => (
            <tr key={p.id}><td className="num">{p.code}</td><td>{pick(p.name_ar, p.name_en)}</td><td className="num">{p.phone}</td><td>{p.city}</td>
              {kind === "customer" && <td className="end num">{p.credit_limit ? fmt(p.credit_limit) : "∞"}</td>}
              <td className="num">{p.payment_terms_days}</td><td className="end num" style={{ color: Number(p.balance) < 0 ? "var(--ok)" : undefined }}>{fmt(p.balance)}</td>
              <td><span className={`badge ${p.is_active ? "ok" : "bad"}`}>{p.is_active ? t.active : t.inactive}</span></td></tr>))}</tbody>
        </table></div>
      )}
      {f && <Modal title={title} onClose={() => setF(null)} footer={<><button className="btn" onClick={() => setF(null)}>{t.cancel}</button><button className="btn primary" onClick={save}>{t.save}</button></>}>
        <ErrorBox error={err} />
        <div className="form-grid">
          <Field label={t.code}><input dir="ltr" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></Field>
          <Field label={t.name}><input value={f.nameAr} onChange={(e) => setF({ ...f, nameAr: e.target.value })} /></Field>
          <Field label={tt("الهاتف", "Phone")}><input dir="ltr" value={f.phone ?? ""} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
          <Field label={tt("المدينة", "City")}><input value={f.city ?? ""} onChange={(e) => setF({ ...f, city: e.target.value })} /></Field>
          {kind === "customer" && <Field label={tt("حد الائتمان (فارغ = بلا حد)", "Credit limit (empty = none)")}><input className="num" inputMode="decimal" value={f.creditLimit ?? ""} onChange={(e) => setF({ ...f, creditLimit: e.target.value })} /></Field>}
          <Field label={tt("مدة السداد (أيام)", "Payment terms (days)")}><input className="num" inputMode="numeric" value={f.paymentTermsDays} onChange={(e) => setF({ ...f, paymentTermsDays: e.target.value })} /></Field>
        </div>
      </Modal>}
    </>
  );
}
