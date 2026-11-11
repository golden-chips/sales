// Attendance & pay engine — pure functions (no DB), unit-tested.
// Rules ported from «حضوري» (see migration 008 for the defaults).

/** exact fixed-point money: 6 decimal places in a BigInt (no float drift) */
const S = 1_000_000n;
export const dec = (s: string | number): bigint => {
  const str = typeof s === "number" ? s.toFixed(6) : String(s).trim();
  const neg = str.startsWith("-");
  const [i, f = ""] = (neg ? str.slice(1) : str).split(".");
  const v = BigInt(i || "0") * S + BigInt((f + "000000").slice(0, 6));
  return neg ? -v : v;
};
export const mul = (a: bigint, b: bigint) => (a * b) / S;
export const div = (a: bigint, b: bigint) => (b === 0n ? 0n : (a * S) / b);
/** round half-up to `digits` decimals and render as a numeric string */
export const fmt = (v: bigint, digits: number) => {
  const step = 10n ** BigInt(6 - digits);
  const neg = v < 0n;
  let a = neg ? -v : v;
  a = ((a + step / 2n) / step) * step;
  const i = a / S, f = (a % S).toString().padStart(6, "0").slice(0, digits);
  return `${neg && a !== 0n ? "-" : ""}${i}${digits ? "." + f : ""}`;
};
export const round = (v: bigint, digits: number) => dec(fmt(v, digits));
export const min = (a: bigint, b: bigint) => (a < b ? a : b);
export const max = (a: bigint, b: bigint) => (a > b ? a : b);

export interface HrSettings {
  weekendDays: number[]; rateMode: "workdays" | "fixed"; fixedDivisor: number;
  late: { grace: number; fromStart: boolean; mode: "none" | "minutes"; multiplier: string; freePerMonth: number };
  early: { grace: number; fromStart: boolean; mode: "none" | "minutes"; multiplier: string; freePerMonth: number };
  penaltyCapDays: string;
  overtime: { enabled: boolean; requiresApproval: boolean; minMinutes: number; multiplier: string; offdayMultiplier: string };
  missingOut: "flag_only" | "half_absent"; dedupMin: number;
}
export interface Schedule { start: string; end: string; breakMinutes: number }   // "08:00"
export interface DayInput {
  date: string;                       // YYYY-MM-DD (local)
  punches: number[];                  // minutes since local midnight of `date` (may exceed 1440 for night shifts)
  holiday: boolean;
  leave: "paid" | "unpaid" | null;
  decisions: Set<string>;             // excused_paid | excused_unpaid | approve_overtime | waive_late | waive_early
  approvedOvertimeMinutes?: number;
  employed: boolean;
}
export type DayStatus = "off" | "holiday" | "leave_paid" | "leave_unpaid" | "excused_paid" | "excused_unpaid" | "absent" | "present" | "not_employed";
export interface DayResult {
  date: string; status: DayStatus; workDay: boolean; inMin: number | null; outMin: number | null;
  lateMin: number; earlyMin: number; overtimeMin: number; overtimeOffday: boolean; missingOut: boolean;
}

const toMin = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + (m || 0); };
const penalty = (raw: number, grace: number, fromStart: boolean) => (raw <= grace ? 0 : fromStart ? raw : raw - grace);
export const weekday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();

export function shiftMinutes(s: Schedule) {
  const a = toMin(s.start), b = toMin(s.end);
  return (b > a ? b - a : b + 1440 - a) - s.breakMinutes;
}

/** one employee-day → status, late/early/overtime minutes (حضوري rules) */
export function computeDay(d: DayInput, s: Schedule, cfg: HrSettings): DayResult {
  const base: DayResult = { date: d.date, status: "present", workDay: false, inMin: null, outMin: null, lateMin: 0, earlyMin: 0, overtimeMin: 0, overtimeOffday: false, missingOut: false };
  if (!d.employed) return { ...base, status: "not_employed" };
  const off = cfg.weekendDays.includes(weekday(d.date));
  const start = toMin(s.start);
  let end = toMin(s.end);
  if (end <= start) end += 1440; // night shift
  // dedupe punches closer than dedupMin
  const ps = [...d.punches].sort((a, b) => a - b).filter((p, i, arr) => i === 0 || p - arr[i - 1] > cfg.dedupMin);
  const inMin = ps.length ? ps[0] : null;
  const outMin = ps.length > 1 ? ps[ps.length - 1] : null;
  const r = { ...base, inMin, outMin, workDay: !off && !d.holiday };
  if (off || d.holiday) {
    // working on a day off: all worked time is overtime at the off-day multiplier
    if (cfg.overtime.enabled && inMin !== null && outMin !== null) {
      const worked = outMin - inMin;
      if (worked >= cfg.overtime.minMinutes && (!cfg.overtime.requiresApproval || d.decisions.has("approve_overtime")))
        return { ...r, status: d.holiday ? "holiday" : "off", overtimeMin: d.approvedOvertimeMinutes ?? worked, overtimeOffday: true };
    }
    return { ...r, status: d.holiday ? "holiday" : "off" };
  }
  if (d.leave) return { ...r, status: d.leave === "paid" ? "leave_paid" : "leave_unpaid" };
  if (inMin === null) {
    if (d.decisions.has("excused_paid")) return { ...r, status: "excused_paid" };
    if (d.decisions.has("excused_unpaid")) return { ...r, status: "excused_unpaid" };
    return { ...r, status: "absent" };
  }
  const lateRaw = Math.max(0, inMin - start);
  const lateMin = d.decisions.has("waive_late") ? 0 : penalty(lateRaw, cfg.late.grace, cfg.late.fromStart);
  if (outMin === null) return { ...r, lateMin, missingOut: true };
  const earlyRaw = Math.max(0, end - outMin);
  const earlyMin = d.decisions.has("waive_early") ? 0 : penalty(earlyRaw, cfg.early.grace, cfg.early.fromStart);
  let overtimeMin = 0;
  const after = outMin - end;
  if (cfg.overtime.enabled && after >= cfg.overtime.minMinutes && (!cfg.overtime.requiresApproval || d.decisions.has("approve_overtime")))
    overtimeMin = d.approvedOvertimeMinutes ?? after;
  return { ...r, lateMin, earlyMin, overtimeMin };
}

export interface PayInput {
  basic: string; minorUnits: number; days: DayResult[]; schedule: Schedule; cfg: HrSettings;
  components: { id: string; kind: "earning" | "deduction"; method: "fixed" | "percent_of_basic"; value: string }[];
  loanInstallments: string; shortageOutstanding: string;
}
export interface PayResult {
  dailyRate: string; workDays: number; presentDays: number; absentDays: string; unpaidLeaveDays: string;
  lateMinutes: number; earlyMinutes: number; overtimeMinutes: number;
  earningsComponents: string; overtimePay: string; absenceDeduction: string; lateDeduction: string; earlyDeduction: string;
  earned: string; statutoryDeductions: string; loanRecovery: string; shortageRecovery: string; net: string;
  items: { id: string; kind: "earning" | "deduction"; amount: string }[];
}

/** monthly pay for one employee from the day results (حضوري rules), all money exact and rounded per line */
export function computePay(p: PayInput): PayResult {
  const m = p.minorUnits, cfg = p.cfg;
  const basic = dec(p.basic);
  const employedDays = p.days.filter((d) => d.status !== "not_employed");
  const workDays = p.days.filter((d) => d.workDay).length;
  const daily = cfg.rateMode === "fixed" ? div(basic, dec(cfg.fixedDivisor)) : div(basic, dec(workDays || 26));
  const minute = div(daily, dec(shiftMinutes(p.schedule)));
  let absent = 0n;
  for (const d of p.days) {
    if (d.status === "absent" || d.status === "excused_unpaid" || d.status === "leave_unpaid") absent += S;
    else if (d.missingOut && cfg.missingOut === "half_absent") absent += S / 2n;
  }
  // days before hiring / after leaving are not paid: count their working days as unpaid
  const notEmployedWork = p.days.filter((d) => d.status === "not_employed" && !cfg.weekendDays.includes(weekday(d.date))).length;
  const unpaidLeave = BigInt(p.days.filter((d) => d.status === "leave_unpaid").length) * S;
  const absenceDeduction = round(mul(daily, absent + BigInt(notEmployedWork) * S), m);

  const penaltyOf = (field: "lateMin" | "earlyMin", rule: HrSettings["late"]) => {
    if (rule.mode === "none") return { minutes: 0, amount: 0n };
    const occ = p.days.filter((d) => d[field] > 0);
    const charged = occ.slice(rule.freePerMonth);     // first N occurrences of the month are a warning only
    const minutes = charged.reduce((a, d) => a + d[field], 0);
    return { minutes, amount: mul(mul(minute, dec(minutes)), dec(rule.multiplier)) };
  };
  const late = penaltyOf("lateMin", cfg.late);
  const early = penaltyOf("earlyMin", cfg.early);
  let lateAmt = late.amount, earlyAmt = early.amount;
  const cap = mul(daily, dec(cfg.penaltyCapDays));
  if (cap > 0n && lateAmt + earlyAmt > cap) {               // cap applies to late + early together, pro rata
    const total = lateAmt + earlyAmt;
    lateAmt = div(mul(lateAmt, cap), total);
    earlyAmt = cap - lateAmt;
  }
  const lateDeduction = round(lateAmt, m), earlyDeduction = round(earlyAmt, m);

  let otPay = 0n, otMinutes = 0;
  for (const d of p.days) if (d.overtimeMin > 0) {
    otMinutes += d.overtimeMin;
    otPay += mul(mul(minute, dec(d.overtimeMin)), dec(d.overtimeOffday ? cfg.overtime.offdayMultiplier : cfg.overtime.multiplier));
  }
  const overtimePay = round(otPay, m);

  const items: PayResult["items"] = [];
  let earn = 0n, stat = 0n;
  for (const c of p.components) {
    const amt = round(c.method === "fixed" ? dec(c.value) : div(mul(basic, dec(c.value)), dec(100)), m);
    if (amt === 0n) continue;
    items.push({ id: c.id, kind: c.kind, amount: fmt(amt, m) });
    if (c.kind === "earning") earn += amt; else stat += amt;
  }
  let earned = basic + earn + overtimePay - absenceDeduction - lateDeduction - earlyDeduction;
  if (earned < 0n) earned = 0n;
  // recoveries never push net below zero: statutory first, then loans, then shortages (remainder carries over)
  const statutory = min(stat, earned);
  const loan = min(dec(p.loanInstallments), earned - statutory);
  const shortage = min(dec(p.shortageOutstanding), earned - statutory - loan);
  const net = earned - statutory - loan - shortage;
  return {
    dailyRate: fmt(daily, 6), workDays, presentDays: employedDays.filter((d) => d.status === "present").length,
    absentDays: fmt(absent, 2), unpaidLeaveDays: fmt(unpaidLeave, 2),
    lateMinutes: late.minutes, earlyMinutes: early.minutes, overtimeMinutes: otMinutes,
    earningsComponents: fmt(earn, m), overtimePay: fmt(overtimePay, m), absenceDeduction: fmt(absenceDeduction, m),
    lateDeduction: fmt(lateDeduction, m), earlyDeduction: fmt(earlyDeduction, m), earned: fmt(earned, m),
    statutoryDeductions: fmt(statutory, m), loanRecovery: fmt(loan, m), shortageRecovery: fmt(shortage, m), net: fmt(net, m), items,
  };
}
