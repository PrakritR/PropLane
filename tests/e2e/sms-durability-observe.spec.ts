import { expect, test } from "@playwright/test";
import { signInAsManager } from "../helpers/auth";

test("two original SMS SIDs remain one Communication conversation", async ({ page }) => {
  test.skip(process.env.SMS_DURABILITY_FLAG_OFF === "1", "SMS projection rows are deliberately hidden when the UI flag is off");
  await signInAsManager(page);
  await page.context().addCookies([{ name: "proplane-workspace", value: "9c386a60-5622-4d1d-ae62-8a5a2a268102", url: new URL(page.url()).origin }]);
  await page.goto("/portal/communication/active", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".portal-inbox-row").first()).toBeVisible({ timeout: 30000 });
  const response = await page.request.get("/api/manager/sms-conversations");
  const body = await response.json();
  expect(response.status()).toBe(200);
  const matches = (body.residents ?? []).filter((resident: { phone?: string }) => resident.phone === "+15550009251");
  expect(matches).toHaveLength(1);
  const id = matches[0].projectionId;
  expect(id).toBeTruthy();
  const detailResponse = await page.request.get(`/api/manager/sms-conversations/${id}`);
  expect(detailResponse.status()).toBe(200);
  const detail = await detailResponse.json();
  const originals = detail.messages.filter((message: { messageSid?: string }) => message.messageSid?.startsWith("SMsmsdurabilityfixture"));
  expect(originals.map((message: { messageSid: string }) => message.messageSid).sort()).toEqual([
    "SMsmsdurabilityfixturea20260925", "SMsmsdurabilityfixtureb20260925",
  ]);
  expect(originals.map((message: { body: string }) => message.body.length).sort((a: number, b: number) => a - b)).toEqual([34, 35]);
  await expect(page.locator(".portal-inbox-row").filter({ hasText: "Durability fixture" })).toHaveCount(1);
  await page.locator(".portal-inbox-row").filter({ hasText: "Durability fixture" }).click();
  const detailPane = page.locator(".portal-inbox-thread-pane");
  await expect(detailPane.getByText(originals[0].body, { exact: true })).toBeVisible({ timeout: 30000 });
  await expect(detailPane.getByText(originals[1].body, { exact: true })).toBeVisible({ timeout: 30000 });
  await page.screenshot({ path: "output/playwright/sms-durability-after.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(detailPane.getByText(originals[0].body, { exact: true })).toBeVisible();
  await expect(detailPane.getByText(originals[1].body, { exact: true })).toBeVisible();
  await page.screenshot({ path: "output/playwright/sms-durability-mobile-after.png", fullPage: true });
});

test("Communication loads with the SMS UI flag off", async ({ page }) => {
  test.skip(process.env.SMS_DURABILITY_FLAG_OFF !== "1", "Requires a task server started with SMS_COMM_UI_ENABLED=0");
  await signInAsManager(page);
  await page.context().addCookies([{ name: "proplane-workspace", value: "9c386a60-5622-4d1d-ae62-8a5a2a268102", url: new URL(page.url()).origin }]);
  await page.goto("/portal/communication/active", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Communication", { exact: true }).first()).toBeVisible({ timeout: 30000 });
  await expect(page.locator(".portal-inbox-row").first()).toBeVisible({ timeout: 30000 });
  const fixtureRow = page.locator(".portal-inbox-row").filter({ hasText: "Durability fixture" });
  await expect(fixtureRow).toHaveCount(1);
  const response = await page.request.get("/api/manager/sms-conversations");
  expect(response.status()).toBe(200);
  const residents = (await response.json()).residents ?? [];
  const id = residents.find((resident: { phone?: string }) => resident.phone === "+15550009251")?.projectionId;
  expect(id).toBeTruthy();
  const detail = await (await page.request.get(`/api/manager/sms-conversations/${id}`)).json();
  const originals = detail.messages.filter((message: { messageSid?: string }) => message.messageSid?.startsWith("SMsmsdurabilityfixture"));
  await fixtureRow.click();
  const detailPane = page.locator(".portal-inbox-thread-pane");
  await expect(detailPane.getByText(originals[0].body, { exact: true })).toBeVisible({ timeout: 30000 });
  await expect(detailPane.getByText(originals[1].body, { exact: true })).toBeVisible({ timeout: 30000 });
  await page.screenshot({ path: "output/playwright/sms-durability-flag-off.png", fullPage: true });
});
