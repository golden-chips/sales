import { useState } from "react";
import { api, fmt, fmtDate, fmtDateTime } from "../../api";
import { useI18n } from "../../i18n";
import { useSession } from "../../session";
import { Empty, ErrorBox, Field, Loading, Modal, errMsg, useAsync, useToast } from "../../ui";
import { LinesTable, useLookups } from "../erp/shared";

const STAGES = ["receiving", "in_process", "final", "return"] as const;

function useStageLabel() {
  const { tt } = useI18n();
  return (s: string) => ({ receiving: tt("استلام", "Receiving"), in_process: tt("أثناء التصنيع", "In-process"), final: tt("نهائي", "Final"), return: tt("مرتجع", "Return") }[s] ?? s);
}

export function QualityChecks() {
  const { t, tt } = useI18n();
  const { can, companyId } = useSession();
  const stage = useStageLabel();
  const [result, setResult] = useState("");
  const [rec, setRec] = useState(false);
  const list = useAsync(() => api.get(`/quality/checks?companyId=${companyId}&pageSize=100${result ? `&result=${result}` : ""}`), [companyId, result]);
  return <>
    <div className="page-head"><h1>{tt("فحوصات الجودة", "Quality checks")}</h1><div className="row">
      <select value={result} onChange={(e) => setResult(e.target.value)} style={{ width: "auto" }}><option value="">{t.status}: *</option><option value="pass">pass</option><option value="fail">fail</option></select>
      {can("quality.checks.create") && <button className="btn primary" onClick={() => setRec(true)}>{tt("تسجيل فحص", "Record check")}</button>}</div></div>
    <ErrorBox error={list.error} />
    {list.loading ? <Loading /> : !list.data?.data.length ? <div className="card"><Empty /></div> : <div className="table-wrap"><table>
      <thead><tr><th>{t.number}</th><th>{t.date}</th><th>{tt("التشغيلة", "Lot")}</th><th>{tt("المرحلة", "Stage")}</th><th>{tt("النتائج", "Results")}</th><th>{t.status}</th><th>{t.actor}</th></tr></thead>
      <tbody>{list.data.data.map((c: any) => <tr key={c.id}><td className="num">{c.number}</td><td className="num">{fmtDateTime(c.checked_at)}</td><td>{c.item_code} · {c.lot_no}</td><td>{stage(c.stage)}</td>
        <td style={{ whiteSpace: "normal" }}>{c.results.map((r: any) => <span key={r.parameter} className={`badge ${r.passed ? "" : "bad"}`} style={{ marginInlineEnd: 4 }}>{r.is_ccp ? "CCP " : ""}{r.parameter}: {r.value ?? r.text_value ?? (r.passed ? "✔" : "✗")}{r.unit ?? ""}</span>)}</td>
        <td><span className={`badge ${c.result === "pass" ? "ok" : "bad"}`}>{c.result}</span></td><td>{c.checked_by_name}</td></tr>)}</tbody>
    </table></div>}
    {rec && <RecordCheck onClose={() => { setRec(false); list.reload(); }} />}
  </>;
}

function RecordCheck({ onClose }: { onClose: () => void }) {
  const { t, tt, lang } = useI18n();
  const { companyId } = useSession();
  const { toast } = useToast();
  const stageL = useStageLabel();
  const [q, setQ] = useState("");
  const [lot, setLot] = useState<any | null>(null);
  const [stage, setStage] = useState<string>("final");
  const [vals, setVals] = useState<Record<string, any>>({});
  const [extra, setExtra] = useState({ parameter: "", passed: true });
  const [err, setErr] = useState<unknown>(null);
  const lots = useAsync(() => api.get(`/inventory/lots?companyId=${companyId}${q ? `&q=${encodeURIComponent(q)}` : ""}`), [companyId, q]);
  const specs = useAsync(() => (lot ? api.get(`/quality/specs?itemId=${lot.item_id}`) : Promise.resolve([])), [lot?.item_id]);
  const stageSpecs = (specs.data ?? []).filter((s: any) => s.stage === stage);
  const save = async () => {
    setErr(null);
    try {
      const results = stageSpecs.map((s: any) => (s.min_value !== null || s.max_value !== null) ? { parameter: s.parameter, value: vals[s.parameter] ?? "" } : { parameter: s.parameter, passed: vals[s.parameter] !== false });
      if (!stageSpecs.length && extra.parameter) results.push({ parameter: extra.parameter, passed: extra.passed });
      const r = await api.post("/quality/checks", { companyId, lotId: lot.id, stage, results });
      toast(r.result === "pass" ? tt("الفحص ناجح", "Check passed") : `${tt("الفحص فشل — التشغيلة موقوفة و", "Check failed — lot on hold, ")}${r.ncr?.number}`, r.result !== "pass");
      onClose();
    } catch (e) { setErr(e); toast(errMsg(e, lang), true); }
  };
  return <Modal title={tt("تسجيل فحص جودة", "Record quality check")} onClose={onClose} footer={<><button className="btn" onClick={onClose}>{t.cancel}</button>{lot && <button className="btn primary" onClick={save}>{t.save}</button>}</>}>
    <div className="alert info">{tt("النظام يحكم على القيم الرقمية حسب المواصفة. أي فشل يوقف التشغيلة ويفتح حالة عدم مطابقة.", "Numeric values are judged by the system against the spec. Any failure holds the lot and opens a non-conformance.")}</div>
    <ErrorBox error={err} />
    <div className="form-grid" style={{ marginBottom: 12 }}>
      <Field label={tt("بحث عن تشغيلة", "Find lot")}><input value={q} onChange={(e) => setQ(e.target.value)} /></Field>
      <Field label={tt("التشغيلة", "Lot")}><select value={lot?.id ?? ""} onChange={(e) => setLot(lots.data?.find((l: any) => l.id === e.target.value) ?? null)}><option value="">—</option>
        {lots.data?.map((l: any) => <option key={l.id} value={l.id}>{l.item_code} · {l.lot_no}{l.on_hold ? " ⛔" : ""}</option>)}</select></Field>
      <Field label={tt("المرحلة", "Stage")}><select value={stage} onChange={(e) => setStage(e.target.value)}>{STAGES.map((s) => <option key={s} value={s}>{stageL(s)}</option>)}</select></Field>
    </div>
    {lot && (stageSpecs.length ? <LinesTable rows={stageSpecs} cols={[{ h: tt("المعيار", "Parameter"), v: (s) => <>{s.is_ccp && <span className="badge bad">CCP</span>} {s.parameter}</> },
      { h: tt("المواصفة", "Spec"), v: (s) => s.min_value !== null || s.max_value !== null ? `${s.min_value !== null ? Number(s.min_value) : "…"} – ${s.max_value !== null ? Number(s.max_value) : "…"} ${s.unit ?? ""}` : tt("مطابق/غير مطابق", "pass/fail") },
      { h: tt("القيمة المقاسة", "Measured"), v: (s) => s.min_value !== null || s.max_value !== null
        ? <input className="num" style={{ width: 100 }} value={vals[s.parameter] ?? ""} onChange={(e) => setVals({ ...vals, [s.parameter]: e.target.value })} />
        : <select value={String(vals[s.parameter] !== false)} onChange={(e) => setVals({ ...vals, [s.parameter]: e.target.value === "true" })}><option value="true">✔</option><option value="false">✗</option></select> }]} />
      : <div className="row"><span style={{ color: "var(--muted)" }}>{tt("لا توجد مواصفات لهذه المرحلة — سجّل معيارًا واحدًا على الأقل:", "No specs for this stage — record at least one parameter:")}</span>
        <input value={extra.parameter} onChange={(e) => setExtra({ ...extra, parameter: e.target.value })} placeholder={tt("المعيار", "Parameter")} style={{ width: 180 }} />
        <select value={String(extra.passed)} onChange={(e) => setExtra({ ...extra, passed: e.target.value === "true" })} style={{ width: 80 }}><option value="true">✔</option><option value="false">✗</option></select></div>)}
  </Modal>;
}

export function QualitySpecs() {
  const { t, tt, lang } = useI18n();
  const { can } = useSession();
  const { toast } = useToast();
  const { items } = useLookups();
  const stageL = useStageLabel();
  const [itemId, setItemId] = useState("");
  const [stage, setStage] = useState("final");
  const [rows, setRows] = useState<any[] | null>(null);
  const load = async (id: string, st: string) => {
    setItemId(id); setStage(st);
    if (!id) return setRows(null);
    const all = await api.get(`/quality/specs?itemId=${id}`);
    setRows(all.filter((s: any) => s.stage === st).map((s: any) => ({ parameter: s.parameter, unit: s.unit ?? "", min: s.min_value ?? "", max: s.max_value ?? "", isCcp: s.is_ccp })));
  };
  const save = async () => {
    try { await api.put("/quality/specs", { itemId, stage, specs: rows!.filter((r) => r.parameter).map((r) => ({ parameter: r.parameter, unit: r.unit || undefined, min: r.min === "" ? null : r.min, max: r.max === "" ? null : r.max, isCcp: !!r.isCcp })) }); toast(t.savedOk); }
    catch (e) { toast(errMsg(e, lang), true); }
  };
  const set = (i: number, p: any) => setRows(rows!.map((r, j) => (j === i ? { ...r, ...p } : r)));
  return <>
    <div className="page-head"><div><h1>{tt("مواصفات الجودة و HACCP", "Quality specs & HACCP")}</h1><p>{tt("نقطة التحكم الحرجة (CCP): أي خروج عن حدودها يُفشل التشغيلة.", "Critical control point (CCP): any deviation fails the lot.")}</p></div></div>
    <div className="card row" style={{ marginBottom: 12 }}>
      <select value={itemId} onChange={(e) => load(e.target.value, stage)} style={{ maxWidth: 320 }}><option value="">{tt("الصنف", "Item")}</option>{items.map((i: any) => <option key={i.id} value={i.id}>{i.code} {i.name_ar}</option>)}</select>
      <select value={stage} onChange={(e) => load(itemId, e.target.value)} style={{ width: "auto" }}>{STAGES.map((s) => <option key={s} value={s}>{stageL(s)}</option>)}</select>
    </div>
    {rows && <div className="card grid">
      {rows.map((r, i) => <div className="row" key={i}>
        <input placeholder={tt("المعيار", "Parameter")} value={r.parameter} onChange={(e) => set(i, { parameter: e.target.value })} style={{ flex: 2 }} />
        <input placeholder={tt("الوحدة", "Unit")} value={r.unit} onChange={(e) => set(i, { unit: e.target.value })} style={{ width: 70 }} />
        <input className="num" placeholder="min" value={r.min} onChange={(e) => set(i, { min: e.target.value })} style={{ width: 90 }} />
        <input className="num" placeholder="max" value={r.max} onChange={(e) => set(i, { max: e.target.value })} style={{ width: 90 }} />
        <label className="row"><input type="checkbox" checked={!!r.isCcp} onChange={(e) => set(i, { isCcp: e.target.checked })} style={{ width: "auto" }} />CCP</label>
        <button className="btn sm" onClick={() => setRows(rows.filter((_, j) => j !== i))}>✕</button></div>)}
      <div className="row"><button className="btn sm" onClick={() => setRows([...rows, { parameter: "", unit: "", min: "", max: "", isCcp: false }])}>+ {t.addLine}</button><span className="spacer" />
        {can("quality.specs.manage") && <button className="btn primary" onClick={save}>{t.save}</button>}</div>
    </div>}
  </>;
}

export function NonConformances() {
  const { t, tt, lang } = useI18n();
  const { can, companyId } = useSession();
  const { toast } = useToast();
  const [status, setStatus] = useState("open");
  const [close, setClose] = useState<any | null>(null);
  const list = useAsync(() => api.get(`/quality/ncrs?companyId=${companyId}${status ? `&status=${status}` : ""}`), [companyId, status]);
  const save = async () => { try { await api.post(`/quality/ncrs/${close.id}/close`, close.form); setClose(null); list.reload(); toast(t.savedOk); } catch (e) { toast(errMsg(e, lang), true); } };
  return <>
    <div className="page-head"><h1>{tt("عدم المطابقة والإجراءات التصحيحية (CAPA)", "Non-conformance & CAPA")}</h1>
      <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: "auto" }}><option value="open">{tt("مفتوحة", "Open")}</option><option value="closed">{tt("مغلقة", "Closed")}</option><option value="">*</option></select></div>
    <ErrorBox error={list.error} />
    {list.loading ? <Loading /> : !list.data?.length ? <div className="card"><Empty /></div> : <div className="table-wrap"><table>
      <thead><tr><th>{t.number}</th><th>{t.date}</th><th>{tt("التشغيلة", "Lot")}</th><th>{t.details}</th><th>{tt("التصرف", "Disposition")}</th><th>{t.status}</th><th /></tr></thead>
      <tbody>{list.data.map((n: any) => <tr key={n.id}><td className="num">{n.number}</td><td className="num">{fmtDate(n.created_at)}</td><td>{n.item_code} · {n.lot_no}</td>
        <td style={{ whiteSpace: "normal", maxWidth: 380 }}>{n.description}{n.corrective_action && <div style={{ color: "var(--muted)" }}>CAPA: {n.corrective_action}</div>}</td><td>{n.disposition}</td>
        <td><span className={`badge ${n.status === "open" ? "warn" : "ok"}`}>{n.status}</span></td>
        <td>{n.status === "open" && can("quality.ncr.manage") && <button className="btn sm" onClick={() => setClose({ id: n.id, form: { disposition: "rework", rootCause: "", correctiveAction: "", preventiveAction: "" } })}>{t.close}</button>}</td></tr>)}</tbody>
    </table></div>}
    {close && <Modal title={tt("إغلاق حالة عدم المطابقة", "Close non-conformance")} onClose={() => setClose(null)} footer={<><button className="btn" onClick={() => setClose(null)}>{t.cancel}</button><button className="btn primary" onClick={save}>{t.save}</button></>}>
      <div className="grid">
        <Field label={tt("التصرف", "Disposition")}><select value={close.form.disposition} onChange={(e) => setClose({ ...close, form: { ...close.form, disposition: e.target.value } })}>
          {["rework", "scrap", "return_to_supplier", "use_as_is"].map((d) => <option key={d}>{d}</option>)}</select></Field>
        {(["rootCause", "correctiveAction", "preventiveAction"] as const).map((k) => <Field key={k} label={{ rootCause: tt("السبب الجذري", "Root cause"), correctiveAction: tt("الإجراء التصحيحي", "Corrective action"), preventiveAction: tt("الإجراء الوقائي", "Preventive action") }[k]}>
          <textarea rows={2} value={close.form[k]} onChange={(e) => setClose({ ...close, form: { ...close.form, [k]: e.target.value } })} /></Field>)}
        <p style={{ color: "var(--muted)", fontSize: 12 }}>{tt("إغلاق الحالة لا يرفع الإيقاف تلقائيًا: يلزم فحص ناجح جديد للتشغيلة.", "Closing does not lift the hold by itself: a new passing check is required.")}</p>
      </div>
    </Modal>}
  </>;
}

export function TraceRecall() {
  const { tt, t, lang } = useI18n();
  const { can, companyId } = useSession();
  const { toast, confirm } = useToast();
  const [q, setQ] = useState("");
  const [lotId, setLotId] = useState<string | null>(null);
  const lots = useAsync(() => api.get(`/inventory/lots?companyId=${companyId}${q ? `&q=${encodeURIComponent(q)}` : ""}`), [companyId, q]);
  const trace = useAsync(() => (lotId ? api.get(`/quality/trace/${lotId}`) : Promise.resolve(null)), [lotId]);
  const recalls = useAsync(() => api.get(`/quality/recalls?companyId=${companyId}`), [companyId]);
  const recall = async () => {
    const reason = prompt(tt("سبب الاستدعاء", "Recall reason")); if (!reason) return;
    if (!(await confirm(tt("سيتم إيقاف كل التشغيلات المشتقة فورًا ومنع بيعها واستخدامها. متابعة؟", "Every derived lot will be put on hold immediately (no sale, no production use). Continue?")))) return;
    try { const r = await api.post("/quality/recalls", { companyId, lotId, reason }); toast(`${r.number}: ${r.forward.lots.length} ${tt("تشغيلة موقوفة", "lots on hold")}`); trace.reload(); recalls.reload(); lots.reload(); }
    catch (e) { toast(errMsg(e, lang), true); }
  };
  return <>
    <div className="page-head"><div><h1>{tt("التتبع والاستدعاء", "Traceability & recall")}</h1><p>{tt("من المورد عبر أوامر الإنتاج إلى كل عميل — في الاتجاهين.", "From supplier through production orders to every customer — both directions.")}</p></div>
      <input type="search" placeholder={tt("رقم التشغيلة أو الصنف", "Lot or item")} value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 240 }} /></div>
    <div className="grid" style={{ gridTemplateColumns: "minmax(260px, 340px) 1fr" }}>
      <div className="card" style={{ padding: 8, maxHeight: 600, overflow: "auto" }}>
        {lots.loading ? <Loading rows={3} /> : <nav className="nav">{lots.data?.map((l: any) => <a key={l.id} href="#" className={l.id === lotId ? "active" : ""} onClick={(e) => { e.preventDefault(); setLotId(l.id); }}>
          <span>{l.lot_no}</span><span style={{ color: "var(--muted)", fontSize: 12 }}>{l.item_code}</span><span className="spacer" />{l.on_hold && <span className="badge bad">hold</span>}{l.last_qc && <span className={`badge ${l.last_qc === "pass" ? "ok" : "bad"}`}>QC</span>}</a>)}</nav>}
      </div>
      <div className="grid">
        {!lotId ? <div className="card"><Empty text={tt("اختر تشغيلة", "Pick a lot")} /></div> : trace.loading ? <Loading /> : trace.data && <>
          <div className="card"><div className="row"><h2 style={{ margin: 0 }}>{tt("للخلف: من أين جاءت؟", "Backward: where did it come from?")}</h2><span className="spacer" />
            {can("quality.recall.manage") && <button className="btn danger" onClick={recall}>{tt("بدء استدعاء", "Start recall")}</button>}</div>
            <LinesTable rows={trace.data.backward} cols={[{ h: tt("المستوى", "Level"), v: (n) => "↳".repeat(n.depth) || "●" }, { h: tt("التشغيلة", "Lot"), v: (n) => `${n.item_code} · ${n.lot_no}` },
              { h: tt("أمر الإنتاج", "Made by"), v: (n) => n.produced_by_order ?? "" }, { h: tt("المورد", "Supplier"), v: (n) => n.supplier_name_ar ?? "" }, { h: tt("الانتهاء", "Expiry"), v: (n) => fmtDate(n.expiry_date) },
              { h: t.status, v: (n) => n.on_hold ? <span className="badge bad">hold</span> : "" }]} /></div>
          <div className="card"><h2>{tt("للأمام: أين ذهبت؟", "Forward: where did it go?")}</h2>
            <LinesTable rows={trace.data.forward.lots} cols={[{ h: tt("التشغيلة", "Lot"), v: (l) => `${l.item_code} · ${l.lot_no}` },
              { h: tt("الرصيد الحالي", "On hand"), v: (l) => l.on_hand.map((x: any) => `${x.warehouse}: ${Number(x.qty)}`).join(" · ") }, { h: t.status, v: (l) => l.on_hold ? <span className="badge bad">hold</span> : "" }]} />
            <h3 style={{ marginTop: 12 }}>{tt("العملاء المتأثرون", "Affected customers")}</h3>
            {!trace.data.forward.customers.length ? <p style={{ color: "var(--muted)" }}>{t.none}</p> :
              <LinesTable rows={trace.data.forward.customers} cols={[{ h: t.code, v: (c) => c.code }, { h: t.name, v: (c) => c.name_ar }, { h: tt("الهاتف", "Phone"), v: (c) => c.phone ?? "" },
                { h: tt("التشغيلة", "Lot"), v: (c) => c.lot_no }, { h: tt("مباع", "Sold"), v: (c) => fmt(c.sold, 0), end: true }, { h: tt("بالسوق", "In market"), v: (c) => <b>{fmt(c.in_market, 0)}</b>, end: true }]} />}</div>
        </>}
        {!!recalls.data?.length && <div className="card"><h2>{tt("سجل الاستدعاءات", "Recalls")}</h2>
          <LinesTable rows={recalls.data} cols={[{ h: t.number, v: (r) => r.number }, { h: t.date, v: (r) => fmtDate(r.created_at) }, { h: tt("التشغيلة", "Lot"), v: (r) => r.lot_no },
            { h: t.reason, v: (r) => r.reason }, { h: tt("تشغيلات", "Lots"), v: (r) => r.lots }, { h: tt("عملاء", "Customers"), v: (r) => r.customer_lines }]} /></div>}
      </div>
    </div>
  </>;
}
