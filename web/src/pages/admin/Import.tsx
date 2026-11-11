import { useState } from "react";
import { API_BASE, api, getSession } from "../../api";
import { useI18n } from "../../i18n";
import { useSession } from "../../session";
import { ErrorBox, Loading, errMsg, useAsync, useToast } from "../../ui";
import { LinesTable, today } from "../erp/shared";

const ORDER_AR = "الترتيب المقترح: الأصناف ← العملاء والموردون ← أرصدة المخزون ← الأرصدة الافتتاحية للحسابات";

export default function Import() {
  const { tt, lang } = useI18n();
  const { companyId } = useSession();
  const { toast } = useToast();
  const kinds = useAsync(() => api.get("/import/kinds"), []);
  const [kind, setKind] = useState("items");
  const [file, setFile] = useState<{ name: string; b64: string } | null>(null);
  const [date, setDate] = useState(today());
  const [res, setRes] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const k = kinds.data?.find((x: any) => x.kind === kind);

  const download = async () => {
    const r = await fetch(`${API_BASE}/api/v1/import/templates/${kind}`, { headers: { authorization: `Bearer ${getSession("tenant")?.accessToken}` } });
    if (!r.ok) return toast(tt("تعذر تنزيل القالب", "Template download failed"), true);
    const a = document.createElement("a"); a.href = URL.createObjectURL(await r.blob()); a.download = `golden-erp-${kind}.xlsx`; a.click(); URL.revokeObjectURL(a.href);
  };
  const pick = (f?: File) => {
    setRes(null); setErr(null);
    if (!f) return setFile(null);
    if (f.size > 5 * 1024 * 1024) return toast(tt("الحد الأقصى 5 ميجابايت", "Max 5 MB"), true);
    const rd = new FileReader();
    rd.onload = () => setFile({ name: f.name, b64: String(rd.result).split(",")[1] });
    rd.readAsDataURL(f);
  };
  const run = async (commit: boolean) => {
    if (!file) return;
    setBusy(true); setErr(null);
    try {
      const r = await api.post(`/import/${kind}`, { companyId, fileBase64: file.b64, commit, date });
      setRes(r);
      if (r.committed) toast(tt("تم الاستيراد", "Imported"));
    } catch (e) { setErr(e); toast(errMsg(e, lang), true); } finally { setBusy(false); }
  };
  if (kinds.loading) return <Loading />;
  return <>
    <div className="page-head"><div><h1>{tt("استيراد البيانات من Excel", "Import from Excel")}</h1><p>{ORDER_AR}</p></div></div>
    <div className="card grid" style={{ maxWidth: 820 }}>
      <div className="row">
        {kinds.data?.map((x: any) => <button key={x.kind} className={`btn ${x.kind === kind ? "primary" : ""}`} disabled={!x.allowed} title={x.allowed ? "" : x.permission}
          onClick={() => { setKind(x.kind); setRes(null); setFile(null); }}>{x.titleAr}</button>)}
      </div>
      <div className="row"><b>1.</b><button className="btn" onClick={download}>⬇ {tt("تنزيل القالب", "Download template")} ({k?.titleAr})</button>
        <span style={{ color: "var(--muted)", fontSize: 12 }}>{tt("الأعمدة الإلزامية:", "Required:")} {k?.columns.filter((c: any) => c.required).map((c: any) => c.ar).join("، ")}</span></div>
      <div className="row"><b>2.</b><input type="file" accept=".xlsx" onChange={(e) => pick(e.target.files?.[0])} style={{ maxWidth: 360 }} />
        {(kind === "opening_stock" || kind === "opening_balances") && <><span>{tt("تاريخ الرصيد", "As of")}</span><input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ width: "auto" }} /></>}</div>
      <div className="row"><b>3.</b><button className="btn" disabled={!file || busy} onClick={() => run(false)}>{tt("معاينة وفحص", "Preview & validate")}</button>
        <button className="btn primary" disabled={!file || busy || !res || res.issueCount > 0 || res.committed} onClick={() => run(true)}>{tt("استيراد", "Import")}</button>
        {busy && <span>{tt("جارٍ المعالجة…", "Working…")}</span>}</div>
      <ErrorBox error={err} />
      {res && <>
        <div className="balance-bar"><span>{tt("الصفوف", "Rows")} <b className="num">{res.rows}</b></span><span>{tt("جديد", "New")} <b className="num">{res.creates}</b></span>
          <span>{tt("تحديث", "Update")} <b className="num">{res.updates}</b></span>
          <span className={`badge ${res.issueCount ? "bad" : "ok"}`}>{res.issueCount ? `${res.issueCount} ${tt("خطأ", "errors")}` : tt("الملف سليم", "File is valid")}</span>
          {res.committed && <span className="badge ok">{tt("تم الحفظ", "Saved")}</span>}</div>
        {res.issueCount > 0 && <><p style={{ color: "var(--muted)" }}>{tt("صحّح الأخطاء في الملف ثم أعد رفعه. لن يُحفظ أي صف حتى يصبح الملف كله سليمًا.", "Fix the file and upload again. Nothing is saved until every row is valid.")}</p>
          <LinesTable rows={res.issues} cols={[{ h: tt("الصف", "Row"), v: (i) => i.row || "—" }, { h: tt("العمود", "Column"), v: (i) => <code>{i.field}</code> }, { h: tt("المشكلة", "Problem"), v: (i) => i.message }]} /></>}
        {res.committed && (kind === "opening_stock" || kind === "opening_balances") &&
          <div className="alert info">{tt("أُنشئ مستند مسودة. يراجعه ويرحّله مستخدم آخر من", "A draft was created. Another user reviews and posts it from")} {kind === "opening_stock" ? tt("«المستندات المخزنية»", "Stock documents") : tt("«القيود اليومية»", "Journal entries")}.</div>}
      </>}
    </div>
  </>;
}
