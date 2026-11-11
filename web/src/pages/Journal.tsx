import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, fmt, fmtDate, fmtDateTime } from "../api";
import { useI18n } from "../i18n";
import { useSession } from "../session";
import { Empty, ErrorBox, Field, Loading, Modal, StatusBadge, errMsg, useAsync, useToast } from "../ui";

type Line = { accountId: string; debit: string; credit: string; description: string };
const blank = (): Line => ({ accountId: "", debit: "", credit: "", description: "" });
// exact decimal sum in integer ten-thousandths (no float drift)
const units = (s: string) => { const m = /^(\d*)(?:\.(\d{0,4}))?$/.exec(s.trim()); return m ? BigInt((m[1] || "0") + (m[2] ?? "").padEnd(4, "0")) : 0n; };
const show = (u: bigint) => { const neg = u < 0n; const a = neg ? -u : u; const s = a.toString().padStart(5, "0"); return `${neg ? "-" : ""}${s.slice(0, -4)}.${s.slice(-4)}`; };

export default function Journal() {
  const { t, pick, lang } = useI18n();
  const { can, companyId, me } = useSession();
  const { toast, confirm } = useToast();
  const [sp, setSp] = useSearchParams();
  const [filters, setFilters] = useState({ status: sp.get("status") ?? "", q: "", from: "", to: "" });
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);
  const creating = sp.get("new") === "1";
  const qs = new URLSearchParams({ companyId: companyId ?? "", page: String(page), pageSize: "25", ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)) });
  const list = useAsync(() => api.get(`/accounting/journal-entries?${qs}`), [qs.toString()]);
  const accounts = useAsync(() => api.get(`/accounting/accounts?companyId=${companyId}&postableOnly=true`), [companyId]);
  const detail = useAsync(() => (openId ? api.get(`/accounting/journal-entries/${openId}`) : Promise.resolve(null)), [openId]);

  const act = async (kind: "post" | "reverse" | "delete") => {
    const e = detail.data;
    try {
      if (kind === "post") { await api.post(`/accounting/journal-entries/${e.id}/post`, {}, { idempotencyKey: `post-${e.id}` }); toast(t.postedOk); }
      if (kind === "delete") { if (!(await confirm(`${t.delete}?`))) return; await api.del(`/accounting/journal-entries/${e.id}`); setOpenId(null); }
      if (kind === "reverse") {
        const reason = prompt(t.reason);
        if (!reason) return;
        await api.post(`/accounting/journal-entries/${e.id}/reverse`, { reason }, { idempotencyKey: `rev-${e.id}` });
        toast(t.savedOk);
      }
      detail.reload(); list.reload();
    } catch (x) { toast(errMsg(x, lang), true); }
  };

  return (
    <>
      <div className="page-head"><h1>{t.journal}</h1>{can("accounting.journal.create") && <button className="btn primary" onClick={() => setSp({ new: "1" })}>{t.newEntry} <span className="kbd">N</span></button>}</div>
      <div className="card row" style={{ marginBottom: 12 }}>
        <input type="search" placeholder={t.search} value={filters.q} onChange={(e) => { setPage(1); setFilters({ ...filters, q: e.target.value }); }} style={{ maxWidth: 240 }} />
        <select value={filters.status} onChange={(e) => { setPage(1); setFilters({ ...filters, status: e.target.value }); }} style={{ width: "auto" }}>
          <option value="">{t.status}: *</option><option value="draft">{t.draft}</option><option value="posted">{t.posted}</option><option value="reversed">{t.reversed}</option>
        </select>
        <label>{t.from}</label><input type="date" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} style={{ width: "auto" }} />
        <label>{t.to}</label><input type="date" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} style={{ width: "auto" }} />
      </div>
      <ErrorBox error={list.error} />
      {list.loading ? <Loading /> : !list.data?.data.length ? <div className="card"><Empty /></div> : (
        <>
          <div className="table-wrap"><table>
            <thead><tr><th>{t.number}</th><th>{t.date}</th><th>{t.memo}</th><th>{t.source}</th><th className="end">{t.amount}</th><th>{t.status}</th><th>{t.actor}</th></tr></thead>
            <tbody>{list.data.data.map((e: any) => (
              <tr key={e.id} onClick={() => setOpenId(e.id)} style={{ cursor: "pointer" }}>
                <td className="num">{e.number ?? "—"}</td><td className="num">{fmtDate(e.entry_date)}</td>
                <td>{e.memo} {e.is_demo && <span className="badge demo">DEMO</span>}</td><td><code style={{ fontSize: 11 }}>{e.source_type}</code></td>
                <td className="end num">{fmt(e.total)} {e.currency}</td><td><StatusBadge s={e.status} /></td><td>{e.created_by_name}</td>
              </tr>))}</tbody>
          </table></div>
          <div className="row" style={{ marginTop: 8 }}>
            <span style={{ color: "var(--muted)" }} className="num">{list.data.total}</span><span className="spacer" />
            <button className="btn sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>‹</button><span className="num">{page}</span>
            <button className="btn sm" disabled={page * 25 >= list.data.total} onClick={() => setPage(page + 1)}>›</button>
          </div>
        </>
      )}
      {creating && accounts.data && <EntryEditor accounts={accounts.data} onClose={() => setSp({})} onSaved={(id) => { setSp({}); list.reload(); setOpenId(id); }} />}
      {openId && (
        <Modal title={detail.data?.number ?? t.draft} onClose={() => setOpenId(null)} footer={detail.data && <>
          {detail.data.status === "draft" && can("accounting.journal.create") && <button className="btn danger" onClick={() => act("delete")}>{t.delete}</button>}
          {detail.data.status === "posted" && !detail.data.reversal_of && can("accounting.journal.reverse") && <button className="btn danger" onClick={() => act("reverse")}>{t.reverse}</button>}
          {detail.data.status === "draft" && can("accounting.journal.post") && <button className="btn primary" onClick={() => act("post")}>{t.post}</button>}
        </>}>
          {detail.loading ? <Loading /> : detail.data && (
            <div className="grid">
              <div className="row"><StatusBadge s={detail.data.status} /><span className="num">{fmtDate(detail.data.entry_date)}</span><span>{detail.data.memo}</span></div>
              {detail.data.status === "draft" && detail.data.created_by === me!.user.id && <div className="alert info">{t.sodHint}</div>}
              <div className="table-wrap"><table>
                <thead><tr><th>#</th><th>{t.account}</th><th>{t.details}</th><th className="end">{t.debit}</th><th className="end">{t.credit}</th></tr></thead>
                <tbody>{detail.data.lines.map((l: any) => <tr key={l.id}><td className="num">{l.line_no}</td><td><span className="num">{l.account_code}</span> {pick(l.account_name_ar, l.account_name_en)}</td><td>{l.description}</td><td className="end num">{Number(l.debit) ? fmt(l.debit) : ""}</td><td className="end num">{Number(l.credit) ? fmt(l.credit) : ""}</td></tr>)}</tbody>
                <tfoot><tr><td colSpan={3}>{t.total}</td><td className="end num">{fmt(detail.data.totals.debit)}</td><td className="end num">{fmt(detail.data.totals.credit)}</td></tr></tfoot>
              </table></div>
              <small style={{ color: "var(--muted)" }}>{detail.data.created_by_name} · {fmtDateTime(detail.data.created_at)}{detail.data.posted_by_name && ` → ${t.posted}: ${detail.data.posted_by_name} · ${fmtDateTime(detail.data.posted_at)}`}</small>
            </div>
          )}
        </Modal>
      )}
    </>
  );
}

function EntryEditor({ accounts, onClose, onSaved }: { accounts: any[]; onClose: () => void; onSaved: (id: string) => void }) {
  const { t, pick } = useI18n();
  const { companyId } = useSession();
  const [key] = useState(() => crypto.randomUUID());
  const [h, setH] = useState({ entryDate: new Date().toISOString().slice(0, 10), memo: "", reference: "" });
  const [lines, setLines] = useState<Line[]>([blank(), blank()]);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const tot = useMemo(() => lines.reduce((a, l) => ({ d: a.d + units(l.debit), c: a.c + units(l.credit) }), { d: 0n, c: 0n }), [lines]);
  const set = (i: number, p: Partial<Line>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const body = { companyId, ...h, reference: h.reference || null,
        lines: lines.filter((l) => l.accountId).map((l) => ({ accountId: l.accountId, description: l.description || undefined, ...(units(l.debit) > 0n ? { debit: l.debit } : { credit: l.credit }) })) };
      const r = await api.post("/accounting/journal-entries", body, { idempotencyKey: key });
      onSaved(r.id);
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const diff = tot.d - tot.c;
  return (
    <Modal title={t.newEntry} onClose={onClose} footer={<><button className="btn" onClick={onClose}>{t.cancel}</button><button className="btn primary" disabled={busy} onClick={save}>{t.save} ({t.draft})</button></>}>
      <ErrorBox error={err} />
      <div className="form-grid" style={{ marginBottom: 12 }}>
        <Field label={t.date}><input type="date" value={h.entryDate} onChange={(e) => setH({ ...h, entryDate: e.target.value })} /></Field>
        <Field label={t.memo}><input value={h.memo} onChange={(e) => setH({ ...h, memo: e.target.value })} /></Field>
        <Field label={t.reference}><input value={h.reference} onChange={(e) => setH({ ...h, reference: e.target.value })} /></Field>
      </div>
      <div className="table-wrap"><table>
        <thead><tr><th>{t.account}</th><th>{t.details}</th><th>{t.debit}</th><th>{t.credit}</th><th /></tr></thead>
        <tbody>{lines.map((l, i) => (
          <tr key={i}>
            <td style={{ minWidth: 220 }}><select value={l.accountId} onChange={(e) => set(i, { accountId: e.target.value })}><option value="">—</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.code} {pick(a.name_ar, a.name_en)}</option>)}</select></td>
            <td><input value={l.description} onChange={(e) => set(i, { description: e.target.value })} /></td>
            <td><input className="num" inputMode="decimal" value={l.debit} onChange={(e) => set(i, { debit: e.target.value, credit: e.target.value ? "" : l.credit })} style={{ width: 120 }} /></td>
            <td><input className="num" inputMode="decimal" value={l.credit} onChange={(e) => set(i, { credit: e.target.value, debit: e.target.value ? "" : l.debit })} style={{ width: 120 }} /></td>
            <td>{lines.length > 2 && <button className="btn sm" onClick={() => setLines(lines.filter((_, j) => j !== i))}>✕</button>}</td>
          </tr>))}</tbody>
      </table></div>
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn sm" onClick={() => setLines([...lines, blank()])}>+ {t.addLine}</button><span className="spacer" />
        <div className="balance-bar">
          <span>{t.debit}: <b className="num">{show(tot.d)}</b></span><span>{t.credit}: <b className="num">{show(tot.c)}</b></span>
          <span className={`badge ${diff === 0n && tot.d > 0n ? "ok" : "bad"}`}>{diff === 0n ? t.balanced : `${t.difference} ${show(diff)}`}</span>
        </div>
      </div>
    </Modal>
  );
}
