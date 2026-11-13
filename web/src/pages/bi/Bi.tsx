import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { API_BASE, api, fmt, getSession } from "../../api";
import { useI18n } from "../../i18n";
import { useSession } from "../../session";
import { Empty, ErrorBox, Field, Loading, Modal, errMsg, useAsync, useToast } from "../../ui";
import { LinesTable, today } from "../erp/shared";

type Kpi = { key: string; ar: string; en: string; value: any; previous?: any; format: "money" | "number" | "pct" | "days"; drill?: string; better?: "up" | "down" };
const fmtKpi = (v: any, f: Kpi["format"]) => (v === null || v === undefined ? "—" : f === "pct" ? `${Number(v).toFixed(1)}%` : f === "money" ? fmt(v) : f === "days" ? `${v}` : Number(v).toLocaleString("en-US"));

export function BiDashboards() {
  const { t, tt, lang, pick } = useI18n();
  const { can, companyId } = useSession();
  const { toast } = useToast();
  const areas = useAsync(() => api.get("/bi/dashboards"), []);
  const [area, setArea] = useState<string>("");
  const [from, setFrom] = useState(`${today().slice(0, 7)}-01`);
  const [to, setTo] = useState(today());
  const [compare, setCompare] = useState("previous_period");
  const [branchId, setBranchId] = useState("");
  const [warehouseId, setWarehouseId] = useState("");
  const [alerts, setAlerts] = useState(false);
  const branches = useAsync(() => api.get("/branches"), []);
  const whs = useAsync(() => api.get("/warehouses"), []);
  const current = area || areas.data?.[0] || "";
  const qs = `companyId=${companyId}&from=${from}&to=${to}&compare=${compare}${branchId ? `&branchId=${branchId}` : ""}${warehouseId ? `&warehouseId=${warehouseId}` : ""}`;
  const d = useAsync(() => (current ? api.get(`/bi/dashboards/${current}?${qs}`) : Promise.resolve(null)), [current, qs]);
  const triggered = useAsync(() => api.get(`/bi/alerts?companyId=${companyId}`), [companyId]);
  const name = (a: string) => ({ executive: tt("التنفيذية", "Executive"), financial: tt("المالية", "Financial"), sales: tt("المبيعات", "Sales"), inventory: tt("المخزون", "Inventory"),
    manufacturing: tt("التصنيع", "Manufacturing"), procurement: tt("المشتريات", "Procurement"), hr: tt("الموارد البشرية", "HR"), distribution: tt("التوزيع", "Distribution"), quality: tt("الجودة", "Quality") }[a] ?? a);
  const exportAs = async (format: "xlsx" | "csv") => {
    const r = await fetch(`${API_BASE}/api/v1/bi/dashboards/${current}/export?${qs}&format=${format}&lang=${lang}`, { headers: { authorization: `Bearer ${getSession("tenant")?.accessToken}` } });
    if (!r.ok) return toast(tt("تعذر التصدير", "Export failed"), true);
    const a = document.createElement("a"); a.href = URL.createObjectURL(await r.blob()); a.download = `golden-erp-${current}-${from}_${to}.${format}`; a.click(); URL.revokeObjectURL(a.href);
  };
  const on = (triggered.data ?? []).filter((a: any) => a.triggered);
  return <div className="bi-root">
    <div className="page-head"><h1>{tt("التقارير وذكاء الأعمال", "BI & reporting")}</h1><div className="row no-print">
      <button className="btn" onClick={() => exportAs("xlsx")} disabled={!current}>⬇ Excel</button>
      <button className="btn" onClick={() => exportAs("csv")} disabled={!current}>⬇ CSV</button>
      <button className="btn" onClick={() => window.print()} disabled={!current}>🖨 {tt("طباعة / PDF", "Print / PDF")}</button>
      <button className="btn" onClick={() => setAlerts(true)}>🔔 {tt("التنبيهات", "Alerts")}{on.length ? <span className="badge bad" style={{ marginInlineStart: 4 }}>{on.length}</span> : null}</button></div></div>
    <ErrorBox error={areas.error} />
    {areas.data && !areas.data.length && <div className="card"><Empty text={tt("لا توجد لوحات متاحة لصلاحياتك أو باقتك", "No dashboards available for your permissions or plan")} /></div>}
    {/* one filter row above all charts */}
    <div className="row no-print" style={{ flexWrap: "wrap", marginBottom: 12 }}>
      {(areas.data ?? []).map((a: string) => <button key={a} className={`btn ${current === a ? "primary" : ""}`} onClick={() => setArea(a)}>{name(a)}</button>)}
    </div>
    <div className="row no-print" style={{ flexWrap: "wrap", marginBottom: 16 }}>
      <Field label={t.from}><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
      <Field label={t.to}><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      <Field label={tt("المقارنة مع", "Compare with")}><select value={compare} onChange={(e) => setCompare(e.target.value)}>
        <option value="previous_period">{tt("الفترة السابقة", "Previous period")}</option><option value="previous_year">{tt("نفس الفترة من العام السابق", "Same period last year")}</option></select></Field>
      <Field label={t.branch}><select value={branchId} onChange={(e) => setBranchId(e.target.value)}><option value="">{tt("كل الفروع", "All branches")}</option>
        {(branches.data ?? []).map((b: any) => <option key={b.id} value={b.id}>{b.code} · {b.name_ar}</option>)}</select></Field>
      <Field label={t.warehouse}><select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}><option value="">{tt("كل المخازن", "All warehouses")}</option>
        {(whs.data ?? []).filter((w: any) => !branchId || w.branch_id === branchId).map((w: any) => <option key={w.id} value={w.id}>{w.code} · {w.name_ar}</option>)}</select></Field>
    </div>
    <ErrorBox error={d.error} />
    {d.loading ? <Loading /> : d.data && <>
      <p style={{ color: "var(--muted)", fontSize: 12 }}>{name(current)} · {d.data.filters.from} → {d.data.filters.to} · {tt("مقارنة", "vs")} {d.data.filters.prevFrom} → {d.data.filters.prevTo}
        {" · "}{tt("المرشحات المطبقة", "Filters applied")}: {d.data.filters.applied.join(", ")}</p>
      <div className="grid kpis">{d.data.kpis.map((k: Kpi) => <KpiTile key={k.key} k={k} />)}</div>
      {d.data.series.map((s: any) => <BarChart key={s.key} title={pick(s.ar, s.en)} points={s.points} />)}
      {d.data.tables.map((tb: any) => <div key={tb.key} style={{ marginTop: 16 }}><h3>{pick(tb.ar, tb.en)}</h3>
        {tb.rows.length ? <LinesTable rows={tb.rows} cols={tb.columns.map((c: any) => ({ h: pick(c.ar, c.en), end: !!c.format, v: (r: any) => c.format ? fmtKpi(r[c.key], c.format) : (c.key === "channel" ? ({ pos: tt("نقاط البيع", "POS"), field: tt("المناديب", "Field reps"), office: tt("المكتب", "Office") } as any)[r[c.key]] ?? r[c.key] : r[c.key] ?? "—") }))} /> : <Empty />}</div>)}
    </>}
    {alerts && <Alerts areas={areas.data ?? []} name={name} rules={triggered} onClose={() => { setAlerts(false); triggered.reload(); }} canManage={can("bi.alerts.manage")} />}
  </div>;
}

/** stat tile: the number is the headline; the comparison is text + arrow, never color alone */
function KpiTile({ k }: { k: Kpi }) {
  const { tt, pick } = useI18n();
  const hasPrev = k.previous !== undefined && k.previous !== null && k.value !== null;
  const change = hasPrev && Number(k.previous) !== 0 ? ((Number(k.value) - Number(k.previous)) / Math.abs(Number(k.previous))) * 100 : null;
  const flat = change !== null && Math.abs(change) < 0.05;
  const good = change === null || flat || !k.better ? null : (change > 0) === (k.better === "up");
  const body = <div className="card kpi" style={{ height: "100%" }}>
    <div className="label">{pick(k.ar, k.en)}</div>
    <div className="value num">{fmtKpi(k.value, k.format)}</div>
    {hasPrev && <div className="num" style={{ fontSize: 12, marginTop: 4, color: "var(--muted)" }}>
      {change === null ? `${tt("السابق", "Previous")} ${fmtKpi(k.previous, k.format)}`
        : flat ? <>= {tt("بدون تغيير", "no change")} · {tt("السابق", "prev.")} {fmtKpi(k.previous, k.format)}</>
        : <><span style={{ color: good === null ? "var(--muted)" : good ? "var(--ok)" : "var(--bad)", fontWeight: 600 }}>{change > 0 ? "▲" : "▼"} {Math.abs(change) >= 1000 ? `${Math.round(change / 100)}×` : `${Math.abs(change).toFixed(1)}%`}</span>
          {" "}{good === null ? "" : good ? tt("أفضل", "better") : tt("أسوأ", "worse")} · {tt("السابق", "prev.")} {fmtKpi(k.previous, k.format)}</>}
    </div>}
  </div>;
  return k.drill ? <Link to={k.drill} title={tt("عرض المستندات", "Show documents")} style={{ color: "inherit", textDecoration: "none" }}>{body}</Link> : body;
}

/** single-series column chart: one hue, thin columns with rounded data-ends, recessive axis, hover tooltip, table view */
function BarChart({ title, points }: { title: string; points: { period: string; value: string }[] }) {
  const { tt } = useI18n();
  const [hover, setHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  // draw at the real container width so text stays 11px on phones (no scaled-down image)
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(640);
  useEffect(() => {
    const el = box.current; if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.round(e.contentRect.width))));
    ro.observe(el); return () => ro.disconnect();
  }, [asTable]);
  const vals = points.map((p) => Number(p.value));
  const max = Math.max(...vals, 0);
  const min = Math.min(...vals, 0);
  const H = 220, padL = 48, padB = 28, padT = 12;
  const plotH = H - padB - padT, plotW = W - padL - 8;
  const band = plotW / Math.max(points.length, 1);
  const barW = Math.min(24, band * 0.6);
  const range = max - min || 1;
  const y = (v: number) => padT + ((max - v) / range) * plotH;
  const ticks = useMemo(() => [max, (max + min) / 2, min].filter((v, i, a) => a.indexOf(v) === i), [max, min]);
  if (!points.length) return null;
  return <div className="card viz" style={{ marginTop: 16 }}>
    <div className="row" style={{ justifyContent: "space-between" }}><h3 style={{ margin: 0 }}>{title}</h3>
      <button className="btn no-print" onClick={() => setAsTable(!asTable)}>{asTable ? tt("رسم بياني", "Chart") : tt("جدول", "Table")}</button></div>
    {asTable ? <LinesTable rows={points} cols={[{ h: tt("الشهر", "Month"), v: (p) => p.period }, { h: tt("القيمة", "Value"), v: (p) => fmt(p.value), end: true }]} /> :
      <div ref={box} style={{ position: "relative", direction: "ltr" }}>
        <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={title} onMouseLeave={() => setHover(null)}>
          {ticks.map((tv) => <g key={tv}><line x1={padL} x2={W - 8} y1={y(tv)} y2={y(tv)} stroke="var(--line)" strokeWidth={1} />
            <text x={padL - 6} y={y(tv) + 4} textAnchor="end" fontSize={11} fill="var(--muted)">{fmt(tv, 0)}</text></g>)}
          {points.map((p, i) => {
            const v = Number(p.value), x = padL + band * i + (band - barW) / 2;
            const top = y(Math.max(v, 0)), h = Math.max(Math.abs(y(v) - y(0)), v === 0 ? 0 : 1);
            const r = Math.min(4, h, barW / 2);
            // rounded data-end, square at the baseline (negative values grow downwards)
            const path = v >= 0
              ? `M${x},${top + h} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${top + h} Z`
              : `M${x},${y(0)} V${y(0) + h - r} Q${x},${y(0) + h} ${x + r},${y(0) + h} H${x + barW - r} Q${x + barW},${y(0) + h} ${x + barW},${y(0) + h - r} V${y(0)} Z`;
            return <g key={p.period} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} tabIndex={0}>
              <rect x={padL + band * i} y={padT} width={band} height={plotH} fill="transparent" />
              <path d={path} fill="var(--series-1)" opacity={hover === null || hover === i ? 1 : 0.55} />
              {(points.length <= 12 || i % Math.ceil(points.length / 12) === 0) && <text x={x + barW / 2} y={H - 8} textAnchor="middle" fontSize={11} fill="var(--muted)">{p.period.slice(2)}</text>}
            </g>;
          })}
          <line x1={padL} x2={W - 8} y1={y(0)} y2={y(0)} stroke="var(--muted)" strokeWidth={1} />
        </svg>
        {hover !== null && <div className="viz-tip" style={{ left: `${((padL + band * hover + band / 2) / W) * 100}%`, top: `${(y(Math.max(Number(points[hover].value), 0)) / H) * 100}%` }}>
          <div style={{ color: "var(--muted)", fontSize: 11 }}>{points[hover].period}</div><b className="num">{fmt(points[hover].value)}</b></div>}
      </div>}
  </div>;
}

const KPI_KEYS: Record<string, string[]> = {
  executive: ["net_sales", "gross_margin_pct", "net_profit", "cash", "ar", "ap", "stock_value", "expired_lots", "production_cost", "scrap_pct", "open_ncr", "open_recalls", "overdue_ar"],
  financial: ["revenue", "expenses", "net_profit", "gross_margin_pct", "cash", "ar", "ap", "inventory_gl"],
  sales: ["net_sales", "invoices", "avg_invoice", "gross_margin_pct", "returns", "discounts", "active_customers", "overdue_ar"],
  inventory: ["stock_value", "quarantine_value", "items_in_stock", "below_reorder", "expiring_lots", "expired_lots", "days_of_cover"],
  manufacturing: ["orders_completed", "production_cost", "cost_variance", "scrap_pct", "open_orders"],
  procurement: ["received", "receipts", "invoiced", "ap_open", "ap_overdue", "uninvoiced"],
  hr: ["headcount", "hires", "exits", "leave_days", "payroll_cost", "loans_outstanding"],
  distribution: ["field_sales", "collections", "visits", "productive_visits_pct", "cash_custody", "van_shortages"],
  quality: ["checks", "pass_rate", "ncr_opened", "open_ncr", "open_recalls", "lots_on_hold"],
};

function Alerts({ areas, name, rules, onClose, canManage }: { areas: string[]; name: (a: string) => string; rules: any; onClose: () => void; canManage: boolean }) {
  const { t, tt, lang, pick } = useI18n();
  const { companyId } = useSession();
  const { toast } = useToast();
  const [f, setF] = useState({ nameAr: "", area: areas[0] ?? "sales", metric: "", operator: "gt", threshold: "", recipient: "" });
  const save = async () => {
    try { await api.post("/bi/alert-rules", { companyId, ...f, metric: f.metric || KPI_KEYS[f.area][0], recipient: f.recipient || undefined }); toast(t.savedOk); rules.reload(); }
    catch (e) { toast(errMsg(e, lang), true); }
  };
  const notify = async () => {
    try { const r = await api.post("/bi/alerts/notify", { companyId }); toast(`${tt("تنبيهات مُرسلة إلى الطابور", "Queued notifications")}: ${r.queued}`); } catch (e) { toast(errMsg(e, lang), true); }
  };
  return <Modal title={tt("تنبيهات تجاوز الحدود (منذ بداية الشهر)", "Threshold alerts (month to date)")} onClose={onClose} footer={<><button className="btn" onClick={onClose}>{t.close}</button>
    {canManage && <><button className="btn" onClick={notify}>{tt("إرسال المتحقق", "Send triggered")}</button><button className="btn primary" onClick={save}>{t.add}</button></>}</>}>
    {rules.loading ? <Loading /> : !rules.data?.length ? <Empty /> : <LinesTable rows={rules.data} cols={[
      { h: t.name, v: (a) => a.name_ar }, { h: tt("اللوحة", "Dashboard"), v: (a) => name(a.area) }, { h: tt("المؤشر", "Indicator"), v: (a) => a.label ? pick(a.label.ar, a.label.en) : a.metric },
      { h: tt("الشرط", "Condition"), v: (a) => `${a.operator === "gt" ? ">" : "<"} ${Number(a.threshold)}` }, { h: tt("القيمة الحالية", "Current"), v: (a) => a.value ?? "—", end: true },
      { h: t.status, v: (a) => a.triggered ? <span className="badge bad">⚠ {tt("متحقق", "Triggered")}</span> : <span className="badge ok">✓ {tt("ضمن الحد", "Within limit")}</span> }]} />}
    {canManage && <div className="form-grid" style={{ marginTop: 12 }}>
      <Field label={t.name}><input value={f.nameAr} onChange={(e) => setF({ ...f, nameAr: e.target.value })} /></Field>
      <Field label={tt("اللوحة", "Dashboard")}><select value={f.area} onChange={(e) => setF({ ...f, area: e.target.value, metric: "" })}>{areas.map((a) => <option key={a} value={a}>{name(a)}</option>)}</select></Field>
      <Field label={tt("المؤشر", "Indicator")}><select value={f.metric || KPI_KEYS[f.area]?.[0]} onChange={(e) => setF({ ...f, metric: e.target.value })}>{(KPI_KEYS[f.area] ?? []).map((k) => <option key={k} value={k}>{k}</option>)}</select></Field>
      <Field label={tt("الشرط", "Condition")}><select value={f.operator} onChange={(e) => setF({ ...f, operator: e.target.value })}><option value="gt">{tt("أكبر من", "Above")}</option><option value="lt">{tt("أقل من", "Below")}</option></select></Field>
      <Field label={tt("الحد", "Threshold")}><input className="num" value={f.threshold} onChange={(e) => setF({ ...f, threshold: e.target.value })} /></Field>
      <Field label={tt("يُرسل إلى (بريد/واتساب)", "Send to (e-mail/WhatsApp)")}><input value={f.recipient} onChange={(e) => setF({ ...f, recipient: e.target.value })} /></Field>
    </div>}
  </Modal>;
}
