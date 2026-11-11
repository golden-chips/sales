import { describe, it, expect } from "vitest";
import { computeDay, computePay, dec, fmt, type HrSettings, type DayInput } from "../src/modules/hr/engine.js";

// حضوري defaults
const cfg: HrSettings = {
  weekendDays: [5], rateMode: "workdays", fixedDivisor: 30,
  late: { grace: 10, fromStart: true, mode: "minutes", multiplier: "1", freePerMonth: 2 },
  early: { grace: 5, fromStart: true, mode: "minutes", multiplier: "1", freePerMonth: 1 },
  penaltyCapDays: "5", overtime: { enabled: true, requiresApproval: true, minMinutes: 30, multiplier: "1.5", offdayMultiplier: "2" },
  missingOut: "flag_only", dedupMin: 3,
};
const sch = { start: "08:00", end: "16:00", breakMinutes: 0 };   // 480 minutes
const H = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
const day = (date: string, punches: string[], extra: Partial<DayInput> = {}): DayInput =>
  ({ date, punches: punches.map(H), holiday: false, leave: null, decisions: new Set(), employed: true, ...extra });

describe("attendance engine (حضوري rules)", () => {
  it("fixed-point money helpers are exact", () => {
    expect(fmt(dec("0.1") + dec("0.2"), 3)).toBe("0.300");
    expect(fmt(dec("1.0005"), 3)).toBe("1.001");   // half-up
    expect(fmt(dec("-2.5"), 0)).toBe("-3");
  });

  it("lateness: within grace = 0; beyond grace counts from shift start", () => {
    expect(computeDay(day("2026-03-02", ["08:10", "16:00"]), sch, cfg).lateMin).toBe(0);
    expect(computeDay(day("2026-03-02", ["08:11", "16:00"]), sch, cfg).lateMin).toBe(11);
    expect(computeDay(day("2026-03-02", ["08:11", "16:00"]), sch, { ...cfg, late: { ...cfg.late, fromStart: false } }).lateMin).toBe(1);
  });

  it("early leave, missing out, duplicate punches, absence, weekend", () => {
    expect(computeDay(day("2026-03-02", ["08:00", "15:50"]), sch, cfg).earlyMin).toBe(10);
    const mo = computeDay(day("2026-03-02", ["08:00", "08:02"]), sch, cfg);   // 2 punches within dedup → one punch
    expect([mo.missingOut, mo.outMin]).toEqual([true, null]);
    expect(computeDay(day("2026-03-02", []), sch, cfg).status).toBe("absent");
    expect(computeDay(day("2026-03-06", []), sch, cfg).status).toBe("off");   // Friday
    expect(computeDay(day("2026-03-02", [], { decisions: new Set(["excused_paid"]) }), sch, cfg).status).toBe("excused_paid");
  });

  it("overtime only with approval and above the minimum; day off at the off-day rate", () => {
    expect(computeDay(day("2026-03-02", ["08:00", "17:00"]), sch, cfg).overtimeMin).toBe(0);  // not approved
    expect(computeDay(day("2026-03-02", ["08:00", "17:00"], { decisions: new Set(["approve_overtime"]) }), sch, cfg).overtimeMin).toBe(60);
    expect(computeDay(day("2026-03-02", ["08:00", "16:20"], { decisions: new Set(["approve_overtime"]) }), sch, cfg).overtimeMin).toBe(0); // < 30
    const fri = computeDay(day("2026-03-06", ["09:00", "13:00"], { decisions: new Set(["approve_overtime"]) }), sch, cfg);
    expect([fri.overtimeMin, fri.overtimeOffday]).toEqual([240, true]);
  });

  it("night shift crossing midnight", () => {
    const night = { start: "22:00", end: "06:00", breakMinutes: 0 };
    const r = computeDay(day("2026-03-02", ["22:20", "29:55"]), night, cfg);   // 05:55 next day = 29:55
    expect([r.lateMin, r.earlyMin]).toEqual([20, 0]); // 5 min early is within the 5-min grace
  });
});

describe("pay engine", () => {
  // March 2026: 31 days, Fridays 6/13/20/27 → 27 working days
  const month = Array.from({ length: 31 }, (_, i) => `2026-03-${String(i + 1).padStart(2, "0")}`);
  const run = (punchesFor: (d: string) => string[], extra: Partial<Parameters<typeof computePay>[0]> = {}, decisions: Record<string, string[]> = {}) => {
    const days = month.map((d) => computeDay(day(d, punchesFor(d), { decisions: new Set(decisions[d] ?? []) }), sch, cfg));
    return computePay({ basic: "1350", minorUnits: 3, days, schedule: sch, cfg, components: [], loanInstallments: "0", shortageOutstanding: "0", ...extra });
  };
  const full = (d: string) => (new Date(`${d}T12:00:00Z`).getUTCDay() === 5 ? [] : ["08:00", "16:00"]);

  it("full month: daily rate = basic / working days; net = basic", () => {
    const p = run(full);
    expect([p.workDays, p.dailyRate, p.net]).toEqual([27, "50.000000", "1350.000"]);
  });

  it("absence and late with free occurrences and minute rate", () => {
    const p = run((d) => {
      if (d === "2026-03-02") return [];                         // absent → 50
      if (["2026-03-03", "2026-03-04", "2026-03-05"].includes(d)) return ["08:30", "16:00"]; // 3 lates of 30 min, first 2 free
      return full(d);
    });
    // minute rate = 50 / 480 = 0.104166…; charged late = 30 min → 3.125
    expect([p.absenceDeduction, p.lateMinutes, p.lateDeduction, p.net]).toEqual(["50.000", 30, "3.125", "1296.875"]);
  });

  it("penalty cap: late + early deductions never exceed 5 days' pay", () => {
    const p = run((d) => (full(d).length ? ["11:00", "13:00"] : []));   // 180 late + 180 early every day
    expect(Number(p.lateDeduction) + Number(p.earlyDeduction)).toBeCloseTo(250, 3);   // 5 × 50
  });

  it("approved overtime ×1.5, components, statutory, loan and shortage recovery never below zero", () => {
    const p = run(full, {
      components: [{ id: "HOUSE", kind: "earning", method: "fixed", value: "150" }, { id: "SOC", kind: "deduction", method: "percent_of_basic", value: "3.75" }],
      loanInstallments: "100", shortageOutstanding: "5000",
    });
    // earned = 1350 + 150 = 1500; statutory 3.75% × 1350 = 50.625; loan 100; shortage capped to the rest
    expect([p.earned, p.statutoryDeductions, p.loanRecovery, p.shortageRecovery, p.net]).toEqual(["1500.000", "50.625", "100.000", "1349.375", "0.000"]);
    const ot = run((d) => (d === "2026-03-02" ? ["08:00", "18:00"] : full(d)), {}, { "2026-03-02": ["approve_overtime"] });
    expect([ot.overtimeMinutes, ot.overtimePay]).toEqual([120, "18.750"]);   // 120 × 0.104166… × 1.5
  });
});
