import { expect, type Page } from "@playwright/test";

/** Walk through post-signup manager gates until the portal is reachable. */
export async function reachManagerPortal(page: Page) {
  if (page.url().includes("/auth/manager/choose-plan")) {
    await page.locator('[data-attr="manager-entry-plan-skip"]').click();
    await page.waitForURL(/\/auth\/connect-google-services|\/portal/, { timeout: 60_000 });
  }

  if (page.url().includes("/auth/connect-google-services")) {
    // One button now: "Skip for now" and "Enter portal" both marked the step
    // seen and went to the portal, so they collapsed into Continue.
    const continueBtn = page.locator('[data-attr="onboarding-google-services-continue"]');
    await expect(continueBtn).toBeEnabled({ timeout: 30_000 });
    await Promise.all([page.waitForURL(/\/portal/, { timeout: 60_000 }), continueBtn.click()]);
  }

  if (page.url().includes("/auth/choose-portal")) {
    await page.getByRole("button", { name: /^Property\b/ }).click();
    await page.waitForURL(/\/portal/, { timeout: 30_000 });
  }

  if (!page.url().includes("/portal")) {
    throw new Error(`Expected manager portal after onboarding; at ${page.url()}`);
  }
  await expect(page).toHaveURL(/\/portal/, { timeout: 30_000 });
}

/** After account creation, pick the property-manager path and clear onboarding gates. */
export async function completeManagerSignupOnboarding(page: Page) {
  if (page.url().includes("/auth/get-started")) {
    await Promise.all([
      page.waitForURL(/\/auth\/manager\/choose-plan|\/auth\/connect-google-services|\/portal/, {
        timeout: 60_000,
      }),
      page.getByRole("button", { name: /set up as a property manager/i }).click(),
    ]);
  }
  await reachManagerPortal(page);
}

export async function pickListingSelect(page: Page, ariaLabel: string, optionName: string | RegExp) {
  const trigger = page.getByRole("button", { name: ariaLabel, exact: true });
  await trigger.click();
  const option = page.getByRole("option", { name: optionName, exact: true }).filter({ visible: true }).first();
  await expect(option).toBeVisible({ timeout: 10_000 });
  await option.click();
}
