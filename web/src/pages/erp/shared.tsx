import { useState, type ReactNode } from "react";
import { api, fmt, fmtDate } from "../../api";
import { useI18n } from "../../i18n";
import { useSession } from "../../session";
import { Empty, ErrorBox, Loading, Modal, StatusBadge, errMsg, useAsync, useToast } from "../../ui";

export const today = () => new Date().toISOString().slice(0, 10);

/** generic list + detail + post/delete for any draft→posted document endpoint */
export function DocList({ path, title, newLabel, onNew, postPerm, createPerm, columns, renderDetail, extraQuery = "", reloadKey = 0 }: {
  path: string; title: string; newLabel?: string; onNew?: () => void; postPerm: string; createPerm: string; extraQuery?: string; reloadKey?: number;
  columns: { h: string; v: (r: any) => ReactNode; end?: boolean }[]; renderDetail: (d: any) => ReactNode;
}) {
  const { t, tt, lang } = useI18n();
  const { can, companyId, me } = useSession();
  const { toast, confirm } = useToast();
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);
  const list = useAsync(() => api.get(`${path}?companyId=${companyId}&page=${page}&pageSize=25${status ? `&status=${status}` : ""}${q ? `&q=${encodeURIComponent(q)}` : ""}${extraQuery}`), [companyId, page, status, q, reloadKey]);
  const detail = useAsync(() => (openId ? api.get(`${path}/${openId}`) : Promise.resolve(null)), [openId]);
  const act = async (kind: "post" | "delete") => {
    try {
      if (kind === "post") { await api.post(`${path}/${openId}/post`, {}, { idempotencyKey: `post-${openId}` }); toast(t.postedOk); }
      else { if (!(await confirm(`${t.delete}?`))) return; await api.del(`${path}/${openId}`); setOpenId(null); }
      detail.reload(); list.reload();
    } catch (e) { toast(errMsg(e, lang), true); }
  };
  return (
    <>
      <div className="page-head"><h1>{title}</h1><div className="row">
        <input type="search" placeholder={t.number} value={q} onChange={(e) => { setPage(1); setQ(e.target.value); }} style={{ width: 160 }} />
        <select value={status} onChange={(e) => { setPage(1); setStatus(e.target.value); }} style={{ width: "auto" }}>
          <option value="">{t.status}: *</option><option value="draft">{t.draft}</option><option value="posted">{t.posted}</option></select>
        {onNew && can(createPerm) && <button className="btn primary" onClick={onNew}>{newLabel ?? t.add}</button>}</div></div>
      <ErrorBox error={list.error} />
      {list.loading ? <Loading /> : !list.data?.data.length ? <div className="card"><Empty /></div> : (
        <>
          <div className="table-wrap"><table>
            <thead><tr><th>{t.number}</th>{columns.map((c) => <th key={c.h} className={c.end ? "end" : ""}>{c.h}</th>)}<th>{t.status}</th><th>{t.actor}</th></tr></thead>
            <tbody>{list.data.data.map((r: any) => (
              <tr key={r.id} style={{ cursor: "pointer" }} onClick={() => setOpenId(r.id)}>
                <td className="num">{r.number ?? "—"}</td>{columns.map((c) => <td key={c.h} className={c.end ? "end num" : ""}>{c.v(r)}</td>)}<td><StatusBadge s={r.status} /></td><td>{r.created_by_name}</td>
              </tr>))}</tbody>
          </table></div>
          <div className="row" style={{ marginTop: 8 }}><span className="num">{list.data.total}</span><span className="spacer" />
            <button className="btn sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>‹</button><span className="num">{page}</span>
            <button className="btn sm" disabled={page * 25 >= list.data.total} onClick={() => setPage(page + 1)}>›</button></div>
        </>
      )}
      {openId && (
        <Modal title={detail.data?.number ?? t.draft} onClose={() => setOpenId(null)} footer={detail.data && <>
          {detail.data.status === "draft" && can(createPerm) && <button className="btn danger" onClick={() => act("delete")}>{t.delete}</button>}
          {detail.data.status === "draft" && can(postPerm) && <button className="btn primary" onClick={() => act("post")}>{t.post}</button>}
        </>}>
          {detail.loading ? <Loading /> : detail.data && <div className="grid">
            <div className="row"><StatusBadge s={detail.data.status} />{detail.data.journal_entry_id && <span className="badge info">{tt("قيد", "JE")} {detail.data.journal_number ?? "✔"}</span>}</div>
            {detail.data.status === "draft" && detail.data.created_by === me!.user.id && <div className="alert info">{t.sodHint}</div>}
            {renderDetail(detail.data)}
          </div>}
        </Modal>
      )}
    </>
  );
}

export function LinesTable({ rows, cols }: { rows: any[]; cols: { h: string; v: (r: any) => ReactNode; end?: boolean }[] }) {
  return <div className="table-wrap"><table>
    <thead><tr>{cols.map((c) => <th key={c.h} className={c.end ? "end" : ""}>{c.h}</th>)}</tr></thead>
    <tbody>{rows.map((r, i) => <tr key={r.id ?? i}>{cols.map((c) => <td key={c.h} className={c.end ? "end num" : ""}>{c.v(r)}</td>)}</tr>)}</tbody>
  </table></div>;
}

export const money = (v: unknown) => fmt(v as string);
export const date = (v: unknown) => <span className="num">{fmtDate(v as string)}</span>;

export function useLookups() {
  const { companyId } = useSession();
  const items = useAsync(() => api.get(`/items?companyId=${companyId}&pageSize=200`), [companyId]);
  const whs = useAsync(() => api.get("/warehouses"), []);
  return { items: items.data?.data ?? [], warehouses: whs.data ?? [] };
}
