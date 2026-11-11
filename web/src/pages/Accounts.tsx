import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { useI18n } from "../i18n";
import { useSession } from "../session";
import { Empty, ErrorBox, Field, Loading, Modal, useAsync, useToast, errMsg } from "../ui";

export default function Accounts() {
  const { t, pick, lang } = useI18n();
  const { can, companyId } = useSession();
  const { toast } = useToast();
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const [add, setAdd] = useState<any | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const list = useAsync(() => api.get(`/accounting/accounts?companyId=${companyId}`), [companyId]);
  const depth = useMemo(() => {
    const byId = new Map<string, any>((list.data ?? []).map((a: any) => [a.id, a]));
    const d = (a: any): number => (a.parent_id ? 1 + d(byId.get(a.parent_id)) : 0);
    return new Map<string, number>((list.data ?? []).map((a: any) => [a.id, d(a)]));
  }, [list.data]);
  const manage = can("accounting.accounts.manage");
  const seed = async () => {
    try { const r = await api.post("/accounting/accounts/seed-template", { companyId }); toast(`${r.created} ✔`); list.reload(); } catch (e) { toast(errMsg(e, lang), true); }
  };
  const save = async () => {
    setErr(null);
    try { await api.post("/accounting/accounts", { companyId, ...add }); setAdd(null); toast(t.savedOk); list.reload(); } catch (e) { setErr(e); }
  };
  if (list.loading) return <Loading />;
  const rows = (list.data ?? []).filter((a: any) => !q || a.code.startsWith(q) || pick(a.name_ar, a.name_en).includes(q));
  return (
    <>
      <div className="page-head"><div><h1>{t.coa}</h1><p>{t.coaTemplateNote}</p></div>
        <div className="row"><input type="search" placeholder={t.search} value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 200 }} />{manage && !!list.data?.length && <button className="btn primary" onClick={() => setAdd({ isPostable: true })}>{t.add}</button>}</div></div>
      <ErrorBox error={list.error} />
      {!list.data?.length ? <div className="card"><Empty text={t.coaEmpty} action={manage && <button className="btn primary" onClick={seed}>{t.seedCoa}</button>} /></div> : (
        <div className="table-wrap"><table>
          <thead><tr><th>{t.code}</th><th>{t.name}</th><th>{t.type}</th><th>{t.balance}</th><th>role</th><th>{t.status}</th></tr></thead>
          <tbody>{rows.map((a: any) => (
            <tr key={a.id} style={{ fontWeight: a.is_postable ? 400 : 700, cursor: a.is_postable ? "pointer" : "default" }} onClick={() => a.is_postable && nav(`/trial-balance?account=${a.id}`)}>
              <td className="num">{a.code}</td>
              <td><span className="tree-indent" style={{ width: (depth.get(a.id) ?? 0) * 18 }} />{pick(a.name_ar, a.name_en)}</td>
              <td>{a.type}</td><td>{a.normal_balance === "debit" ? t.debit : t.credit}</td>
              <td><code style={{ fontSize: 11 }}>{a.role ?? ""}</code></td>
              <td>{!a.is_active && <span className="badge bad">{t.inactive}</span>}{a.has_postings && <span className="badge info">●</span>}{a.is_demo && <span className="badge demo">DEMO</span>}</td>
            </tr>))}</tbody>
        </table></div>
      )}
      {add && (
        <Modal title={t.add} onClose={() => setAdd(null)} footer={<><button className="btn" onClick={() => setAdd(null)}>{t.cancel}</button><button className="btn primary" onClick={save}>{t.save}</button></>}>
          <ErrorBox error={err} />
          <div className="form-grid">
            <Field label={t.code}><input dir="ltr" inputMode="numeric" value={add.code ?? ""} onChange={(e) => setAdd({ ...add, code: e.target.value })} /></Field>
            <Field label={t.name}><input value={add.nameAr ?? ""} onChange={(e) => setAdd({ ...add, nameAr: e.target.value })} /></Field>
            <Field label="English"><input dir="ltr" value={add.nameEn ?? ""} onChange={(e) => setAdd({ ...add, nameEn: e.target.value })} /></Field>
            <Field label="parent"><select value={add.parentId ?? ""} onChange={(e) => setAdd({ ...add, parentId: e.target.value || null })}>
              <option value="">—</option>{list.data.map((a: any) => <option key={a.id} value={a.id}>{a.code} {pick(a.name_ar, a.name_en)}</option>)}</select></Field>
            {!add.parentId && <Field label={t.type}><select value={add.type ?? "asset"} onChange={(e) => setAdd({ ...add, type: e.target.value })}>{["asset", "liability", "equity", "revenue", "expense"].map((x) => <option key={x}>{x}</option>)}</select></Field>}
            <Field label="postable"><select value={String(add.isPostable)} onChange={(e) => setAdd({ ...add, isPostable: e.target.value === "true" })}><option value="true">✔</option><option value="false">—</option></select></Field>
          </div>
        </Modal>
      )}
    </>
  );
}
