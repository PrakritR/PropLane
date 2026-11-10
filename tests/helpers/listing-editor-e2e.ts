import { expect, type Locator, type Page } from "@playwright/test";

/** Fill the real Basics controls used by the current listing workspace with a synthetic home. */
export async function fillSyntheticListingBasics(page: Page | Locator, buildingName: string) {
  const house = page.locator('[data-attr="listing-v2-kind-house"]');
  await expect(house).toBeVisible();
  if (await house.getAttribute("aria-pressed") !== "true") await house.click();

  const wholePlace = page.locator('[data-attr="listing-v2-rent-model-entire"]');
  await expect(wholePlace).toBeVisible();
  if (await wholePlace.getAttribute("aria-pressed") !== "true") await wholePlace.click();

  const name = page.getByPlaceholder("Magnolia House");
  await expect(name).toBeVisible();
  await name.fill(buildingName);

  const address = page.locator('input[autocomplete="street-address"]');
  await address.fill("400 Broad St");
  await page.locator('[data-wizard-field="city"]').fill("Seattle");
  await page.locator('[data-wizard-field="state"]').fill("WA");
  await page.locator('[data-wizard-field="zip"]').fill("98109");

  const description = page.getByPlaceholder(/Describe the home and who it suits/);
  await description.fill("Synthetic QA listing used for an application workflow check. No property photos are supplied.");
}
