import { expect, type Page } from "@playwright/test";

export const TENANT = "demo-foods";
export const PW = process.env.E2E_DEMO_PASSWORD ?? "Demo!Local2026x";
export const REP_PW = process.env.E2E_REP_PASSWORD ?? PW;

/** collects uncaught page errors so every test can assert there were none */
export function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}

export async function login(page: Page, who: string, password = PW) {
  await page.goto("/login");
  await page.locator("input[autocomplete=organization]").fill(TENANT);
  await page.locator("input[autocomplete=username]").fill(who);   // sign in by username (e-mail also works)
  await page.locator("input[type=password]").fill(password);
  await page.locator("form button.btn.primary").click();
  await expect(page.locator(".sidebar")).toBeAttached();
}

/** waits for a toast containing the text (older toasts may still be on screen) */
export async function expectToast(page: Page, text: string | RegExp = /./) {
  await expect(page.locator(".toast", { hasText: text }).last()).toBeVisible();
}

export const modal = (page: Page) => page.locator(".modal").last();
