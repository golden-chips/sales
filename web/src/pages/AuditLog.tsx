import { useState } from "react";
import { api, fmtDateTime } from "../api";
import { useI18n } from "../i18n";
import { Empty, ErrorBox, Loading, Modal, useAsync } from "../ui";

export default function AuditLog() {
  const { t } = useI18n();
  const [action, setAction] = useState("");
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<any>(null);
  const log = useAsync(() => api.get(`/audit-log?page=${page}&pageSize=50${action ? `&action=${encodeURIComponent(action)}` : ""}`), [page, action]);
  return (
    <>
      <div className="page-head"><h1>{t.audit}</h1><input type="search" placeholder="journal. / user. / role." value={action} onChange={(e) => { setPage(1); setAction(e.target.value); }} style={{ width: 240 }} dir="ltr" /></div>
      <ErrorBox error={log.error} />
      {log.loading ? <Loading /> : !log.data?.data.length ? <div className="card"><Empty /></div> : (
        <>
          <div className="table-wrap"><table>
            <thead><tr><th>{t.date}</th><th>{t.action}</th><th>{t.entity}</th><th>{t.actor}</th><th>IP</th><th /></tr></thead>
            <tbody>{log.data.data.map((a: any) => (
              <tr key={a.id}><td className="num">{fmtDateTime(a.created_at)}</td><td><code>{a.action}</code></td><td>{a.entity_type} <span className="num" style={{ color: "var(--muted)", fontSize: 11 }}>{a.entity_id?.slice(0, 8)}</span></td>
                <td>{a.actor_name ?? a.actor_type}</td><td className="num">{a.ip}</td><td>{(a.before_data || a.after_data) && <button className="btn sm" onClick={() => setOpen(a)}>{t.details}</button>}</td></tr>))}</tbody>
          </table></div>
          <div className="row" style={{ marginTop: 8 }}><span className="num">{log.data.total}</span><span className="spacer" />
            <button className="btn sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>‹</button><span className="num">{page}</span>
            <button className="btn sm" disabled={page * 50 >= log.data.total} onClick={() => setPage(page + 1)}>›</button></div>
        </>
      )}
      {open && <Modal title={open.action} onClose={() => setOpen(null)}>
        <div className="grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <div><h3>before</h3><pre dir="ltr" style={{ fontSize: 11, overflow: "auto" }}>{JSON.stringify(open.before_data, null, 2)}</pre></div>
          <div><h3>after</h3><pre dir="ltr" style={{ fontSize: 11, overflow: "auto" }}>{JSON.stringify(open.after_data, null, 2)}</pre></div>
        </div>
      </Modal>}
    </>
  );
}
