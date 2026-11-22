// Key business flows through the screens, each by the role that does it in real life.
import { test, expect } from "@playwright/test";
import { login, modal, expectToast, watchErrors, REP_PW } from "./helpers";

test.describe.configure({ mode: "serial" });

test("sales invoice: sales manager drafts, general manager posts", async ({ browser }) => {
  const s = await browser.newPage(); const errs = watchErrors(s);
  await login(s, "sales");
  await s.goto("/sales/invoices");
  await s.getByRole("button", { name: "فاتورة جديدة" }).or(s.locator(".page-head .btn.primary")).first().click();
  const m = modal(s);
  await m.locator("select").first().selectOption({ label: "DEMO-C003 DEMO موزع الجنوب" });
  await m.locator("tbody tr").first().locator("select").first().selectOption({ label: "DEMO-CHIPS-40 DEMO رقائق بطاطس 40غ" });
  await m.locator("tbody tr").first().locator("input").first().fill("6");
  await m.locator(".btn.primary").click();
  await expect(s.locator(".modal")).toHaveCount(0);
  expect(errs).toEqual([]);
  await s.close();

  const g = await browser.newPage();
  await login(g, "gm");
  await g.goto("/sales/invoices");
  await g.locator("select").filter({ hasText: "مسودة" }).first().selectOption("draft");
  await g.locator("tbody tr").first().click();
  await modal(g).getByRole("button", { name: "ترحيل" }).click();
  await expectToast(g);
  await expect(modal(g).locator(".badge.ok").first()).toBeVisible();
  await g.close();
});

test("quotation → sales order → confirm (stock reserved) → draft invoice", async ({ page }) => {
  const errs = watchErrors(page);
  await login(page, "sales");
  await page.goto("/sales/quotations");
  await page.getByRole("button", { name: "عرض سعر جديد" }).first().click();
  const m = modal(page);
  await m.locator("select").first().selectOption({ label: "DEMO-C001 DEMO سوبرماركت النور" });
  await m.locator("tbody tr").first().locator("select").first().selectOption({ label: "DEMO-CORN-25 DEMO رقائق ذرة 25غ" });
  await m.locator("tbody tr").first().locator("input").first().fill("10");
  await m.locator(".modal-foot .btn.primary, .btn.primary").last().click();
  await expect(page.locator(".modal")).toHaveCount(0);
  await page.locator("tbody tr").first().click();
  await modal(page).getByRole("button", { name: "قَبِل العميل: حوّل إلى أمر بيع" }).click();
  await expectToast(page, "أمر بيع");

  await page.goto("/sales/orders");
  await page.locator("tbody tr").first().click();
  await modal(page).getByRole("button", { name: "تأكيد وحجز الكميات" }).click();
  await expectToast(page, "حُجزت");
  await modal(page).getByRole("button", { name: "فوترة المتبقي" }).click();
  await expectToast(page, "فاتورة مسودة");
  await expect(modal(page).getByText("الفواتير")).toBeVisible();
  expect(errs).toEqual([]);
});

test("purchase order above the threshold: finance manager approves it", async ({ page }) => {
  const errs = watchErrors(page);
  await login(page, "finance");
  await page.goto("/purchasing/orders");
  await page.locator(".page-head select").selectOption("pending_approval");
  await page.locator("tbody tr").first().click();
  await modal(page).getByRole("button", { name: "اعتماد" }).click();
  await expectToast(page, "اعتُمد");
  await expect(modal(page).getByText("معتمد").first()).toBeVisible();
  expect(errs).toEqual([]);
});

test("point of sale: cashier sells from the open shift and closes it (Z report)", async ({ page }) => {
  const errs = watchErrors(page);
  await login(page, "cashier");
  await page.goto("/pos");
  const card = page.locator(".card", { hasText: "DEMO-CHIPS-40" }).first();
  await card.click();
  await card.click();
  await page.getByRole("button", { name: "الدفع", exact: true }).click();
  await modal(page).getByRole("button", { name: "تأكيد البيع" }).click();
  await expect(modal(page).getByText("الإيصال").first()).toBeVisible();
  await modal(page).locator(".btn").first().click();
  await page.getByRole("button", { name: "إقفال الوردية" }).click();
  await modal(page).locator("input").first().fill("0");
  await modal(page).getByRole("button", { name: "إقفال", exact: true }).click();
  await expect(modal(page).getByText("تقرير Z")).toBeVisible();
  expect(errs).toEqual([]);
});

test("production: completed DEMO order and its quality check are visible", async ({ page }) => {
  const errs = watchErrors(page);
  await login(page, "production");
  await page.goto("/manufacturing/orders");
  await expect(page.locator("main.content")).toContainText("DEMO-CHIPS-40");
  await page.goto("/quality/checks");
  await expect(page.locator("main.content")).toContainText("DEMO-L04");
  expect(errs).toEqual([]);
});

test("payroll: HR sees last month's approved run", async ({ page }) => {
  const errs = watchErrors(page);
  await login(page, "hr");
  await page.goto("/hr/payroll");
  await expect(page.locator("main.content")).toContainText(/معتمد|approved|مدفوع/);
  await page.goto("/hr/employees");
  await expect(page.locator("main.content")).toContainText("DEMO مشغل خط");
  expect(errs).toEqual([]);
});

test("field rep: today's route with customers", async ({ page }) => {
  const errs = watchErrors(page);
  await login(page, "rep", REP_PW);
  await page.goto("/field");
  await expect(page.locator("main.content")).toContainText("DEMO سوبرماركت النور");
  expect(errs).toEqual([]);
});

test("reports: trial balance balances and insights open", async ({ page }) => {
  const errs = watchErrors(page);
  await login(page, "accountant");
  await page.goto("/trial-balance");
  await expect(page.locator("main.content")).toContainText(/متوازن|Balanced/);
  await expect(page.locator("main.content")).not.toContainText("غير متوازن");
  await page.goto("/bi");
  await expect(page.locator("main.content .kpi").first()).toBeVisible();
  expect(errs).toEqual([]);
});
