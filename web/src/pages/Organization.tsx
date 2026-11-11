import { useState } from "react";
import { api } from "../api";
import { useI18n } from "../i18n";
import { useSession } from "../session";
import { ErrorBox, Field, Loading, Modal, useAsync, useToast } from "../ui";

const BRANCH_KINDS = ["head_office", "factory", "branch", "warehouse_site", "sales_office"];
const WH_KINDS = ["main", "raw_materials", "packaging", "finished_goods", "wip", "quarantine", "damaged", "van", "transit"];

export default function Organization() {
  const { t, pick } = useI18n();
  const { can, companyId } = useSession();
  const { toast } = useToast();
  const branches = useAsync(() => api.get("/branches"), []);
  const whs = useAsync(() => api.get("/warehouses"), []);
  const companies = useAsync(() => api.get("/companies"), []);
  const [modal, setModal] = useState<"branch" | "warehouse" | null>(null);
  const [f, setF] = useState<any>({});
  const [err, setErr] = useState<unknown>(null);
  const manage = can("core.org.manage");
  const save = async () => {
    setErr(null);
    try {
      if (modal === "branch") await api.post("/branches", { companyId, kind: "branch", ...f });
      else await api.post("/warehouses", { branchId: branches.data?.[0]?.id, kind: "main", ...f });
      setModal(null); setF({}); toast(t.savedOk); branches.reload(); whs.reload();
    } catch (e) { setErr(e); }
  };
  if (branches.loading || whs.loading || companies.loading) return <Loading />;
  return (
    <>
      <div className="page-head"><h1>{t.organization}</h1></div>
      <ErrorBox error={branches.error || whs.error || companies.error} />
      <div className="card" style={{ marginBottom: 16 }}>
        <h2>{t.companies}</h2>
        <div className="table-wrap"><table><thead><tr><th>{t.code}</th><th>{t.name}</th><th>{t.currency}</th></tr></thead>
          <tbody>{companies.data?.map((c: any) => <tr key={c.id}><td className="num">{c.code}</td><td>{pick(c.name_ar, c.name_en)}</td><td className="num">{c.base_currency}</td></tr>)}</tbody></table></div>
      </div>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="row"><h2>{t.branches}</h2><span className="spacer" />{manage && <button className="btn sm primary" onClick={() => { setF({}); setModal("branch"); }}>{t.add}</button>}</div>
        <div className="table-wrap"><table><thead><tr><th>{t.code}</th><th>{t.name}</th><th>{t.kind}</th><th>{t.status}</th></tr></thead>
          <tbody>{branches.data?.map((b: any) => <tr key={b.id}><td className="num">{b.code}</td><td>{pick(b.name_ar, b.name_en)}</td><td>{b.kind}</td><td><span className={`badge ${b.is_active ? "ok" : "bad"}`}>{b.is_active ? t.active : t.inactive}</span></td></tr>)}</tbody></table></div>
      </div>
      <div className="card">
        <div className="row"><h2>{t.warehouses}</h2><span className="spacer" />{manage && <button className="btn sm primary" onClick={() => { setF({}); setModal("warehouse"); }}>{t.add}</button>}</div>
        {!whs.data?.length ? <p style={{ color: "var(--muted)" }}>{t.none}</p> : (
          <div className="table-wrap"><table><thead><tr><th>{t.code}</th><th>{t.name}</th><th>{t.branch}</th><th>{t.kind}</th><th>{t.sellable}</th></tr></thead>
            <tbody>{whs.data.map((w: any) => <tr key={w.id}><td className="num">{w.code}</td><td>{pick(w.name_ar, w.name_en)}</td><td>{w.branch_code}</td><td>{w.kind}</td><td>{w.is_sellable ? "✔" : "—"}</td></tr>)}</tbody></table></div>
        )}
      </div>
      {modal && (
        <Modal title={modal === "branch" ? t.branches : t.warehouses} onClose={() => setModal(null)} footer={<><button className="btn" onClick={() => setModal(null)}>{t.cancel}</button><button className="btn primary" onClick={save}>{t.save}</button></>}>
          <ErrorBox error={err} />
          <div className="form-grid">
            <Field label={t.code}><input dir="ltr" value={f.code ?? ""} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></Field>
            <Field label={t.name}><input value={f.nameAr ?? ""} onChange={(e) => setF({ ...f, nameAr: e.target.value })} /></Field>
            <Field label="English"><input dir="ltr" value={f.nameEn ?? ""} onChange={(e) => setF({ ...f, nameEn: e.target.value })} /></Field>
            {modal === "warehouse" && <Field label={t.branch}><select value={f.branchId ?? branches.data?.[0]?.id} onChange={(e) => setF({ ...f, branchId: e.target.value })}>{branches.data?.map((b: any) => <option key={b.id} value={b.id}>{b.code}</option>)}</select></Field>}
            <Field label={t.kind}><select value={f.kind ?? (modal === "branch" ? "branch" : "main")} onChange={(e) => setF({ ...f, kind: e.target.value })}>{(modal === "branch" ? BRANCH_KINDS : WH_KINDS).map((k) => <option key={k}>{k}</option>)}</select></Field>
          </div>
        </Modal>
      )}
    </>
  );
}
