import { useMemo, useRef, useState } from "react";
import { api, fmt, fmtDateTime } from "../../api";
import { useI18n } from "../../i18n";
import { useSession } from "../../session";
import { Empty, ErrorBox, Field, Loading, Modal, StatusBadge, errMsg, useAsync, useToast } from "../../ui";
import { LinesTable, today } from "../erp/shared";

type CartLine = { key: string; itemId: string; uomId: string | null; label: string; unitPrice: number; factor: number; qty: number; discountPct: number };
const uuid = () => (crypto as any).randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;

// ================================================================== counter
export function PosCounter() {
  const { tt, lang } = useI18n();
  const { companyId } = useSession();
  const { toast } = useToast();
  const current = useAsync(() => api.get("/pos/shifts/current"), []);
  const registers = useAsync(() => api.get(`/pos/registers?companyId=${companyId}`), [companyId]);
  const [reg, setReg] = useState("");
  const [float, setFloat] = useState("0");
  if (current.loading) return <Loading />;
  if (!current.data) {
    const free = (registers.data ?? []).filter((r: any) => r.is_active && !r.open_shift_id);
    const open = async () => {
      try { await api.post("/pos/shifts", { registerId: reg, openingFloat: float || "0", businessDate: today() }); current.reload(); } catch (e) { toast(errMsg(e, lang), true); }
    };
    return <>
      <div className="page-head"><h1>{tt("نقطة البيع", "Point of sale")}</h1></div>
      <ErrorBox error={registers.error} />
      <div className="card" style={{ maxWidth: 480 }}>
        <h3>{tt("فتح وردية", "Open a shift")}</h3>
        {!free.length && <div className="alert warn">{tt("لا توجد نقطة بيع متاحة (كلها مفتوحة أو لم تُعرّف بعد).", "No free register (all open or none configured).")}</div>}
        <Field label={tt("نقطة البيع", "Register")}><select value={reg} onChange={(e) => setReg(e.target.value)}><option value="">…</option>
          {free.map((r: any) => <option key={r.id} value={r.id}>{r.code} · {r.name_ar}</option>)}</select></Field>
        <Field label={tt("عهدة الافتتاح (نقدية الدرج)", "Opening float")}><input className="num" value={float} onChange={(e) => setFloat(e.target.value)} /></Field>
        <button className="btn primary" disabled={!reg} onClick={open}>{tt("فتح الوردية", "Open shift")}</button>
      </div>
    </>;
  }
  return <Counter report={current.data} reload={current.reload} />;
}

function Counter({ report, reload }: { report: any; reload: () => void }) {
  const { t, tt, lang } = useI18n();
  const { can, companyId } = useSession();
  const { toast } = useToast();
  const shift = report.shift;
  const [q, setQ] = useState("");
  const catalog = useAsync(() => api.get(`/pos/registers/${shift.register_id}/catalog${q && q.length > 1 ? `?q=${encodeURIComponent(q)}` : ""}`), [shift.register_id, q]);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [paying, setPaying] = useState(false);
  const [receipt, setReceipt] = useState<any | null>(null);
  const [closing, setClosing] = useState(false);
  const [returning, setReturning] = useState(false);
  const scan = useRef<HTMLInputElement>(null);
  const lineTotal = (l: CartLine) => Math.round(l.qty * l.unitPrice * l.factor * (1 - l.discountPct / 100) * 1000) / 1000;
  const total = useMemo(() => Math.round(cart.reduce((s, l) => s + lineTotal(l), 0) * 1000) / 1000, [cart]);

  const add = (it: any, unit?: any) => {
    const uomId = unit?.uomId ?? null;
    const key = `${it.id}:${uomId ?? "base"}`;
    setCart((c) => c.some((l) => l.key === key) ? c.map((l) => l.key === key ? { ...l, qty: l.qty + 1 } : l)
      : [...c, { key, itemId: it.id, uomId, label: `${it.name_ar}${unit ? ` (${unit.code})` : ""}`, unitPrice: Number(it.sales_price), factor: unit ? Number(unit.factor) : 1, qty: 1, discountPct: 0 }]);
  };
  const onScan = (code: string) => {
    const items = catalog.data ?? [];
    const base = items.find((i: any) => i.barcode === code || i.code === code.toUpperCase());
    if (base) { add(base); setQ(""); return; }
    for (const i of items) { const u = (i.units ?? []).find((x: any) => x.barcode === code); if (u) { add(i, u); setQ(""); return; } }
    toast(`${tt("باركود غير معروف", "Unknown barcode")}: ${code}`, true);
  };
  const done = (r: any) => { setPaying(false); setCart([]); setReceipt(r); reload(); scan.current?.focus(); };

  return <>
    <div className="page-head"><h1>{tt("نقطة البيع", "Point of sale")} · {shift.register_code}</h1><div className="row">
      <span className="badge">{shift.number}</span>
      <span className="badge info">{tt("نقدية متوقعة", "Expected cash")}: <span className="num">{fmt(report.expectedCash)}</span></span>
      {can("pos.sales.return") && <button className="btn" onClick={() => setReturning(true)}>{tt("مرتجع", "Return")}</button>}
      <button className="btn" onClick={() => setClosing(true)}>{tt("إقفال الوردية", "Close shift")}</button></div></div>
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 3fr) minmax(280px, 2fr)", gap: 16 }} className="pos-grid">
      <div>
        <input ref={scan} autoFocus placeholder={tt("امسح الباركود أو ابحث بالاسم/الرمز ثم Enter", "Scan a barcode or search, then Enter")} value={q}
          onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && q.trim()) onScan(q.trim()); }} style={{ fontSize: 18, padding: 12, marginBottom: 12 }} />
        <ErrorBox error={catalog.error} />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 8 }}>
          {(catalog.data ?? []).map((it: any) => <div key={it.id} className="card" style={{ padding: 10, cursor: Number(it.available) > 0 ? "pointer" : "not-allowed", opacity: Number(it.available) > 0 ? 1 : 0.5 }}
            onClick={() => Number(it.available) > 0 && add(it)}>
            <div style={{ fontWeight: 600 }}>{it.name_ar}</div>
            <div className="num" style={{ color: "var(--muted)", fontSize: 12 }}>{it.code}</div>
            <div className="row" style={{ justifyContent: "space-between" }}><b className="num">{fmt(it.sales_price)}</b><span className="num" style={{ fontSize: 12 }}>{tt("متاح", "Avail.")} {Number(it.available)}</span></div>
            {(it.units ?? []).map((u: any) => <button key={u.uomId} className="btn" style={{ marginTop: 4, width: "100%" }} onClick={(e) => { e.stopPropagation(); add(it, u); }}>+ {u.code} ×{Number(u.factor)}</button>)}
          </div>)}
        </div>
      </div>
      <div className="card" style={{ display: "flex", flexDirection: "column" }}>
        <h3>{tt("السلة", "Cart")}</h3>
        {!cart.length ? <Empty text={tt("امسح صنفًا للبدء", "Scan an item to start")} /> : <div className="table-wrap"><table>
          <thead><tr><th>{tt("الصنف", "Item")}</th><th className="end">{tt("الكمية", "Qty")}</th><th className="end">{tt("خصم %", "Disc %")}</th><th className="end">{t.total}</th><th /></tr></thead>
          <tbody>{cart.map((l) => <tr key={l.key}><td>{l.label}<div className="num" style={{ fontSize: 11, color: "var(--muted)" }}>{fmt(l.unitPrice * l.factor)}</div></td>
            <td className="end"><input className="num" style={{ width: 60 }} value={l.qty} onChange={(e) => setCart(cart.map((x) => x.key === l.key ? { ...x, qty: Number(e.target.value) || 0 } : x))} /></td>
            <td className="end"><input className="num" style={{ width: 50 }} value={l.discountPct} onChange={(e) => setCart(cart.map((x) => x.key === l.key ? { ...x, discountPct: Number(e.target.value) || 0 } : x))} /></td>
            <td className="end num">{fmt(lineTotal(l))}</td><td><button className="btn" onClick={() => setCart(cart.filter((x) => x.key !== l.key))}>✕</button></td></tr>)}</tbody></table></div>}
        <div style={{ marginTop: "auto", paddingTop: 12 }}>
          <div className="row" style={{ justifyContent: "space-between", fontSize: 24 }}><b>{t.total}</b><b className="num">{fmt(total)}</b></div>
          <div className="alert info" style={{ fontSize: 12 }}>{tt("السعر النهائي يُحسب على الخادم (سعر العميل الخاص إن وجد).", "The server computes the final price (special customer price if any).")}</div>
          <button className="btn primary" style={{ width: "100%", fontSize: 18, padding: 12 }} disabled={!cart.length || cart.some((l) => l.qty <= 0)} onClick={() => setPaying(true)}>{tt("الدفع", "Pay")}</button>
        </div>
      </div>
    </div>
    {paying && <Pay shiftId={shift.id} cart={cart} estimate={total} onClose={() => setPaying(false)} onDone={done} />}
    {receipt && <Receipt data={receipt} onClose={() => setReceipt(null)} />}
    {closing && <CloseShift report={report} onClose={() => setClosing(false)} onDone={() => { setClosing(false); reload(); }} />}
    {returning && <PosReturn shiftId={shift.id} companyId={companyId ?? ""} onClose={() => { setReturning(false); reload(); }} />}
  </>;
}

function Pay({ shiftId, cart, estimate, onClose, onDone }: { shiftId: string; cart: CartLine[]; estimate: number; onClose: () => void; onDone: (r: any) => void }) {
  const { t, tt, lang } = useI18n();
  const { can, companyId } = useSession();
  const { toast } = useToast();
  const [clientId] = useState(uuid);   // same id on retry → the server never sells twice
  const customers = useAsync(() => (can("pos.sales.credit") ? api.get(`/customers?companyId=${companyId}&pageSize=200`) : Promise.resolve({ data: [] })), [companyId]);
  const [customerId, setCustomerId] = useState("");
  const [card, setCard] = useState("0");
  const [credit, setCredit] = useState("0");
  const [tendered, setTendered] = useState(String(estimate));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const cash = Math.max(0, Math.round((estimate - Number(card || 0) - Number(credit || 0)) * 1000) / 1000);
  const pay = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api.post(`/pos/shifts/${shiftId}/sales`, { clientId, customerId: customerId || null, lines: cart.map((l) => ({ itemId: l.itemId, uomId: l.uomId, qty: String(l.qty), discountPct: String(l.discountPct) })),
        cash: cash.toFixed(3), card: Number(card || 0).toFixed(3), credit: Number(credit || 0).toFixed(3), tendered: cash > 0 ? Number(tendered || 0).toFixed(3) : undefined });
      onDone(r);
    } catch (e) { setErr(e); toast(errMsg(e, lang), true); } finally { setBusy(false); }
  };
  return <Modal title={`${tt("الدفع", "Payment")} — ${fmt(estimate)}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>{t.cancel}</button>
    <button className="btn primary" disabled={busy} onClick={pay}>{tt("تأكيد البيع", "Confirm sale")}</button></>}>
    <ErrorBox error={err} />
    <div className="form-grid">
      <Field label={tt("بطاقة", "Card")}><input className="num" value={card} onChange={(e) => setCard(e.target.value)} /></Field>
      {can("pos.sales.credit") && <>
        <Field label={tt("العميل (للآجل)", "Customer (on account)")}><select value={customerId} onChange={(e) => setCustomerId(e.target.value)}><option value="">{tt("عميل نقدي", "Walk-in")}</option>
          {(customers.data?.data ?? []).map((c: any) => <option key={c.id} value={c.id}>{c.code} · {c.name_ar}</option>)}</select></Field>
        <Field label={tt("آجل على الحساب", "On account")}><input className="num" value={credit} onChange={(e) => setCredit(e.target.value)} disabled={!customerId} /></Field></>}
      <Field label={tt("نقدًا", "Cash")}><input className="num" value={cash.toFixed(3)} readOnly /></Field>
      {cash > 0 && <Field label={tt("المبلغ المستلم", "Tendered")}><input className="num" autoFocus value={tendered} onChange={(e) => setTendered(e.target.value)} /></Field>}
    </div>
    {cash > 0 && <div className="row" style={{ fontSize: 20, justifyContent: "space-between" }}><span>{tt("الباقي للعميل", "Change")}</span><b className="num">{fmt(Math.max(0, Number(tendered || 0) - cash))}</b></div>}
  </Modal>;
}

/** 80 mm thermal receipt: printed with the browser (any printer the device has, incl. Bluetooth/USB receipt printers) */
export function Receipt({ data, onClose }: { data: any; onClose: () => void }) {
  const { t, tt } = useI18n();
  const inv = data.invoice;
  return <Modal title={tt("الإيصال", "Receipt")} onClose={onClose} footer={<><button className="btn" onClick={onClose}>{t.close}</button><button className="btn primary" onClick={() => window.print()}>{tt("طباعة", "Print")}</button></>}>
    <div className="receipt" id="receipt">
      <div style={{ textAlign: "center" }}><b>{data.company_name}</b>{data.receipt_header && <div>{data.receipt_header}</div>}
        <div>{data.register_name} · {tt("الكاشير", "Cashier")}: {data.cashier}</div><div className="num">{inv.number} · {fmtDateTime(inv.posted_at)}</div>
        {data.customer_code !== "WALKIN" && <div>{data.customer_name}</div>}</div>
      <hr />
      {inv.lines.map((l: any) => <div key={l.id} className="row" style={{ justifyContent: "space-between" }}><span>{l.item_name_ar ?? l.item_code} × {Number(l.qty)} {l.uom_code ?? ""}{Number(l.discount_pct) ? ` (-${Number(l.discount_pct)}%)` : ""}</span><span className="num">{fmt(l.line_total)}</span></div>)}
      <hr />
      {Number(inv.discount_total) > 0 && <div className="row" style={{ justifyContent: "space-between" }}><span>{tt("الخصم", "Discount")}</span><span className="num">-{fmt(inv.discount_total)}</span></div>}
      <div className="row" style={{ justifyContent: "space-between", fontSize: 18 }}><b>{t.total}</b><b className="num">{fmt(inv.total)}</b></div>
      {data.payments.map((p: any, i: number) => <div key={i} className="row" style={{ justifyContent: "space-between" }}><span>{({ cash: tt("نقدًا", "Cash"), card: tt("بطاقة", "Card"), credit: tt("آجل", "On account") } as any)[p.tender]}</span><span className="num">{fmt(p.amount)}</span></div>)}
      {data.tendered && <div className="row" style={{ justifyContent: "space-between" }}><span>{tt("المستلم / الباقي", "Tendered / change")}</span><span className="num">{fmt(data.tendered)} / {fmt(data.change)}</span></div>}
      {data.receipt_footer && <><hr /><div style={{ textAlign: "center" }}>{data.receipt_footer}</div></>}
    </div>
  </Modal>;
}

function CloseShift({ report, onClose, onDone }: { report: any; onClose: () => void; onDone: () => void }) {
  const { t, tt, lang } = useI18n();
  const { toast } = useToast();
  const [counted, setCounted] = useState("");
  const [notes, setNotes] = useState("");
  const [z, setZ] = useState<any | null>(null);
  const close = async () => {
    try { setZ(await api.post(`/pos/shifts/${report.shift.id}/close`, { countedCash: counted, notes: notes || undefined }, { idempotencyKey: `close-${report.shift.id}` })); }
    catch (e) { toast(errMsg(e, lang), true); }
  };
  const r = z ?? report;
  return <Modal title={z ? tt("تقرير Z — الوردية مغلقة", "Z report — shift closed") : tt("تقرير X وإقفال الوردية", "X report & close")} onClose={z ? onDone : onClose}
    footer={z ? <><button className="btn" onClick={() => window.print()}>{tt("طباعة", "Print")}</button><button className="btn primary" onClick={onDone}>{t.close}</button></>
      : <><button className="btn" onClick={onClose}>{t.cancel}</button><button className="btn danger" disabled={counted === ""} onClick={close}>{tt("إقفال", "Close")}</button></>}>
    <ShiftSummary r={r} />
    {!z && <>
      <div className="alert info">{tt("عُدّ النقدية في الدرج وأدخلها كما هي. يُحسب الفرق تلقائيًا ويُرحّل لحساب العجز والزيادة.", "Count the drawer and enter the amount as is. The difference is computed and posted to over/short.")}</div>
      <div className="form-grid"><Field label={tt("النقدية المعدودة", "Counted cash")}><input className="num" autoFocus value={counted} onChange={(e) => setCounted(e.target.value)} /></Field>
        <Field label={tt("ملاحظات", "Notes")}><input value={notes} onChange={(e) => setNotes(e.target.value)} /></Field></div></>}
  </Modal>;
}

function ShiftSummary({ r }: { r: any }) {
  const { t, tt } = useI18n();
  const label = (k: string, tn: string) => `${({ sale: tt("بيع", "Sale"), refund: tt("مرتجع", "Refund"), drop: tt("سحب للخزينة", "Drop") } as any)[k]} · ${({ cash: tt("نقدًا", "Cash"), card: tt("بطاقة", "Card"), credit: tt("آجل", "On account") } as any)[tn]}`;
  return <div className="receipt">
    <div className="grid kpis">
      <div className="card kpi"><div className="label">{tt("الفواتير", "Invoices")}</div><div className="value num">{r.totals.invoices}</div></div>
      <div className="card kpi"><div className="label">{tt("صافي المبيعات", "Net sales")}</div><div className="value num">{fmt(r.totals.net)}</div></div>
      <div className="card kpi"><div className="label">{tt("الخصومات", "Discounts")}</div><div className="value num">{fmt(r.totals.discounts)}</div></div>
      <div className="card kpi"><div className="label">{tt("النقدية المتوقعة", "Expected cash")}</div><div className="value num">{fmt(r.expectedCash ?? r.shift.expected_cash)}</div></div>
      {r.shift.status === "closed" && <div className="card kpi"><div className="label">{tt("المعدود / الفرق", "Counted / variance")}</div><div className="value num">{fmt(r.shift.counted_cash)} / {fmt(r.shift.variance)}</div></div>}
    </div>
    <p className="num">{tt("عهدة الافتتاح", "Opening float")}: {fmt(r.shift.opening_float)} · {r.shift.number} · {r.shift.cashier}</p>
    {r.byTender.length ? <LinesTable rows={r.byTender} cols={[{ h: tt("الحركة", "Movement"), v: (x) => label(x.kind, x.tender) }, { h: tt("العدد", "Count"), v: (x) => x.n, end: true }, { h: t.amount, v: (x) => fmt(x.amount), end: true }]} /> : null}
    {r.topItems.length ? <LinesTable rows={r.topItems} cols={[{ h: tt("الأكثر مبيعًا", "Top items"), v: (x) => `${x.code} · ${x.name_ar}` }, { h: tt("الكمية", "Qty"), v: (x) => Number(x.qty), end: true }, { h: t.amount, v: (x) => fmt(x.amount), end: true }]} /> : null}
  </div>;
}

function PosReturn({ shiftId, companyId, onClose }: { shiftId: string; companyId: string; onClose: () => void }) {
  const { t, tt, lang } = useI18n();
  const { toast } = useToast();
  const [number, setNumber] = useState("");
  const [inv, setInv] = useState<any | null>(null);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [tender, setTender] = useState<"cash" | "card">("cash");
  const [reason, setReason] = useState("");
  const find = async () => {
    try {
      const l = await api.get(`/sales/invoices?companyId=${companyId}&q=${encodeURIComponent(number)}&status=posted`);
      const hit = l.data.find((x: any) => x.number === number.trim());
      if (!hit) { toast(tt("لم يُعثر على الفاتورة", "Invoice not found"), true); return; }
      setInv(await api.get(`/sales/invoices/${hit.id}`));
    } catch (e) { toast(errMsg(e, lang), true); }
  };
  const save = async () => {
    try {
      const lines = Object.entries(qty).filter(([, v]) => Number(v) > 0).map(([invoiceLineId, v]) => ({ invoiceLineId, qty: v }));
      const r = await api.post(`/pos/shifts/${shiftId}/returns`, { invoiceId: inv.id, lines, refundTender: tender, reason }, { idempotencyKey: `ret-${inv.id}-${JSON.stringify(lines)}` });
      toast(`${tt("تم الرد", "Refunded")} ${fmt(r.total)} — ${tt("البضاعة في مخزن الحجر", "goods in quarantine")}`); onClose();
    } catch (e) { toast(errMsg(e, lang), true); }
  };
  return <Modal title={tt("مرتجع نقطة البيع", "POS return")} onClose={onClose} footer={<><button className="btn" onClick={onClose}>{t.cancel}</button>{inv && <button className="btn danger" onClick={save}>{tt("تنفيذ المرتجع", "Process return")}</button>}</>}>
    <div className="row"><input placeholder={tt("رقم الفاتورة SI-…", "Invoice number SI-…")} value={number} onChange={(e) => setNumber(e.target.value)} onKeyDown={(e) => e.key === "Enter" && find()} />
      <button className="btn" onClick={find}>{t.show}</button></div>
    {inv && <>
      <p>{inv.number} · {inv.customer_name_ar ?? ""} · <b className="num">{fmt(inv.total)}</b> {inv.payment_type === "credit" ? `· ${tt("آجل: يُخصم من حساب العميل", "On account: credited to the customer")}` : ""}</p>
      <LinesTable rows={inv.lines} cols={[{ h: tt("الصنف", "Item"), v: (l) => l.item_name_ar ?? l.item_code }, { h: tt("المباع (وحدة أساسية)", "Sold (base)"), v: (l) => Number(l.base_qty), end: true },
        { h: tt("المرتجع", "Return qty"), v: (l) => <input className="num" style={{ width: 70 }} value={qty[l.id] ?? ""} onChange={(e) => setQty({ ...qty, [l.id]: e.target.value })} /> }]} />
      <div className="form-grid">
        {inv.payment_type !== "credit" && <Field label={tt("الرد", "Refund by")}><select value={tender} onChange={(e) => setTender(e.target.value as any)}><option value="cash">{tt("نقدًا من الدرج", "Cash from drawer")}</option><option value="card">{tt("إلى البطاقة", "To card")}</option></select></Field>}
        <Field label={t.reason}><input value={reason} onChange={(e) => setReason(e.target.value)} /></Field></div>
    </>}
  </Modal>;
}

// ================================================================== back office
export function PosShifts() {
  const { t, tt } = useI18n();
  const { can, companyId } = useSession();
  const [openId, setOpenId] = useState<string | null>(null);
  const [regs, setRegs] = useState(false);
  const list = useAsync(() => api.get(`/pos/shifts?companyId=${companyId}`), [companyId]);
  const rep = useAsync(() => (openId ? api.get(`/pos/shifts/${openId}`) : Promise.resolve(null)), [openId]);
  return <>
    <div className="page-head"><h1>{tt("ورديات نقاط البيع", "POS shifts")}</h1>{can("pos.registers.manage") && <button className="btn" onClick={() => setRegs(true)}>{tt("إعداد نقاط البيع", "Registers")}</button>}</div>
    <ErrorBox error={list.error} />
    {list.loading ? <Loading /> : !list.data?.length ? <div className="card"><Empty /></div> : <div className="table-wrap"><table>
      <thead><tr><th>{t.number}</th><th>{tt("نقطة البيع", "Register")}</th><th>{tt("الكاشير", "Cashier")}</th><th>{tt("الفتح", "Opened")}</th><th className="end">{tt("الفواتير", "Invoices")}</th>
        <th className="end">{tt("الصافي", "Net")}</th><th className="end">{tt("الفرق", "Variance")}</th><th>{t.status}</th></tr></thead>
      <tbody>{list.data.map((s: any) => <tr key={s.id} style={{ cursor: "pointer" }} onClick={() => setOpenId(s.id)}><td className="num">{s.number}</td><td>{s.register_code}</td><td>{s.cashier}</td>
        <td className="num">{fmtDateTime(s.opened_at)}</td><td className="end num">{s.invoices}</td><td className="end num">{fmt(s.net)}</td>
        <td className={`end num ${Number(s.variance) < 0 ? "bad" : ""}`}>{s.variance === null ? "—" : fmt(s.variance)}</td><td><StatusBadge s={s.status} /></td></tr>)}</tbody></table></div>}
    {openId && rep.data && <Modal title={`${rep.data.shift.number} — ${rep.data.shift.register_code}`} onClose={() => setOpenId(null)} footer={<button className="btn" onClick={() => setOpenId(null)}>{t.close}</button>}>
      <ShiftSummary r={rep.data} /></Modal>}
    {regs && <Registers onClose={() => setRegs(false)} />}
  </>;
}

function Registers({ onClose }: { onClose: () => void }) {
  const { t, tt, lang, pick } = useI18n();
  const { companyId } = useSession();
  const { toast } = useToast();
  const list = useAsync(() => api.get(`/pos/registers?companyId=${companyId}`), [companyId]);
  const whs = useAsync(() => api.get("/warehouses"), []);
  const branches = useAsync(() => api.get("/branches"), []);
  const custs = useAsync(() => api.get(`/customers?companyId=${companyId}&pageSize=200`), [companyId]);
  const accs = useAsync(() => api.get(`/accounting/accounts?companyId=${companyId}`), [companyId]);
  const roleAcc = (role: string) => (accs.data ?? []).find((a: any) => a.role === role)?.id ?? "";
  const [f, setF] = useState<any>({ code: "", nameAr: "", branchId: "", warehouseId: "", returnWarehouseId: "", walkInCustomerId: "", cashAccountId: "", safeAccountId: "", cardAccountId: "", varianceAccountId: "", maxDiscountPct: "0", receiptFooter: "" });
  const val = (k: string, role?: string) => f[k] || (role ? roleAcc(role) : "");
  const acctSel = (k: string, types: string[], role?: string, optional?: boolean) => <select value={val(k, role)} onChange={(e) => setF({ ...f, [k]: e.target.value })}><option value="">{optional ? "—" : "…"}</option>
    {(accs.data ?? []).filter((a: any) => a.is_postable && types.includes(a.type)).map((a: any) => <option key={a.id} value={a.id}>{a.code} · {pick(a.name_ar, a.name_en)}</option>)}</select>;
  const save = async () => {
    try {
      await api.post("/pos/registers", { companyId, ...f, cashAccountId: val("cashAccountId", "pos_cash"), safeAccountId: val("safeAccountId", "cash_main"),
        cardAccountId: f.cardAccountId || null, varianceAccountId: f.varianceAccountId || null, receiptFooter: f.receiptFooter || undefined });
      toast(t.savedOk); list.reload();
    } catch (e) { toast(errMsg(e, lang), true); }
  };
  return <Modal title={tt("نقاط البيع", "Registers")} onClose={onClose} footer={<><button className="btn" onClick={onClose}>{t.close}</button><button className="btn primary" onClick={save}>{t.add}</button></>}>
    {list.data?.length ? <LinesTable rows={list.data} cols={[{ h: t.code, v: (r) => r.code }, { h: t.name, v: (r) => r.name_ar }, { h: t.warehouse, v: (r) => r.warehouse_code },
      { h: tt("حد الخصم", "Max disc."), v: (r) => `${Number(r.max_discount_pct)}%`, end: true }, { h: tt("الوردية المفتوحة", "Open shift"), v: (r) => r.open_shift_number ? `${r.open_shift_number} · ${r.open_shift_cashier}` : "—" }]} /> : null}
    <div className="form-grid" style={{ marginTop: 12 }}>
      <Field label={t.code}><input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></Field>
      <Field label={t.name}><input value={f.nameAr} onChange={(e) => setF({ ...f, nameAr: e.target.value })} /></Field>
      <Field label={t.branch}><select value={f.branchId} onChange={(e) => setF({ ...f, branchId: e.target.value })}><option value="">…</option>{(branches.data ?? []).map((b: any) => <option key={b.id} value={b.id}>{b.code} · {b.name_ar}</option>)}</select></Field>
      <Field label={tt("مخزن البيع", "Sales warehouse")}><select value={f.warehouseId} onChange={(e) => setF({ ...f, warehouseId: e.target.value })}><option value="">…</option>
        {(whs.data ?? []).filter((w: any) => w.is_sellable).map((w: any) => <option key={w.id} value={w.id}>{w.code} · {w.name_ar}</option>)}</select></Field>
      <Field label={tt("مخزن المرتجعات (حجر)", "Returns warehouse (quarantine)")}><select value={f.returnWarehouseId} onChange={(e) => setF({ ...f, returnWarehouseId: e.target.value })}><option value="">…</option>
        {(whs.data ?? []).filter((w: any) => w.kind === "quarantine").map((w: any) => <option key={w.id} value={w.id}>{w.code} · {w.name_ar}</option>)}</select></Field>
      <Field label={tt("العميل النقدي", "Walk-in customer")}><select value={f.walkInCustomerId} onChange={(e) => setF({ ...f, walkInCustomerId: e.target.value })}><option value="">…</option>
        {(custs.data?.data ?? []).map((c: any) => <option key={c.id} value={c.id}>{c.code} · {c.name_ar}</option>)}</select></Field>
      <Field label={tt("حساب الدرج", "Drawer account")}>{acctSel("cashAccountId", ["asset"], "pos_cash")}</Field>
      <Field label={tt("الخزينة الرئيسية", "Main safe")}>{acctSel("safeAccountId", ["asset"], "cash_main")}</Field>
      <Field label={tt("حساب البطاقات", "Card account")}>{acctSel("cardAccountId", ["asset"], undefined, true)}</Field>
      <Field label={tt("حساب العجز والزيادة", "Over/short account")}>{acctSel("varianceAccountId", ["expense", "revenue"], undefined, true)}</Field>
      <Field label={tt("حد الخصم للكاشير %", "Cashier discount limit %")}><input className="num" value={f.maxDiscountPct} onChange={(e) => setF({ ...f, maxDiscountPct: e.target.value })} /></Field>
      <Field label={tt("تذييل الإيصال", "Receipt footer")}><input value={f.receiptFooter} onChange={(e) => setF({ ...f, receiptFooter: e.target.value })} /></Field>
    </div>
  </Modal>;
}
