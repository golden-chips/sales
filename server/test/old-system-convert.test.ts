import { describe, it, expect, beforeAll } from "vitest";
import { api, platformToken, createPlan, provision, roleId, createUser } from "./helpers.js";
import { convert, writeXlsx } from "../scripts/old-system/convert.js";

// a small, obviously fake export shaped like the old Firestore collections (see van-sales-app/firestore/DATA_MODEL.md)
const Y = new Date().getUTCFullYear();
const FAKE = {
  van: {
    customers: [
      { id: "c-b", name: "TEST بقالة ب", phone: "+218900000002", status: "approved", creditLimit: 500, createdAt: `${Y - 1}-03-01T08:00:00Z` },
      { id: "c-a", name: "TEST سوبرماركت أ", phone: "+218900000001", status: "approved", creditLimit: null, specialPrices: { "p-1": 1.1 }, createdAt: `${Y - 1}-01-01T08:00:00Z` },
      { id: "c-x", name: "TEST محل محظور", phone: "+218900000001", status: "blacklisted", creditLimit: 900, createdAt: `${Y - 1}-05-01T08:00:00Z` },
    ],
    products: [
      { id: "p-1", name: "TEST رقائق 40غ", price: 1.25, unit: "كيس", barcode: "9990000000011", active: true },
      { id: "p-2", name: "TEST فول سوداني", price: 2, unit: "شوال", barcode: null, active: true },
    ],
    vehicles: [{ id: "v-1", name: "سيارة 1", plateNumber: "5-12345" }],
    reps: [{ id: "r-1", name: "TEST مندوب", phone: "+218900000009", vehicleId: "v-1" }],
    invoices: [
      { id: "i-1", sequenceNumber: 41, customerId: "c-a", vehicleId: "v-1", total: 300.5, amountPaid: 100, paymentMethod: "credit", dueDate: `${Y - 1}-12-30T00:00:00Z`, createdAt: `${Y - 1}-12-01T10:00:00Z` },
      { id: "i-2", sequenceNumber: 42, customerId: "c-b", vehicleId: "v-1", total: 80, amountPaid: 80, paymentMethod: "credit", createdAt: `${Y - 1}-12-02T10:00:00Z` },
      { id: "i-3", sequenceNumber: 43, customerId: "c-b", vehicleId: "v-1", total: 120, amountPaid: 0, paymentMethod: "cash", createdAt: `${Y - 1}-12-03T10:00:00Z` },
      { id: "i-4", sequenceNumber: 44, customerId: "c-b", vehicleId: "v-1", total: 75.25, amountPaid: 0, paymentMethod: "credit", createdAt: `${Y - 1}-12-04T10:00:00Z` },
      { id: "i-5", sequenceNumber: 45, customerId: "c-gone", vehicleId: "v-1", total: 10, amountPaid: 0, paymentMethod: "credit", createdAt: `${Y - 1}-12-05T10:00:00Z` },
    ],
  },
  hr: {
    departments: [{ id: "d-2", name: "TEST الإنتاج", order: 2 }, { id: "d-1", name: "TEST الإدارة", order: 1 }],
    employees: [
      { id: "e-1", code: "17", name: "TEST موظف أ", departmentId: "d-2", hireDate: "2022-04-01", biometricId: "17", active: true },
      { id: "e-2", code: "x-9", name: "TEST موظف ب", departmentId: "d-1", hireDate: "2023-01-15", biometricId: "21", active: true, extraSiteIds: ["s2"] },
      { id: "e-3", code: "30", name: "TEST موظف سابق", departmentId: "d-1", hireDate: "2020-01-01", active: false },
    ],
    employeePrivate: [{ id: "e-1", salary: 1350 }, { id: "e-2", salary: 2100.5 }],
    schedules: [{ id: "s-1", name: "صباحي" }],
  },
};

describe("migration from the old Firebase systems", () => {
  const r = convert(FAKE as any);

  it("converts deterministically, with warnings for what needs a human decision", () => {
    expect(r.files.customers!.map((c) => [c.code, c.name_ar, c.credit_limit])).toEqual([["C0001", "TEST سوبرماركت أ", null], ["C0002", "TEST بقالة ب", 500], ["C0003", "TEST محل محظور", 0]]);
    expect(r.files.items!.map((i) => [i.base_uom, i.sales_price])).toEqual([["BAG", 1.25], ["UNIT", 2]]);   // sorted by Arabic name (ر before ف); unknown unit flagged
    expect(r.files.customer_balances).toEqual([
      { party_code: "C0001", amount: 200.5, document_date: `${Y - 1}-12-01`, due_date: `${Y - 1}-12-30`, reference: "5-12345-41" },
      { party_code: "C0002", amount: 75.25, document_date: `${Y - 1}-12-04`, due_date: `${Y - 1}-12-04`, reference: "5-12345-44" },
    ]);
    expect(r.files.employees!.map((e) => [e.code, e.department_code, e.basic_salary, e.device_pin])).toEqual([["17", "D02", 1350, "17"], ["X-9", "D01", 2100.5, "21"]]);
    const w = r.warnings.join("\n");
    for (const s of ["شوال", "هاتف مكرر", "c-gone", "سعر خاص", "أكثر من موقع", "دوام"]) expect(w).toContain(s);
    expect(r.report.join("\n")).toContain("275.750");
  });

  describe("the converted files import cleanly and reconcile", () => {
    let T: any, FIN: any;
    const imp = async (kind: any, who: any) => api("POST", `/api/v1/import/${kind}`, { companyId: T.companyId, fileBase64: (await writeXlsx(kind, r.files[kind as keyof typeof r.files]!)).toString("base64"),
      commit: true, date: `${Y}-01-01` }, { token: who.token });
    beforeAll(async () => {
      const p = await platformToken();
      T = await provision(p, (await createPlan(p, { modules: ["accounting", "sales", "inventory", "hr", "payroll"] })).code);
      await api("POST", "/api/v1/accounting/accounts/seed-template", { companyId: T.companyId }, { token: T.token });
      await api("POST", "/api/v1/accounting/fiscal-years", { companyId: T.companyId, name: `FY${Y}`, startDate: `${Y}-01-01` }, { token: T.token });
      FIN = await createUser(T, [{ roleId: await roleId(T.token, "finance_manager") }]);
    });
    it("customers, items, employees, opening debts → posted by another user → ageing and GL agree", async () => {
      for (const k of ["customers", "items", "employees", "customer_balances"]) {
        const res = (await imp(k, T)).body;
        expect([k, res.committed, res.issueCount]).toEqual([k, true, 0]);
      }
      const posted = (await api("POST", "/api/v1/go-live/opening-documents/post", { companyId: T.companyId, cutoverDate: `${Y}-01-01` }, { token: FIN.token })).body;
      expect(posted.receivablesTotal).toBe("275.7500");
      const aging = (await api("GET", `/api/v1/sales/ar-aging?companyId=${T.companyId}&asOf=${Y}-01-31`, undefined, { token: FIN.token })).body;
      expect(aging.rows.map((x: any) => [x.code, x.total])).toEqual([["C0001", "200.5000"], ["C0002", "75.2500"]]);
      const rec = (await api("GET", `/api/v1/go-live/reconciliation?companyId=${T.companyId}`, undefined, { token: T.token })).body;
      expect(rec.balanced).toBe(true);
      const emps = (await api("GET", `/api/v1/hr/employees?companyId=${T.companyId}`, undefined, { token: T.token })).body;
      const list = emps.data ?? emps;
      expect(list.map((e: any) => e.code).sort()).toEqual(["17", "X-9"]);
      // re-importing employees without the salary column never wipes salaries
      const noSalary = r.files.employees!.map(({ basic_salary, ...rest }) => rest);
      const res = (await api("POST", "/api/v1/import/employees", { companyId: T.companyId, fileBase64: (await writeXlsx("employees", noSalary.map((x) => ({ ...x })))).toString("base64"), commit: true }, { token: T.token })).body;
      expect([res.updates, res.creates]).toEqual([2, 0]);
    });
  });
});
