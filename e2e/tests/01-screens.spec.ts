// Every screen in the navigation opens without a crash, shows content and no error box.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { login, watchErrors } from "./helpers";

// the route list is read from the app's own navigation, so new screens are covered automatically
const nav = readFileSync(new URL("../../web/src/nav.tsx", import.meta.url), "utf8");
const routes = ["/", ...new Set([...nav.matchAll(/to: "(\/[^"]+)"/g)].map((m) => m[1]))];

test("every screen opens for the general manager", async ({ page }) => {
  test.setTimeout(routes.length * 15_000);
  const errors = watchErrors(page);
  await login(page, "gm");
  const problems: string[] = [];
  for (const r of routes) {
    await page.goto(r);
    await page.waitForLoadState("networkidle");
    const content = page.locator("main.content");
    await expect(content, r).toBeVisible();
    const text = (await content.innerText()).trim();
    if (text.length < 10) problems.push(`${r}: empty`);
    const bad = page.locator("main.content .alert.bad");
    if (await bad.count()) problems.push(`${r}: ${(await bad.first().innerText()).slice(0, 160)}`);
  }
  expect(problems, problems.join("\n")).toEqual([]);
  expect(errors).toEqual([]);
});

const ROLES = ["accountant", "finance", "sales", "warehouse", "production", "quality", "hr", "cashier", "possup", "maintenance", "service", "projects"];
for (const role of ROLES) {
  test(`${role}: home page and own menu work`, async ({ page }) => {
    const errors = watchErrors(page);
    await login(page, role);
    await expect(page.locator("main.content")).not.toBeEmpty();
    // open every screen this role sees in its sidebar (expanding groups)
    const groups = page.locator(".nav-group-btn");
    for (let i = 0; i < await groups.count(); i++) if ((await groups.nth(i).getAttribute("aria-expanded")) !== "true") await groups.nth(i).click();
    const links = await page.locator(".side-nav a.nav-link").evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).getAttribute("href")!));
    expect(links.length).toBeGreaterThan(1);
    const problems: string[] = [];
    for (const href of links) {
      await page.goto(href);
      await page.waitForLoadState("networkidle");
      const bad = page.locator("main.content .alert.bad");
      if (await bad.count()) problems.push(`${href}: ${(await bad.first().innerText()).slice(0, 160)}`);
    }
    expect(problems, problems.join("\n")).toEqual([]);
    expect(errors).toEqual([]);
  });
}
