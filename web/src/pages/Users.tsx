import { useState } from "react";
import { api, fmtDateTime } from "../api";
import { useI18n } from "../i18n";
import { useSession } from "../session";
import { Empty, ErrorBox, Field, Loading, Modal, errMsg, useAsync, useToast } from "../ui";

export default function Users() {
  const { t, pick, lang } = useI18n();
  const { can, me } = useSession();
  const { toast, confirm } = useToast();
  const [q, setQ] = useState("");
  const [edit, setEdit] = useState<any | null>(null);
  const users = useAsync(() => api.get(`/users?pageSize=200${q ? `&q=${encodeURIComponent(q)}` : ""}`), [q]);
  const roles = useAsync(() => api.get("/roles"), []);
  const branches = useAsync(() => api.get("/branches"), []);
  const manage = can("core.users.manage");
  const toggle = async (u: any) => {
    if (!(await confirm(`${u.is_active ? t.inactive : t.active}: ${u.full_name}?`))) return;
    try { await api.patch(`/users/${u.id}`, { isActive: !u.is_active }); toast(t.savedOk); users.reload(); } catch (e) { toast(errMsg(e, lang), true); }
  };
  return (
    <>
      <div className="page-head"><h1>{t.users}</h1><div className="row"><input type="search" placeholder={t.search} value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 220 }} />{manage && <button className="btn primary" onClick={() => setEdit({})}>{t.add}</button>}</div></div>
      <ErrorBox error={users.error} />
      {users.loading ? <Loading /> : !users.data?.data.length ? <Empty /> : (
        <div className="table-wrap"><table>
          <thead><tr><th>{t.fullName}</th><th>{t.email}</th><th>{t.roles}</th><th>{t.mfa}</th><th>{t.lastLogin}</th><th>{t.status}</th>{manage && <th>{t.actions}</th>}</tr></thead>
          <tbody>{users.data.data.map((u: any) => (
            <tr key={u.id}>
              <td>{u.full_name} {u.is_owner && <span className="badge info">{t.owner}</span>}</td>
              <td className="num">{u.email}</td>
              <td>{u.roles.map((r: any) => <span key={r.roleId + r.branchId} className="badge" style={{ marginInlineEnd: 4 }}>{pick(r.nameAr, r.nameEn)}{r.branchId ? " *" : ""}</span>)}</td>
              <td>{u.mfa_enabled ? t.enabled : t.disabled}</td>
              <td className="num">{fmtDateTime(u.last_login_at)}</td>
              <td><span className={`badge ${u.is_active ? "ok" : "bad"}`}>{u.is_active ? t.active : t.inactive}</span>{u.locked_until && new Date(u.locked_until) > new Date() && <span className="badge warn">locked</span>}</td>
              {manage && <td className="row">
                {!u.is_owner && <button className="btn sm" onClick={() => setEdit(u)}>{t.roles}</button>}
                {!u.is_owner && u.id !== me!.user.id && <button className="btn sm" onClick={() => toggle(u)}>{u.is_active ? t.inactive : t.active}</button>}
                {u.locked_until && <button className="btn sm" onClick={async () => { await api.patch(`/users/${u.id}`, { unlock: true }); users.reload(); }}>unlock</button>}
              </td>}
            </tr>))}</tbody>
        </table></div>
      )}
      {edit && roles.data && <UserModal user={edit} roles={roles.data} branches={branches.data ?? []} onClose={() => setEdit(null)} onDone={() => { setEdit(null); users.reload(); toast(t.savedOk); }} />}
    </>
  );
}

function UserModal({ user, roles, branches, onClose, onDone }: { user: any; roles: any[]; branches: any[]; onClose: () => void; onDone: () => void }) {
  const { t, pick } = useI18n();
  const isNew = !user.id;
  const [f, setF] = useState({ email: "", fullName: "", password: "" });
  const [assign, setAssign] = useState<{ roleId: string; branchId: string | null }[]>(user.roles?.map((r: any) => ({ roleId: r.roleId, branchId: r.branchId })) ?? []);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      if (isNew) await api.post("/users", { ...f, roles: assign });
      else await api.put(`/users/${user.id}/roles`, { roles: assign });
      onDone();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <Modal title={isNew ? t.add : user.full_name} onClose={onClose} footer={<><button className="btn" onClick={onClose}>{t.cancel}</button><button className="btn primary" disabled={busy} onClick={save}>{t.save}</button></>}>
      <ErrorBox error={err} />
      {isNew && <div className="form-grid" style={{ marginBottom: 16 }}>
        <Field label={t.fullName}><input value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} /></Field>
        <Field label={t.email}><input dir="ltr" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label={t.password}><input dir="ltr" type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
      </div>}
      <h3>{t.roles}</h3>
      {assign.map((a, i) => (
        <div className="row" key={i} style={{ marginBottom: 6 }}>
          <select value={a.roleId} onChange={(e) => setAssign(assign.map((x, j) => j === i ? { ...x, roleId: e.target.value } : x))} style={{ flex: 2 }}>
            {roles.filter((r) => r.code !== "tenant_owner").map((r) => <option key={r.id} value={r.id}>{pick(r.name_ar, r.name_en)}</option>)}
          </select>
          <select value={a.branchId ?? ""} onChange={(e) => setAssign(assign.map((x, j) => j === i ? { ...x, branchId: e.target.value || null } : x))} style={{ flex: 1 }}>
            <option value="">— {t.branches}: all —</option>
            {branches.map((b) => <option key={b.id} value={b.id}>{b.code} {pick(b.name_ar, b.name_en)}</option>)}
          </select>
          <button className="btn sm danger" onClick={() => setAssign(assign.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      <button className="btn sm" onClick={() => setAssign([...assign, { roleId: roles.find((r) => r.code === "read_only")?.id, branchId: null }])}>+ {t.role}</button>
    </Modal>
  );
}
