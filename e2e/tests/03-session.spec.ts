// Sign-in session (0.9, K1): the refresh token lives in an httpOnly cookie that page scripts cannot read;
// a reload or a new tab of the same browser stays signed in; signing out ends it everywhere.
import { test, expect } from "@playwright/test";
import { login } from "./helpers";

test("session: refresh token not readable by scripts; reload and new tab stay signed in; sign-out ends it", async ({ context, page }) => {
  await login(page, "gm");
  const stored = await page.evaluate(() => sessionStorage.getItem("ge.session") ?? "");
  expect(stored).not.toMatch(/refreshToken/);
  expect(await page.evaluate(() => document.cookie)).not.toMatch(/ge_rt=/);       // httpOnly
  const rt = (await context.cookies()).find((c) => c.name === "ge_rt");
  expect(rt?.httpOnly).toBe(true);
  expect(rt?.sameSite).toBe("Strict");

  // the access token is gone (e.g. expired): the app renews it from the cookie on its own
  await page.evaluate(() => sessionStorage.removeItem("ge.session"));
  await page.reload();
  await expect(page.locator(".sidebar")).toBeAttached();

  // a new tab of the same browser opens signed in
  const tab = await context.newPage();
  await tab.goto("/");
  await expect(tab.locator(".sidebar")).toBeAttached();

  // signing out: a fresh tab must show the sign-in page
  await page.evaluate(async () => { await fetch("/api/v1/auth/logout", { method: "POST", headers: { authorization: `Bearer ${JSON.parse(sessionStorage.getItem("ge.session")!).accessToken}`, "content-type": "application/json" }, body: "{}" }); });
  const after = await context.newPage();
  await after.goto("/");
  await expect(after.locator("input[type=password]")).toBeVisible();
});
