import { useState } from "react";
import { API_BASE, api, fmtDate, fmtDateTime, getSession } from "../../api";
import { useI18n } from "../../i18n";
import { useSession } from "../../session";
import { Empty, ErrorBox, Field, Loading, Modal, StatusBadge, errMsg, useAsync, useToast } from "../../ui";
import { LinesTable } from "../erp/shared";

const CATS = ["contract", "invoice", "certificate", "license", "policy", "quality", "hr", "other"] as const;
const toB64 = (f: File) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1] ?? ""); r.onerror = rej; r.readAsDataURL(f); });
const size = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`);

function useCat() {
  const { tt } = useI18n();
  return (c: string) => ({ contract: tt("عقد", "Contract"), invoice: tt("فاتورة", "Invoice"), certificate: tt("شهادة", "Certificate"), license: tt("ترخيص", "Licence"),
    policy: tt("سياسة", "Policy"), quality: tt("جودة", "Quality"), hr: tt("موارد بشرية", "HR"), other: tt("أخرى", "Other") } as any)[c] ?? c;
}

async function download(docId: string, version: number, name: string) {
  const r = await fetch(`${API_BASE}/api/v1/documents/${docId}/versions/${version}/download`, { headers: { authorization: `Bearer ${getSession("tenant")?.accessToken}` } });
  if (!r.ok) throw new Error("download failed");
  const a = document.createElement("a"); a.href = URL.createObjectURL(await r.blob()); a.download = name; a.click(); URL.revokeObjectURL(a.href);
}

export function Documents() {
  const { t, tt } = useI18n();
  const { can, companyId } = useSession();
  const cat = useCat();
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("");
  const [expiring, setExpiring] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const list = useAsync(() => api.get(`/documents?companyId=${companyId}${q ? `&q=${encodeURIComponent(q)}` : ""}${category ? `&category=${category}` : ""}${expiring ? "&expiringWithinDays=60" : ""}`), [companyId, q, category, expiring]);
  return <>
    <div className="page-head"><h1>{tt("المستندات والأرشيف", "Documents & archive")}</h1><div className="row">
      <input type="search" placeholder={tt("بحث بالعنوان أو الوسم أو اسم الملف", "Search title, tag or file name")} value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 220 }} />
      <select value={category} onChange={(e) => setCategory(e.target.value)} style={{ width: "auto" }}><option value="">{tt("كل الأنواع", "All types")}</option>{CATS.map((c) => <option key={c} value={c}>{cat(c)}</option>)}</select>
      <label className="row"><input type="checkbox" style={{ width: "auto" }} checked={expiring} onChange={(e) => setExpiring(e.target.checked)} />{tt("تنتهي خلال 60 يومًا", "Expiring in 60 days")}</label>
      {can("documents.manage") && <button className="btn primary" onClick={() => setUploading(true)}>{tt("رفع مستند", "Upload")}</button>}</div></div>
    <ErrorBox error={list.error} />
    {list.loading ? <Loading /> : !list.data?.length ? <div className="card"><Empty /></div> : <div className="table-wrap"><table>
      <thead><tr><th>{tt("العنوان", "Title")}</th><th>{tt("النوع", "Type")}</th><th>{tt("الملف", "File")}</th><th>{tt("الإصدار", "Version")}</th><th>{tt("الانتهاء", "Expires")}</th><th>{tt("بواسطة", "By")}</th></tr></thead>
      <tbody>{list.data.map((d: any) => <tr key={d.id} style={{ cursor: "pointer" }} onClick={() => setOpenId(d.id)}>
        <td>{d.restricted ? "🔒 " : ""}<b>{d.title}</b>{d.tags.length ? <div style={{ fontSize: 12, color: "var(--muted)" }}>{d.tags.join(" · ")}</div> : null}</td>
        <td>{cat(d.category)}</td><td>{d.file_name} <span style={{ color: "var(--muted)", fontSize: 12 }}>{d.size_bytes ? size(d.size_bytes) : ""}</span></td><td className="num">v{d.current_version}</td>
        <td>{d.expires_on ? <span className={d.days_to_expiry < 0 ? "badge bad" : d.days_to_expiry <= 30 ? "badge warn" : ""}>{fmtDate(d.expires_on)}</span> : "—"}</td><td>{d.created_by_name}</td></tr>)}</tbody></table></div>}
    {uploading && <Upload onClose={() => { setUploading(false); list.reload(); }} />}
    {openId && <DocCard id={openId} onClose={() => { setOpenId(null); list.reload(); }} />}
  </>;
}

function Upload({ onClose }: { onClose: () => void }) {
  const { t, tt, lang } = useI18n();
  const { can, companyId } = useSession();
  const { toast } = useToast();
  const cat = useCat();
  const [f, setF] = useState({ title: "", category: "certificate", tags: "", expiresOn: "", restricted: false });
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const save = async () => {
    if (!file) return;
    if (file.size > 10 * 1048576) { toast(tt("الحد الأقصى 10 ميجابايت", "Maximum 10 MB"), true); return; }
    setBusy(true); setErr(null);
    try {
      await api.post("/documents", { companyId, title: f.title || file.name, category: f.category, tags: f.tags.split(/[,،]/).map((x) => x.trim()).filter(Boolean),
        expiresOn: f.expiresOn || undefined, restricted: f.restricted, file: { fileName: file.name, mimeType: file.type || "application/octet-stream", contentBase64: await toB64(file) } });
      toast(t.savedOk); onClose();
    } catch (e) { setErr(e); toast(errMsg(e, lang), true); } finally { setBusy(false); }
  };
  return <Modal title={tt("رفع مستند", "Upload a document")} onClose={onClose} footer={<><button className="btn" onClick={onClose}>{t.cancel}</button><button className="btn primary" disabled={!file || busy} onClick={save}>{t.save}</button></>}>
    <div className="alert info">{tt("PDF، صور، Word، Excel، نص — حتى 10 ميجابايت. يُحسب بصمة (SHA-256) لكل إصدار ولا يُحذف أي إصدار.", "PDF, images, Word, Excel, text — up to 10 MB. Each version gets a SHA-256 fingerprint and is never deleted.")}</div>
    <ErrorBox error={err} />
    <input type="file" accept=".pdf,.jpg,.jpeg,.png,.webp,.txt,.csv,.doc,.docx,.xls,.xlsx" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
    <div className="form-grid" style={{ marginTop: 12 }}>
      <Field label={tt("العنوان", "Title")}><input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder={file?.name} /></Field>
      <Field label={tt("النوع", "Type")}><select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{CATS.map((c) => <option key={c} value={c}>{cat(c)}</option>)}</select></Field>
      <Field label={tt("وسوم (مفصولة بفاصلة)", "Tags (comma separated)")}><input value={f.tags} onChange={(e) => setF({ ...f, tags: e.target.value })} /></Field>
      <Field label={tt("تاريخ الانتهاء (ترخيص/شهادة/عقد)", "Expiry (licence/certificate/contract)")}><input type="date" value={f.expiresOn} onChange={(e) => setF({ ...f, expiresOn: e.target.value })} /></Field>
    </div>
    {can("documents.restricted.view") && <label className="row"><input type="checkbox" style={{ width: "auto" }} checked={f.restricted} onChange={(e) => setF({ ...f, restricted: e.target.checked })} />🔒 {tt("سري (يراه أصحاب صلاحية المستندات السرية فقط)", "Restricted (only users with the restricted-documents permission)")}</label>}
  </Modal>;
}

function DocCard({ id, onClose }: { id: string; onClose: () => void }) {
  const { t, tt, lang } = useI18n();
  const { can, companyId } = useSession();
  const { toast } = useToast();
  const d = useAsync(() => api.get(`/documents/${id}`), [id]);
  const roles = useAsync(() => api.get("/roles").catch(() => []), []);
  const [file, setFile] = useState<File | null>(null);
  const [steps, setSteps] = useState<string[]>([""]);
  const newVersion = async () => {
    if (!file) return;
    try { await api.post(`/documents/${id}/versions`, { file: { fileName: file.name, mimeType: file.type || "application/octet-stream", contentBase64: await toB64(file) } }); setFile(null); d.reload(); toast(t.savedOk); }
    catch (e) { toast(errMsg(e, lang), true); }
  };
  const requestApproval = async () => {
    try {
      await api.post("/approvals", { companyId, title: `${tt("اعتماد", "Approve")}: ${d.data.title} v${d.data.current_version}`, entityType: "document", entityId: id,
        documentVersionId: d.data.versions[0].id, steps: steps.filter(Boolean).map((roleId) => ({ roleId })) });
      d.reload(); toast(tt("أُرسل طلب الاعتماد", "Approval requested"));
    } catch (e) { toast(errMsg(e, lang), true); }
  };
  return <Modal title={d.data?.title ?? "…"} onClose={onClose} footer={<><button className="btn" onClick={onClose}>{t.close}</button>
    {d.data?.status === "active" && can("documents.manage") && <button className="btn" onClick={async () => { await api.post(`/documents/${id}/archive`, {}); onClose(); }}>{tt("أرشفة", "Archive")}</button>}</>}>
    <ErrorBox error={d.error} />
    {!d.data ? <Loading /> : <>
      <h3>{tt("الإصدارات", "Versions")}</h3>
      <LinesTable rows={d.data.versions} cols={[{ h: "v", v: (v) => v.version }, { h: tt("الملف", "File"), v: (v) => v.file_name }, { h: tt("الحجم", "Size"), v: (v) => size(v.size_bytes) },
        { h: tt("البصمة", "SHA-256"), v: (v) => <code title={v.sha256} style={{ fontSize: 11 }}>{v.sha256.slice(0, 12)}…</code> }, { h: tt("رفع", "Uploaded"), v: (v) => `${fmtDateTime(v.uploaded_at)} · ${v.uploaded_by_name ?? ""}` },
        { h: "", v: (v) => <button className="btn" onClick={() => download(id, v.version, v.file_name).catch((e) => toast(String(e), true))}>⬇</button> }]} />
      {can("documents.manage") && d.data.status === "active" && <div className="row" style={{ marginTop: 8 }}><input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <button className="btn" disabled={!file} onClick={newVersion}>{tt("رفع إصدار جديد", "Upload new version")}</button></div>}
      <h3>{tt("الاعتمادات", "Approvals")}</h3>
      {d.data.approvals.length ? <LinesTable rows={d.data.approvals} cols={[{ h: tt("الطلب", "Request"), v: (a) => a.title }, { h: t.status, v: (a) => <StatusBadge s={a.status} /> }, { h: t.date, v: (a) => fmtDate(a.created_at) }]} /> : <Empty />}
      {can("documents.approvals.request") && <div className="card" style={{ marginTop: 8 }}>
        <b>{tt("طلب اعتماد إلكتروني (خطوات متتالية حسب الدور)", "Request e-approval (sequential steps by role)")}</b>
        {steps.map((s, i) => <div className="row" key={i} style={{ marginTop: 4 }}><span className="num">{i + 1}.</span>
          <select value={s} onChange={(e) => setSteps(steps.map((x, j) => (j === i ? e.target.value : x)))}><option value="">…</option>{(roles.data ?? []).map((r: any) => <option key={r.id} value={r.id}>{r.name_ar}</option>)}</select></div>)}
        <div className="row" style={{ marginTop: 6 }}><button className="btn" onClick={() => setSteps([...steps, ""])}>+ {tt("خطوة", "Step")}</button>
          <button className="btn primary" disabled={!steps.some(Boolean)} onClick={requestApproval}>{tt("إرسال للاعتماد", "Send for approval")}</button></div></div>}
    </>}
  </Modal>;
}

export function ApprovalsInbox() {
  const { tt, lang } = useI18n();
  const { toast } = useToast();
  const inbox = useAsync(() => api.get("/approvals/inbox"), []);
  const [openId, setOpenId] = useState<string | null>(null);
  const detail = useAsync(() => (openId ? api.get(`/approvals/${openId}`) : Promise.resolve(null)), [openId]);
  const [comment, setComment] = useState("");
  const decide = async (decision: "approved" | "rejected") => {
    try { await api.post(`/approvals/${openId}/decide`, { decision, comment: comment || undefined }); setOpenId(null); setComment(""); inbox.reload(); toast(decision === "approved" ? tt("تم الاعتماد", "Approved") : tt("تم الرفض", "Rejected")); }
    catch (e) { toast(errMsg(e, lang), true); }
  };
  return <>
    <div className="page-head"><h1>{tt("طلبات بانتظار اعتمادي", "Waiting for my approval")}</h1></div>
    <ErrorBox error={inbox.error} />
    {inbox.loading ? <Loading /> : !inbox.data?.length ? <div className="card"><Empty text={tt("لا توجد طلبات بانتظارك", "Nothing waiting for you")} /></div> : <LinesTable rows={inbox.data} cols={[
      { h: tt("الطلب", "Request"), v: (a) => a.title }, { h: tt("مقدم الطلب", "Requested by"), v: (a) => a.requested_by_name }, { h: tt("الخطوة", "Step"), v: (a) => a.seq },
      { h: "", v: (a) => <button className="btn primary" onClick={() => setOpenId(a.id)}>{tt("مراجعة", "Review")}</button> }]} />}
    {openId && detail.data && <Modal title={detail.data.title} onClose={() => setOpenId(null)} footer={<><button className="btn danger" onClick={() => decide("rejected")}>{tt("رفض", "Reject")}</button><button className="btn primary" onClick={() => decide("approved")}>{tt("اعتماد", "Approve")}</button></>}>
      <LinesTable rows={detail.data.steps} cols={[{ h: "#", v: (s) => s.seq }, { h: tt("المعتمد", "Approver"), v: (s) => s.role_name_ar ?? s.approver_name }, { h: tt("القرار", "Decision"), v: (s) => <StatusBadge s={s.status} /> },
        { h: tt("بواسطة", "By"), v: (s) => s.decided_by_name ? `${s.decided_by_name} · ${fmtDateTime(s.decided_at)}` : "—" }, { h: tt("ملاحظة", "Comment"), v: (s) => s.comment ?? "" }]} />
      {detail.data.entity_type === "document" && <p style={{ fontSize: 12, color: "var(--muted)" }}>{tt("يُسجَّل مع قرارك بصمة الملف المعتمد بالضبط.", "Your decision records the fingerprint of the exact file approved.")}</p>}
      <Field label={tt("ملاحظة (إلزامية عند الرفض)", "Comment (required to reject)")}><textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
    </Modal>}
  </>;
}
