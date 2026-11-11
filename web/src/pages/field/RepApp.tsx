// Rep app (mobile web). Works offline: every operation is queued on the device
// with a unique clientId and synced when online. The server applies each op at
// most once per clientId, so retries and double taps can never duplicate an
// invoice or a receipt.
import { useEffect, useState } from "react";
import { api, fmt } from "../../api";
import { useI18n } from "../../i18n";
import { ErrorBox, Field, Loading, Modal, errMsg, useAsync, useToast } from "../../ui";
import { today } from "../erp/shared";

type Op = { clientId: string; type: "invoice" | "receipt" | "visit"; payload: any; label: string; clientTime: string; lastError?: string };
const KEY = "ge.field.queue";
const loadQ = (): Op[] => { try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch { return []; } };
const saveQ = (q: Op[]) => { try { localStorage.setItem(KEY, JSON.stringify(q)); } catch { /* storage unavailable: queue lives in memory only for this tab */ } };

export default function RepApp() {
  const { t, tt, lang } = useI18n();
  const { toast } = useToast();
  const [date] = useState(today());
  const day = useAsync(() => api.get(`/field/my-day?date=${date}`), [date]);
  const [queue, setQueue] = useState<Op[]>(loadQ);
  const [online, setOnline] = useState(navigator.onLine);
  const [syncing, setSyncing] = useState(false);
  const [sheet, setSheet] = useState<{ kind: "invoice" | "receipt" | "visit"; customer: any } | null>(null);
  const [extra, setExtra] = useState<"handover" | "settle" | null>(null);

  useEffect(() => { saveQ(queue); }, [queue]);
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener("online", on); window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, []);

  const enqueue = (op: Omit<Op, "clientId" | "clientTime">) => {
    const q = [...queue, { ...op, clientId: `${op.type}-${crypto.randomUUID()}`, clientTime: new Date().toISOString() }];
    setQueue(q); setSheet(null);
    if (navigator.onLine) sync(q);
  };
  const sync = async (q = queue) => {
    if (!q.length || syncing) return;
    setSyncing(true);
    try {
      const r = await api.post("/field/sync", { ops: q.map(({ clientId, type, payload, clientTime }) => ({ clientId, type, payload, clientTime })) });
      const failed = new Map(r.results.filter((x: any) => !x.ok).map((x: any) => [x.clientId, lang === "ar" ? x.error.message_ar ?? x.error.code : x.error.message ?? x.error.code]));
      const rest = q.filter((o) => failed.has(o.clientId)).map((o) => ({ ...o, lastError: String(failed.get(o.clientId)) }));
      setQueue(rest);
      toast(`${tt("تمت مزامنة", "Synced")} ${r.ok}${r.failed ? ` · ${tt("مرفوض", "rejected")} ${r.failed}` : ""}`, r.failed > 0);
      day.reload();
    } catch (e) { toast(`${tt("تعذرت المزامنة — ستُعاد لاحقًا", "Sync failed — will retry")}: ${errMsg(e, lang)}`, true); }
    finally { setSyncing(false); }
  };
  useEffect(() => { if (online && queue.length) sync(); /* eslint-disable-next-line */ }, [online]);

  if (day.loading) return <Loading />;
  if (day.error) return <ErrorBox error={day.error} />;
  const d = day.data;
  const pending = new Set(queue.map((o) => o.payload.customerId));
  return (
    <div style={{ maxWidth: 560, margin: "0 auto" }} className="grid">
      <div className="card">
        <div className="row"><b>{tt("يومي", "My day")} · {d.rep.code}</b><span className="spacer" />
          <span className={`badge ${online ? "ok" : "warn"}`}>{online ? tt("متصل", "Online") : tt("بدون اتصال", "Offline")}</span>
          {queue.length > 0 && <button className="btn sm" disabled={syncing || !online} onClick={() => sync()}>{tt("مزامنة", "Sync")} ({queue.length})</button>}</div>
        <div className="grid kpis" style={{ marginTop: 12, gridTemplateColumns: "repeat(2, 1fr)" }}>
          <div className="kpi"><div className="label">{tt("مبيعات اليوم", "Today's sales")}</div><div className="value num">{fmt(d.today.sales)}</div></div>
          <div className="kpi"><div className="label">{tt("التحصيل", "Collected")}</div><div className="value num">{fmt(d.today.collections)}</div></div>
          <div className="kpi"><div className="label">{tt("العهدة النقدية", "Cash custody")}</div><div className="value num">{fmt(d.custody)}</div></div>
          <div className="kpi"><div className="label">{tt("الزيارات", "Visits")}</div><div className="value num">{d.today.visits} / {d.route.length}</div></div>
        </div>
      </div>
      {queue.some((o) => o.lastError) && <div className="alert bad">{queue.filter((o) => o.lastError).map((o) => <div key={o.clientId}>{o.label}: {o.lastError}
        <button className="btn sm" style={{ marginInlineStart: 8 }} onClick={() => setQueue(queue.filter((x) => x.clientId !== o.clientId))}>{t.delete}</button></div>)}</div>}
      <div className="card" style={{ padding: 0 }}>
        <div style={{ padding: "12px 16px" }}><b>{tt("مسار اليوم", "Today's route")}</b></div>
        {!d.route.length && <p style={{ padding: "0 16px 12px", color: "var(--muted)" }}>{tt("لا يوجد مسار لهذا اليوم", "No route today")}</p>}
        {d.route.map((c: any) => (
          <div key={c.id} style={{ padding: "10px 16px", borderTop: "1px solid var(--line)" }}>
            <div className="row"><span className="num" style={{ color: "var(--muted)" }}>{c.seq}</span><b>{c.name_ar}</b>
              {c.visited_today && <span className="badge ok">✔</span>}{pending.has(c.id) && <span className="badge warn">{tt("بانتظار المزامنة", "pending")}</span>}
              <span className="spacer" /><span className="num" style={{ color: Number(c.balance) > 0 ? "var(--bad)" : "var(--muted)" }}>{fmt(c.balance)}</span></div>
            <div className="row" style={{ marginTop: 6 }}>
              <button className="btn sm primary" onClick={() => setSheet({ kind: "invoice", customer: c })}>{tt("فاتورة", "Invoice")}</button>
              <button className="btn sm" onClick={() => setSheet({ kind: "receipt", customer: c })}>{tt("تحصيل", "Collect")}</button>
              <button className="btn sm" onClick={() => setSheet({ kind: "visit", customer: c })}>{tt("زيارة", "Visit")}</button>
              {c.phone && <a className="btn sm" href={`tel:${c.phone}`}>☎</a>}
              {c.lat && <a className="btn sm" target="_blank" rel="noreferrer" href={`https://www.google.com/maps/dir/?api=1&destination=${c.lat},${c.lng}`}>⌖</a>}
            </div>
          </div>))}
      </div>
      <div className="card"><b>{tt("بضاعة السيارة", "Van stock")}</b>
        {d.van.map((v: any) => <div key={v.id} className="row" style={{ marginTop: 6 }}><span>{v.code} {v.name_ar}</span><span className="spacer" /><b className="num">{fmt(v.qty, 0)} {v.uom}</b></div>)}</div>
      <div className="row"><button className="btn" onClick={() => setExtra("handover")}>{tt("تسليم العهدة النقدية", "Hand over cash")}</button>
        <button className="btn" onClick={() => setExtra("settle")}>{tt("تسوية آخر اليوم", "End-of-day count")}</button></div>
      {sheet && <OpSheet kind={sheet.kind} customer={sheet.customer} van={d.van} maxDiscount={Number(d.rep.maxDiscountPct)} onClose={() => setSheet(null)} onSave={enqueue} />}
      {extra && <ExtraSheet kind={extra} van={d.van} custody={d.custody} onClose={() => { setExtra(null); day.reload(); }} />}
    </div>
  );
}

function OpSheet({ kind, customer, van, maxDiscount, onClose, onSave }: { kind: "invoice" | "receipt" | "visit"; customer: any; van: any[]; maxDiscount: number; onClose: () => void; onSave: (op: any) => void }) {
  const { t, tt } = useI18n();
  const [pay, setPay] = useState("cash");
  const [lines, setLines] = useState<Record<string, { qty: string; uomId: string; disc: string }>>({});
  const [amount, setAmount] = useState("");
  const [outcome, setOutcome] = useState("no_order");
  const [notes, setNotes] = useState("");
  const total = van.reduce((s, v) => { const l = lines[v.id]; if (!l?.qty) return s; const f = l.uomId ? Number(v.units.find((u: any) => u.uomId === l.uomId)?.factor ?? 1) : 1;
    return s + Number(l.qty) * f * Number(v.sales_price ?? 0) * (1 - Number(l.disc || 0) / 100); }, 0);
  const save = () => {
    if (kind === "invoice") {
      const ls = van.filter((v) => Number(lines[v.id]?.qty) > 0).map((v) => ({ itemId: v.id, qty: lines[v.id].qty, ...(lines[v.id].uomId ? { uomId: lines[v.id].uomId } : {}), ...(lines[v.id].disc ? { discountPct: lines[v.id].disc } : {}) }));
      if (!ls.length) return;
      onSave({ type: "invoice", label: `${tt("فاتورة", "Invoice")} ${customer.name_ar}`, payload: { customerId: customer.id, paymentType: pay, invoiceDate: today(), lines: ls } });
    } else if (kind === "receipt") {
      if (!(Number(amount) > 0)) return;
      onSave({ type: "receipt", label: `${tt("تحصيل", "Collection")} ${customer.name_ar}`, payload: { customerId: customer.id, amount, paymentDate: today() } });
    } else {
      const go = (pos?: GeolocationPosition) => onSave({ type: "visit", label: `${tt("زيارة", "Visit")} ${customer.name_ar}`, payload: { customerId: customer.id, outcome, visitedAt: new Date().toISOString(), notes: notes || undefined,
        ...(pos ? { lat: Number(pos.coords.latitude.toFixed(6)), lng: Number(pos.coords.longitude.toFixed(6)) } : {}) } });
      if (navigator.geolocation) navigator.geolocation.getCurrentPosition(go, () => go(), { timeout: 5000, maximumAge: 60000 }); else go();
    }
  };
  return (
    <Modal title={`${customer.name_ar}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>{t.cancel}</button><button className="btn primary" onClick={save}>{t.save}</button></>}>
      {kind === "invoice" && <div className="grid">
        <div className="row"><button className={`btn sm ${pay === "cash" ? "primary" : ""}`} onClick={() => setPay("cash")}>{tt("نقدي", "Cash")}</button>
          <button className={`btn sm ${pay === "credit" ? "primary" : ""}`} onClick={() => setPay("credit")}>{tt("آجل", "Credit")}</button>
          <span className="spacer" /><span style={{ color: "var(--muted)", fontSize: 12 }}>{tt("الخصم الأقصى", "Max discount")} {maxDiscount}%</span></div>
        {van.map((v) => <div key={v.id} className="row">
          <span style={{ flex: 1 }}>{v.name_ar}<br /><small className="num" style={{ color: "var(--muted)" }}>{fmt(v.sales_price)} · {tt("متاح", "avail.")} {fmt(v.qty, 0)}</small></span>
          <select value={lines[v.id]?.uomId ?? ""} onChange={(e) => setLines({ ...lines, [v.id]: { qty: lines[v.id]?.qty ?? "", disc: lines[v.id]?.disc ?? "", uomId: e.target.value } })} style={{ width: 90 }}>
            <option value="">{v.uom}</option>{v.units.map((u: any) => <option key={u.uomId} value={u.uomId}>{u.code}</option>)}</select>
          <input className="num" inputMode="decimal" placeholder="0" value={lines[v.id]?.qty ?? ""} onChange={(e) => setLines({ ...lines, [v.id]: { uomId: lines[v.id]?.uomId ?? "", disc: lines[v.id]?.disc ?? "", qty: e.target.value } })} style={{ width: 70 }} />
          {maxDiscount > 0 && <input className="num" inputMode="decimal" placeholder="%" value={lines[v.id]?.disc ?? ""} onChange={(e) => setLines({ ...lines, [v.id]: { uomId: lines[v.id]?.uomId ?? "", qty: lines[v.id]?.qty ?? "", disc: e.target.value } })} style={{ width: 55 }} />}
        </div>)}
        <div className="balance-bar"><span>{tt("الإجمالي التقريبي", "Approx. total")}</span><b className="num">{fmt(total)}</b></div>
        <small style={{ color: "var(--muted)" }}>{tt("الأسعار من قائمة الأسعار المعتمدة ولا يمكن تعديلها من الميدان. الرقم النهائي يصدر من الخادم.", "Prices come from the approved price list and cannot be edited in the field. The final number comes from the server.")}</small>
      </div>}
      {kind === "receipt" && <div className="grid"><p>{tt("الرصيد المستحق", "Balance due")}: <b className="num">{fmt(customer.balance)}</b></p>
        <Field label={t.amount}><input className="num" inputMode="decimal" autoFocus value={amount} onChange={(e) => setAmount(e.target.value)} /></Field></div>}
      {kind === "visit" && <div className="grid">
        <Field label={tt("نتيجة الزيارة", "Outcome")}><select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
          {[["no_order", tt("لا طلب", "No order")], ["closed", tt("مغلق", "Closed")], ["refused", tt("رفض", "Refused")], ["sale", tt("بيع", "Sale")], ["collection", tt("تحصيل", "Collection")], ["other", tt("أخرى", "Other")]].map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <Field label={t.memo}><input value={notes} onChange={(e) => setNotes(e.target.value)} /></Field></div>}
    </Modal>
  );
}

function ExtraSheet({ kind, van, custody, onClose }: { kind: "handover" | "settle"; van: any[]; custody: string; onClose: () => void }) {
  const { t, tt, lang } = useI18n();
  const { toast } = useToast();
  const [amount, setAmount] = useState(custody);
  const [counts, setCounts] = useState<Record<string, string>>(() => Object.fromEntries(van.map((v) => [v.id, String(Number(v.qty))])));
  const save = async () => {
    try {
      if (kind === "handover") await api.post("/field/handovers", { amount, handoverDate: today() });
      else await api.post("/field/settlements", { settlementDate: today(), counts: van.map((v) => ({ itemId: v.id, countedQty: counts[v.id] || "0" })) });
      toast(tt("أُرسل للاعتماد", "Sent for approval")); onClose();
    } catch (e) { toast(errMsg(e, lang), true); }
  };
  return <Modal title={kind === "handover" ? tt("تسليم العهدة النقدية", "Cash handover") : tt("تسوية آخر اليوم — جرد السيارة", "End-of-day van count")} onClose={onClose}
    footer={<><button className="btn" onClick={onClose}>{t.cancel}</button><button className="btn primary" onClick={save}>{tt("إرسال", "Submit")}</button></>}>
    {kind === "handover" ? <div className="grid"><p>{tt("العهدة الحالية", "Current custody")}: <b className="num">{fmt(custody)}</b></p>
      <Field label={tt("المبلغ المسلّم", "Amount handed over")}><input className="num" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
      <small style={{ color: "var(--muted)" }}>{tt("يعدّ أمين الصندوق المبلغ ويؤكده؛ أي عجز يُسجّل على المندوب.", "The cashier counts and confirms; any shortage is charged to the rep.")}</small></div>
      : <div className="grid">{van.map((v) => <div key={v.id} className="row"><span style={{ flex: 1 }}>{v.name_ar}</span><small className="num" style={{ color: "var(--muted)" }}>{tt("الدفتري", "Book")} {fmt(v.qty, 0)}</small>
        <input className="num" value={counts[v.id]} onChange={(e) => setCounts({ ...counts, [v.id]: e.target.value })} style={{ width: 90 }} /></div>)}
        <small style={{ color: "var(--muted)" }}>{tt("أدخل العدد الفعلي. يعتمد المشرف التسوية، والعجز يُحمّل على المندوب.", "Enter the physical count. A supervisor approves; shortages are charged to the rep.")}</small></div>}
  </Modal>;
}
