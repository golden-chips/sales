import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Banknote, Check, CreditCard, Landmark, Minus, Plus, Printer, Smartphone, UserRound } from "lucide-react";
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
  // only the first load shows the spinner: refreshing the shift after a sale must not unmount the
  // counter (that would drop the receipt the cashier is about to print)
  if (current.loading && current.data === undefined) return <Loading />;
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
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "F9" && cart.length && !paying && !receipt) { e.preventDefault(); setPaying(true); } };
    window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k);
  }, [cart.length, paying, receipt]);
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
          onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { if (q.trim()) onScan(q.trim()); else if (cart.length) setPaying(true); } }} style={{ fontSize: 18, padding: 12, marginBottom: 12 }} />
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
            <td className="end"><div className="qty-step"><button className="btn sm" onClick={() => setCart(cart.map((x) => x.key === l.key ? { ...x, qty: Math.max(1, x.qty - 1) } : x))} aria-label="−"><Minus size={14} /></button>
              <input className="num" style={{ width: 52 }} value={l.qty} onChange={(e) => setCart(cart.map((x) => x.key === l.key ? { ...x, qty: Number(e.target.value) || 0 } : x))} />
              <button className="btn sm" onClick={() => setCart(cart.map((x) => x.key === l.key ? { ...x, qty: x.qty + 1 } : x))} aria-label="+"><Plus size={14} /></button></div></td>
            <td className="end"><input className="num" style={{ width: 50 }} value={l.discountPct} onChange={(e) => setCart(cart.map((x) => x.key === l.key ? { ...x, discountPct: Number(e.target.value) || 0 } : x))} /></td>
            <td className="end num">{fmt(lineTotal(l))}</td><td><button className="btn" onClick={() => setCart(cart.filter((x) => x.key !== l.key))}>✕</button></td></tr>)}</tbody></table></div>}
        <div style={{ marginTop: "auto", paddingTop: 12 }}>
          <div className="row" style={{ justifyContent: "space-between", fontSize: 24 }}><b>{t.total}</b><b className="num">{fmt(total)}</b></div>
          <div className="alert info" style={{ fontSize: 12 }}>{tt("السعر النهائي يُحسب على الخادم (سعر العميل الخاص إن وجد).", "The server computes the final price (special customer price if any).")}</div>
          <button className="btn primary" style={{ width: "100%", fontSize: 18, padding: 12 }} disabled={!cart.length || cart.some((l) => l.qty <= 0)} onClick={() => setPaying(true)}>{tt("الدفع", "Pay")} <kbd>F9</kbd></button>
        </div>
      </div>
    </div>
    {paying && <Pay shiftId={shift.id} cart={cart} estimate={total} methods={report.paymentMethods ?? []} legacyCard={!!report.legacyCard} onClose={() => setPaying(false)} onDone={done} />}
    {receipt && <Receipt data={receipt} onClose={() => { setReceipt(null); setTimeout(() => scan.current?.focus(), 50); }} />}
    {closing && <CloseShift report={report} onClose={() => setClosing(false)} onDone={() => { setClosing(false); reload(); }} />}
    {returning && <PosReturn shiftId={shift.id} companyId={companyId ?? ""} onClose={() => { setReturning(false); reload(); }} />}
  </>;
}

type PayLine = { key: string; kind: "cash" | "method" | "card" | "credit"; methodId?: string; label: string; amount: string };
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** payment: one tap per method (cash, each card/wallet the cashier may take, on account), split allowed,
 *  big "received" box with quick notes, live change / still-due. Enter confirms when fully paid. */
function Pay({ shiftId, cart, estimate, methods, legacyCard, onClose, onDone }: { shiftId: string; cart: CartLine[]; estimate: number; methods: any[]; legacyCard: boolean;
  onClose: () => void; onDone: (r: any) => void }) {
  const { t, tt, lang } = useI18n();
  const { can, companyId } = useSession();
  const { toast } = useToast();
  const [clientId] = useState(uuid);   // same id on retry → the server never sells twice
  const canCredit = can("pos.sales.credit");
  const customers = useAsync(() => (canCredit ? api.get(`/customers?companyId=${companyId}&pageSize=200`) : Promise.resolve({ data: [] })), [companyId]);
  const [total, setTotal] = useState(estimate);
  const [lines, setLines] = useState<PayLine[]>([{ key: "cash", kind: "cash", label: tt("نقدًا", "Cash"), amount: String(estimate) }]);
  const [tendered, setTendered] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const tenderRef = useRef<HTMLInputElement>(null);
  const paid = r3(lines.reduce((a, l) => a + (Number(l.amount) || 0), 0));
  const remaining = r3(total - paid);
  const cashLine = lines.find((l) => l.kind === "cash");
  const cash = Number(cashLine?.amount || 0);
  const got = tendered === "" ? cash : Number(tendered) || 0;
  const change = r3(got - cash);
  const creditLine = lines.find((l) => l.kind === "credit");
  const ready = remaining === 0 && paid > 0 && change >= 0 && (!creditLine || !!customerId) && !busy;

  /** tapping a method adds it with whatever is still due (or the whole total if nothing is due yet and it is the only line) */
  const tap = (l: Omit<PayLine, "amount">) => {
    const exists = lines.find((x) => x.key === l.key);
    if (exists) return;
    if (remaining > 0) setLines([...lines, { ...l, amount: String(remaining) }]);
    else if (lines.length === 1 && lines[0].kind === "cash") setLines([{ ...l, amount: String(total) }]);   // switch cash → this method
    else setLines([...lines, { ...l, amount: "0" }]);
    if (l.kind !== "cash") setTendered("");
  };
  const setAmount = (key: string, v: string) => setLines(lines.map((l) => (l.key === key ? { ...l, amount: v } : l)));
  const remove = (key: string) => setLines(lines.filter((l) => l.key !== key));
  // quick cash: exact, then the next round amounts a customer usually hands over (Libyan notes: 1, 5, 10, 20, 50)
  const quick = useMemo(() => {
    if (cash <= 0) return [];
    const ups = [1, 5, 10, 20, 50, 100].map((n) => Math.ceil(cash / n) * n).filter((v) => v > cash);
    return [...new Set(ups)].slice(0, 4);
  }, [cash]);

  const pay = async () => {
    if (!ready) return;
    setBusy(true); setErr(null);
    try {
      const sum = (k: PayLine["kind"]) => r3(lines.filter((l) => l.kind === k).reduce((a, l) => a + (Number(l.amount) || 0), 0)).toFixed(3);
      const r = await api.post(`/pos/shifts/${shiftId}/sales`, { clientId, customerId: customerId || null,
        lines: cart.map((l) => ({ itemId: l.itemId, uomId: l.uomId, qty: String(l.qty), discountPct: String(l.discountPct) })),
        cash: sum("cash"), card: sum("card"), credit: sum("credit"),
        payments: lines.filter((l) => l.kind === "method" && Number(l.amount) > 0).map((l) => ({ methodId: l.methodId, amount: Number(l.amount).toFixed(3) })),
        tendered: cash > 0 ? got.toFixed(3) : undefined });
      onDone(r);
    } catch (e: any) {
      // the server prices the sale (customer special prices); if it differs, take its total and let the cashier confirm again
      if (e?.code === "PAYMENT_MISMATCH" && e.details?.total) {
        const real = Number(e.details.total); setTotal(real);
        setLines(lines.length === 1 ? [{ ...lines[0], amount: String(real) }] : lines);
        toast(tt(`الإجمالي الصحيح ${fmt(String(real))} — راجع الدفع وأكّد`, `Correct total ${real} — check and confirm`), true);
      } else { setErr(e); toast(errMsg(e, lang), true); }
    } finally { setBusy(false); }
  };
  useEffect(() => { tenderRef.current?.focus(); }, [cashLine?.key]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Enter" && !(e.target as HTMLElement)?.closest("select")) { e.preventDefault(); pay(); } };
    window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k);
  });

  const tiles: { l: Omit<PayLine, "amount">; icon: ReactNode; sub?: string }[] = [
    { l: { key: "cash", kind: "cash", label: tt("نقدًا", "Cash") }, icon: <Banknote size={22} /> },
    ...methods.map((m) => ({ l: { key: `m:${m.id}`, kind: "method" as const, methodId: m.id, label: m.name_ar }, icon: m.kind === "wallet" ? <Smartphone size={22} /> : m.kind === "transfer" ? <Landmark size={22} /> : <CreditCard size={22} /> })),
    ...(legacyCard && !methods.length ? [{ l: { key: "card", kind: "card" as const, label: tt("بطاقة", "Card") }, icon: <CreditCard size={22} /> }] : []),
    ...(canCredit ? [{ l: { key: "credit", kind: "credit" as const, label: tt("آجل على حساب عميل", "On account") }, icon: <UserRound size={22} /> }] : []),
  ];
  return <Modal wide title={tt("الدفع", "Payment")} onClose={onClose}
    footer={<><button className="btn" onClick={onClose}>{t.cancel} <kbd>Esc</kbd></button>
      <button className="btn primary pay-confirm" disabled={!ready} onClick={pay}>{busy ? "…" : <>{tt("تأكيد البيع", "Confirm sale")} <kbd>Enter</kbd></>}</button></>}>
    <ErrorBox error={err} />
    <div className="pay-layout">
      <div className="grid" style={{ gap: 14, alignContent: "start" }}>
        <div className="pay-total"><span>{tt("المطلوب", "Total due")}</span><b className="num">{fmt(String(total))}</b></div>
        <div className="pay-tiles">{tiles.map(({ l, icon }) => <button key={l.key} className={`pay-tile ${lines.some((x) => x.key === l.key) ? "on" : ""}`} onClick={() => tap(l)}>{icon}<span>{l.label}</span></button>)}</div>
        <div className="pay-lines">{lines.map((l) => <div key={l.key} className="pay-line">
          <span className="pl-name">{l.label}</span>
          <input className="num" inputMode="decimal" value={l.amount} onFocus={(e) => e.target.select()} onChange={(e) => setAmount(l.key, e.target.value)} aria-label={l.label} />
          {lines.length > 1 && <button className="btn sm" onClick={() => remove(l.key)} aria-label="remove">✕</button>}
        </div>)}</div>
        {creditLine && <Field label={tt("العميل (للآجل)", "Customer (on account)")}><select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
          <option value="">{tt("اختر العميل…", "Choose…")}</option>{customers.data?.data.map((c: any) => <option key={c.id} value={c.id}>{c.code} {c.name_ar}</option>)}</select></Field>}
      </div>
      <div className="grid" style={{ gap: 12, alignContent: "start" }}>
        {cashLine && <>
          <label className="tender-box"><span>{tt("المبلغ المستلم من الزبون", "Cash received")}</span>
            <input ref={tenderRef} className="num" inputMode="decimal" placeholder={fmt(String(cash))} value={tendered} onFocus={(e) => e.target.select()} onChange={(e) => setTendered(e.target.value)} /></label>
          <div className="quick-cash"><button className="btn" onClick={() => setTendered(String(cash))}>{tt("بالضبط", "Exact")} <b className="num">{fmt(String(cash))}</b></button>
            {quick.map((v) => <button key={v} className="btn" onClick={() => setTendered(String(v))}><b className="num">{v}</b></button>)}</div>
        </>}
        <div className={`pay-result ${remaining > 0 ? "due" : change > 0 ? "change" : "ok"}`}>
          {remaining > 0 ? <><span>{tt("متبقي على الزبون", "Still due")}</span><b className="num">{fmt(String(remaining))}</b></>
            : remaining < 0 ? <><span>{tt("المدفوع أكثر من المطلوب", "Overpaid")}</span><b className="num">{fmt(String(-remaining))}</b></>
            : change < 0 ? <><span>{tt("المستلم أقل من النقدي", "Received is short")}</span><b className="num">{fmt(String(-change))}</b></>
            : change > 0 ? <><span>{tt("الباقي للزبون", "Change to give")}</span><b className="num">{fmt(String(change))}</b></>
            : <><span>{tt("المبلغ مكتمل", "Fully paid")}</span><Check size={26} /></>}
        </div>
      </div>
    </div>
  </Modal>;
}

/** print format per device: 80 mm thermal roll or an A4 invoice (any office printer) */
type PrintFormat = "roll" | "a4";
const getFormat = (): PrintFormat => { try { return (localStorage.getItem("pos.print") as PrintFormat) || "roll"; } catch { return "roll"; } };
const setFormatStore = (f: PrintFormat) => { try { localStorage.setItem("pos.print", f); } catch { /* per-device convenience only */ } };
export function printReceipt(format: PrintFormat) {
  // the page size is set just for this print: no browser margins → no URL/date header and footer
  const st = document.createElement("style");
  st.textContent = format === "roll" ? "@page { size: 80mm auto; margin: 0 }" : "@page { size: A4; margin: 0 }";
  document.head.appendChild(st); document.documentElement.setAttribute("data-print", format);
  const done = () => { st.remove(); document.documentElement.removeAttribute("data-print"); window.removeEventListener("afterprint", done); };
  window.addEventListener("afterprint", done);
  window.print();
}

export function Receipt({ data, onClose }: { data: any; onClose: () => void }) {
  const { t, tt } = useI18n();
  const [format, setFormat] = useState<PrintFormat>(getFormat);
  const choose = (f: PrintFormat) => { setFormat(f); setFormatStore(f); };
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Enter") { e.preventDefault(); onClose(); } };
    window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return <Modal title={tt("تم البيع ✓", "Sale complete ✓")} onClose={onClose} footer={<>
    <div className="seg" style={{ marginInlineEnd: "auto" }}><button className={format === "roll" ? "on" : ""} onClick={() => choose("roll")}>{tt("إيصال حراري 80مم", "80mm receipt")}</button>
      <button className={format === "a4" ? "on" : ""} onClick={() => choose("a4")}>{tt("فاتورة A4", "A4 invoice")}</button></div>
    <button className="btn" onClick={() => printReceipt(format)}><Printer size={16} />{tt("طباعة", "Print")}</button>
    <button className="btn primary" onClick={onClose}>{tt("بيع جديد", "New sale")} <kbd>Enter</kbd></button></>}>
    {Number(data.change) > 0 && <div className="pay-result change" style={{ marginBottom: 12 }}><span>{tt("الباقي للزبون", "Change to give")}</span><b className="num">{fmt(data.change)}</b></div>}
    <div className={`receipt-paper ${format}`}><ReceiptBody data={data} format={format} /></div>
    {createPortal(<div className="print-portal"><div className={`receipt-print ${format}`}><ReceiptBody data={data} format={format} /></div></div>, document.body)}
  </Modal>;
}

function ReceiptBody({ data, format }: { data: any; format: PrintFormat }) {
  const { tt } = useI18n();
  const inv = data.invoice;
  const tender = (p: any) => p.method ?? ({ cash: tt("نقدًا", "Cash"), card: tt("بطاقة", "Card"), credit: tt("آجل", "On account") } as any)[p.tender];
  const row = (label: ReactNode, value: ReactNode, cls = "") => <div className={`rc-row ${cls}`}><span>{label}</span><span className="num">{value}</span></div>;
  return <div className="rc">
    <div className="rc-head">
      <b className="rc-company">{data.company_name}</b>
      {data.receipt_header && <div>{data.receipt_header}</div>}
      <div className="rc-title">{format === "a4" ? tt("فاتورة مبيعات", "Sales invoice") : tt("إيصال بيع", "Sales receipt")}</div>
    </div>
    <div className="rc-meta">
      {row(tt("رقم الفاتورة", "Invoice no."), inv.number)}
      {row(tt("التاريخ", "Date"), fmtDateTime(inv.posted_at))}
      {row(tt("الكاشير", "Cashier"), <span style={{ fontFamily: "inherit" }}>{data.cashier}</span>)}
      {data.customer_code !== "WALKIN" && row(tt("العميل", "Customer"), <span style={{ fontFamily: "inherit" }}>{data.customer_name}</span>)}
    </div>
    <table className="rc-items"><thead><tr><th>{tt("الصنف", "Item")}</th><th className="end">{tt("الكمية", "Qty")}</th>{format === "a4" && <th className="end">{tt("السعر", "Price")}</th>}<th className="end">{tt("المبلغ", "Amount")}</th></tr></thead>
      <tbody>{inv.lines.map((l: any) => <tr key={l.id}><td>{l.item_name_ar ?? l.item_code}{Number(l.discount_pct) ? <small> −{Number(l.discount_pct)}%</small> : null}</td>
        <td className="end num">{Number(l.qty)} {l.uom_code ?? ""}</td>{format === "a4" && <td className="end num">{fmt(l.unit_price)}</td>}<td className="end num">{fmt(l.line_total)}</td></tr>)}</tbody></table>
    <div className="rc-totals">
      {Number(inv.discount_total) > 0 && row(tt("الخصم", "Discount"), `−${fmt(inv.discount_total)}`)}
      {row(tt("الإجمالي", "Total"), fmt(inv.total), "rc-grand")}
      {data.payments.map((p: any, i: number) => <div key={i}>{row(tender(p), fmt(p.amount))}</div>)}
      {data.tendered && <>{row(tt("المستلم", "Received"), fmt(data.tendered))}{row(tt("الباقي", "Change"), fmt(data.change), "rc-change")}</>}
    </div>
    <div className="rc-foot">{data.receipt_footer || tt("شكرًا لزيارتكم", "Thank you")}<div className="num" style={{ fontSize: "0.85em", opacity: 0.7 }}>{data.register_name} · {data.shift_number}</div></div>
  </div>;
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

// ================================================================== payment methods (settings)
/** card / wallet / transfer methods: each settles to its own account; optionally limited to named cashiers */
export function PaymentMethods() {
  const { tt, lang } = useI18n();
  const { companyId, can } = useSession();
  const { toast } = useToast();
  const list = useAsync(() => api.get(`/pos/payment-methods?companyId=${companyId}`), [companyId]);
  const accounts = useAsync(() => api.get(`/accounting/accounts?companyId=${companyId}`), [companyId]);
  const users = useAsync(() => (can("core.users.view") ? api.get("/users?pageSize=200&active=true") : Promise.resolve({ data: [] })), []);
  const blank = { id: "", nameAr: "", kind: "card", accountId: "", isActive: true, userIds: [] as string[] };
  const [f, setF] = useState<typeof blank | null>(null);
  const assets = (accounts.data ?? []).filter((a: any) => a.type === "asset" && a.is_postable !== false && !["ar", "ap"].includes(a.role));
  const save = async () => {
    if (!f) return;
    const body = { companyId, nameAr: f.nameAr, kind: f.kind, accountId: f.accountId, isActive: f.isActive, userIds: f.userIds };
    try { if (f.id) await api.put(`/pos/payment-methods/${f.id}`, body); else await api.post("/pos/payment-methods", body); toast(tt("حُفظت طريقة الدفع", "Saved")); setF(null); list.reload(); }
    catch (e) { toast(errMsg(e, lang), true); }
  };
  const kindName = (k: string) => ({ card: tt("بطاقة مصرفية", "Bank card"), wallet: tt("محفظة إلكترونية", "E-wallet"), transfer: tt("تحويل مصرفي", "Bank transfer") } as any)[k];
  return <div className="card">
    <div className="row"><h2 style={{ margin: 0 }}>{tt("طرق الدفع (البطاقات والمحافظ)", "Payment methods (cards & wallets)")}</h2><span className="spacer" />
      <button className="btn primary" onClick={() => setF(blank)}>{tt("+ طريقة دفع", "+ Method")}</button></div>
    <p style={{ color: "var(--muted)" }}>{tt("كل طريقة تظهر للكاشير زرًا في شاشة الدفع، وتُرحَّل لحسابها. إن حددت مستخدمين فلن تظهر إلا لهم.", "Each method is a button on the payment screen and posts to its own account. Pick users to limit who sees it.")}</p>
    <ErrorBox error={list.error} />
    <div className="table-wrap"><table><thead><tr><th>{tt("الاسم", "Name")}</th><th>{tt("النوع", "Kind")}</th><th>{tt("الحساب", "Account")}</th><th>{tt("متاحة لـ", "Available to")}</th><th>{tt("الحالة", "Status")}</th><th /></tr></thead>
      <tbody>{(list.data ?? []).length ? list.data.map((m: any) => <tr key={m.id}><td><b>{m.name_ar}</b></td><td>{kindName(m.kind)}</td><td><span className="num">{m.account_code}</span> {m.account_name}</td>
        <td>{m.user_ids.length ? tt(`${m.user_ids.length} مستخدم`, `${m.user_ids.length} users`) : tt("كل الكاشيرية", "All cashiers")}</td>
        <td>{m.is_active ? <span className="badge ok">{tt("فعّالة", "Active")}</span> : <span className="badge">{tt("موقوفة", "Inactive")}</span>}</td>
        <td><button className="btn sm" onClick={() => setF({ id: m.id, nameAr: m.name_ar, kind: m.kind, accountId: m.account_id, isActive: m.is_active, userIds: m.user_ids })}>{tt("تعديل", "Edit")}</button></td></tr>)
        : <tr><td colSpan={6} style={{ color: "var(--muted)" }}>{tt("لا توجد طرق دفع بعد — أضف مثلًا «بطاقة مصرف الجمهورية» و«موبي كاش».", "None yet — add e.g. a bank card and a mobile wallet.")}</td></tr>}</tbody></table></div>
    {f && <Modal title={f.id ? tt("تعديل طريقة الدفع", "Edit method") : tt("طريقة دفع جديدة", "New payment method")} onClose={() => setF(null)}
      footer={<><button className="btn" onClick={() => setF(null)}>{tt("إلغاء", "Cancel")}</button><button className="btn primary" disabled={!f.nameAr || !f.accountId} onClick={save}>{tt("حفظ", "Save")}</button></>}>
      <div className="form-grid">
        <Field label={tt("الاسم كما يراه الكاشير", "Name shown to the cashier")}><input value={f.nameAr} onChange={(e) => setF({ ...f, nameAr: e.target.value })} placeholder={tt("مثال: بطاقة مصرف الجمهورية", "e.g. Bank card")} /></Field>
        <Field label={tt("النوع", "Kind")}><select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{["card", "wallet", "transfer"].map((k) => <option key={k} value={k}>{kindName(k)}</option>)}</select></Field>
        <Field label={tt("الحساب الذي يُرحَّل له", "Account it posts to")}><select value={f.accountId} onChange={(e) => setF({ ...f, accountId: e.target.value })}><option value="">—</option>
          {assets.map((a: any) => <option key={a.id} value={a.id}>{a.code} — {a.name_ar}</option>)}</select></Field>
        <label className="setting-row" style={{ border: 0 }}><span><b>{tt("فعّالة", "Active")}</b></span><input type="checkbox" className="toggle" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} /></label>
      </div>
      <h3>{tt("متاحة لـ (اتركها فارغة = كل الكاشيرية)", "Available to (empty = all cashiers)")}</h3>
      <div className="mod-groups">{(users.data?.data ?? []).map((u: any) => <label key={u.id} className={`mod-item ${f.userIds.includes(u.id) ? "on" : ""}`}>
        <input type="checkbox" style={{ width: "auto", minHeight: 0 }} checked={f.userIds.includes(u.id)} onChange={() => setF({ ...f, userIds: f.userIds.includes(u.id) ? f.userIds.filter((x) => x !== u.id) : [...f.userIds, u.id] })} />
        <span>{u.full_name}</span><small>{u.email}</small></label>)}</div>
    </Modal>}
  </div>;
}
