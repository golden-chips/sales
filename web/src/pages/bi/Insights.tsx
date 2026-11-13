import { useState } from "react";
import { api, fmt, fmtDateTime } from "../../api";
import { useI18n } from "../../i18n";
import { useSession } from "../../session";
import { Empty, ErrorBox, Loading, useAsync } from "../../ui";
import { LinesTable, today } from "../erp/shared";

/** advisory analytics: every result states its method; nothing here changes data */
export function Insights() {
  const { tt, pick } = useI18n();
  const { companyId } = useSession();
  const kinds = useAsync(() => api.get("/bi/insights"), []);
  const [kind, setKind] = useState("");
  const [asOf, setAsOf] = useState(today());
  const current = kind || kinds.data?.[0] || "";
  // tag the result with its kind: while a new tab loads, the previous result must never be drawn with the new tab's columns
  const d = useAsync(() => (current ? api.get(`/bi/insights/${current}?companyId=${companyId}&asOf=${asOf}`).then((r: any) => ({ ...r, kind: current })) : Promise.resolve(null)), [current, asOf, companyId]);
  const name = (k: string) => ({ "slow-stock": tt("المخزون الراكد", "Slow stock"), "demand-forecast": tt("التنبؤ بالطلب", "Demand forecast"), "purchase-suggestions": tt("اقتراحات الشراء", "Purchase suggestions"),
    "lapsed-customers": tt("عملاء انقطعوا", "Lapsed customers"), "production-cost": tt("انحراف تكلفة الإنتاج", "Production cost drift"), anomalies: tt("قيود ومدفوعات للمراجعة", "Entries to review") } as any)[k] ?? k;
  const conf = (c: string) => <span className={`badge ${c === "high" ? "ok" : c === "medium" ? "warn" : "bad"}`}>{({ high: tt("ثقة عالية", "High"), medium: tt("ثقة متوسطة", "Medium"), low: tt("ثقة منخفضة", "Low") } as any)[c]}</span>;
  return <>
    <div className="page-head"><h1>{tt("التحليلات الذكية", "Smart insights")}</h1><div className="row">
      <label className="row">{tt("حتى تاريخ", "As of")} <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} style={{ width: "auto" }} /></label></div></div>
    <div className="alert info">{tt("هذه تحليلات استشارية مبنية على بياناتكم المرحّلة بطرق إحصائية واضحة. لا تُنشئ أو تُرحّل أو تدفع أي شيء — القرار دائمًا لشخص مخوّل.",
      "Advisory analytics from your posted data using transparent statistics. They never create, post or pay anything — an authorised person always decides.")}</div>
    <ErrorBox error={kinds.error} />
    {kinds.data && !kinds.data.length && <div className="card"><Empty text={tt("لا توجد تحليلات متاحة لصلاحياتك أو باقتك", "No insights available for your permissions or plan")} /></div>}
    <div className="row" style={{ flexWrap: "wrap", marginBottom: 12 }}>{(kinds.data ?? []).map((k: string) => <button key={k} className={`btn ${current === k ? "primary" : ""}`} onClick={() => setKind(k)}>{name(k)}</button>)}</div>
    <ErrorBox error={d.error} />
    {d.loading || (d.data && d.data.kind !== current) ? <Loading /> : d.data && <>
      <p style={{ color: "var(--muted)" }}>ⓘ {pick(d.data.method.ar, d.data.method.en)}</p>
      {current === "slow-stock" && <>{<div className="grid kpis"><div className="card kpi"><div className="label">{tt("قيمة المخزون الراكد", "Slow stock value")}</div><div className="value num">{fmt(d.data.totalValue)}</div></div></div>}
        {d.data.items.length ? <LinesTable rows={d.data.items} cols={[{ h: tt("الصنف", "Item"), v: (x) => `${x.code} · ${x.name_ar}` }, { h: tt("الكمية", "Qty"), v: (x) => Number(x.qty), end: true },
          { h: tt("القيمة", "Value"), v: (x) => fmt(x.value), end: true }, { h: tt("آخر استهلاك", "Last consumed"), v: (x) => x.last_consumed ?? tt("لم يُستهلك", "never") },
          { h: tt("أيام الركود", "Idle days"), v: (x) => x.idle_days ?? "—", end: true }]} /> : <Empty />}</>}
      {current === "demand-forecast" && (d.data.items.length ? <LinesTable rows={d.data.items} cols={[{ h: tt("الصنف", "Item"), v: (x) => `${x.code} · ${x.name_ar}` },
        { h: tt("آخر 6 أشهر", "Last 6 months"), v: (x) => <span className="num" style={{ fontSize: 12 }}>{x.history.map((h: any) => h.qty).join(" · ")}</span> },
        { h: tt("المتوقع الشهر القادم", "Next month forecast"), v: (x) => <b className="num">{x.forecast_next_month}</b>, end: true }, { h: tt("الثقة", "Confidence"), v: (x) => conf(x.confidence) },
        { h: tt("الرصيد", "On hand"), v: (x) => x.on_hand, end: true }, { h: tt("إنتاج مقترح", "Suggested production"), v: (x) => <b className="num">{x.suggested_production}</b>, end: true }]} /> : <Empty />)}
      {current === "purchase-suggestions" && (d.data.items.length ? <LinesTable rows={d.data.items} cols={[{ h: tt("المادة", "Material"), v: (x) => `${x.code} · ${x.name_ar}` },
        { h: tt("استهلاك يومي", "Daily use"), v: (x) => `${Number(x.daily_use)} ${x.uom}`, end: true }, { h: tt("الرصيد", "On hand"), v: (x) => Number(x.on_hand), end: true },
        { h: tt("يكفي (يوم)", "Cover (days)"), v: (x) => <span className={Number(x.days_of_cover) < 14 ? "badge bad" : ""}>{x.days_of_cover ?? "—"}</span>, end: true },
        { h: tt("كمية مقترحة", "Suggested qty"), v: (x) => <b className="num">{x.suggested_qty}</b>, end: true }]} /> : <Empty text={tt("لا توجد مواد تحتاج طلبًا الآن", "No material needs ordering now")} />)}
      {current === "lapsed-customers" && (d.data.items.length ? <LinesTable rows={d.data.items} cols={[{ h: tt("العميل", "Customer"), v: (x) => `${x.code} · ${x.name_ar}` },
        { h: tt("الهاتف", "Phone"), v: (x) => <span className="num">{x.phone ?? "—"}</span> }, { h: tt("فواتير سابقة", "Earlier invoices"), v: (x) => x.invoices_before, end: true },
        { h: tt("قيمتها", "Their value"), v: (x) => fmt(x.value_before), end: true }, { h: tt("آخر فاتورة", "Last invoice"), v: (x) => `${x.last_invoice} (${x.days_since} ${tt("يوم", "days")})` }]} /> : <Empty />)}
      {current === "production-cost" && (d.data.items.length ? <LinesTable rows={d.data.items} cols={[{ h: tt("الأمر", "Order"), v: (x) => x.number }, { h: tt("الصنف", "Item"), v: (x) => `${x.code} · ${x.name_ar}` },
        { h: tt("الفعلية", "Actual"), v: (x) => fmt(x.actual_unit_cost), end: true }, { h: tt("المعيارية", "Standard"), v: (x) => fmt(x.std_unit_cost), end: true },
        { h: tt("الانحراف", "Drift"), v: (x) => <b className="num">{Number(x.drift_pct) > 0 ? "▲" : "▼"} {Math.abs(Number(x.drift_pct))}%</b>, end: true }, { h: tt("الهالك", "Scrap"), v: (x) => x.scrap_pct === null ? "—" : `${x.scrap_pct}%`, end: true }]} /> : <Empty />)}
      {current === "anomalies" && <>
        <h3>{tt("قيود يدوية أكبر بكثير من المعتاد", "Manual entries far above usual")}</h3>
        {d.data.unusual_size.length ? <LinesTable rows={d.data.unusual_size} cols={[{ h: tt("القيد", "Entry"), v: (x) => x.number }, { h: tt("التاريخ", "Date"), v: (x) => x.date }, { h: tt("الحساب", "Account"), v: (x) => x.account },
          { h: tt("المبلغ", "Amount"), v: (x) => fmt(x.amount), end: true }, { h: tt("كم ضعف الانحراف", "Std devs"), v: (x) => x.z, end: true }, { h: tt("البيان", "Memo"), v: (x) => x.memo }]} /> : <Empty />}
        <h3>{tt("قيود رُحّلت يوم العطلة أو ليلًا", "Posted on the day off or at night")}</h3>
        {d.data.off_hours.length ? <LinesTable rows={d.data.off_hours} cols={[{ h: tt("القيد", "Entry"), v: (x) => x.number }, { h: tt("وقت الترحيل", "Posted at"), v: (x) => fmtDateTime(x.posted_at) }, { h: tt("بواسطة", "By"), v: (x) => x.posted_by }, { h: tt("البيان", "Memo"), v: (x) => x.memo }]} /> : <Empty />}
        <h3>{tt("مبالغ كبيرة مقرّبة", "Large round amounts")}</h3>
        {d.data.round_amounts.length ? <LinesTable rows={d.data.round_amounts} cols={[{ h: tt("القيد", "Entry"), v: (x) => x.number }, { h: tt("التاريخ", "Date"), v: (x) => x.date }, { h: tt("المبلغ", "Amount"), v: (x) => fmt(x.amount), end: true }, { h: tt("البيان", "Memo"), v: (x) => x.memo }]} /> : <Empty />}
        <h3>{tt("دفعات متطابقة لنفس الطرف في نفس اليوم", "Identical payments, same party and day")}</h3>
        {d.data.duplicate_payments.length ? <LinesTable rows={d.data.duplicate_payments} cols={[{ h: tt("الطرف", "Party"), v: (x) => `${x.party} · ${x.name_ar}` }, { h: tt("التاريخ", "Date"), v: (x) => x.date },
          { h: tt("المبلغ", "Amount"), v: (x) => fmt(x.amount), end: true }, { h: tt("المرات", "Times"), v: (x) => x.times, end: true }, { h: tt("الأرقام", "Numbers"), v: (x) => x.numbers }]} /> : <Empty />}
      </>}
    </>}
  </>;
}
