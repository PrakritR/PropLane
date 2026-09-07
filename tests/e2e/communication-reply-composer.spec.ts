import { expect, test } from "@playwright/test";
import { signInAsManager } from "../helpers/auth";

test("reply composer stays clickable above phone navigation with a portal banner", async ({ page }) => {
  test.skip(process.env.E2E_TESTS_ENABLED !== "1", "Requires the seeded dev/test manager");
  await signInAsManager(page);
  await page.goto("/portal/communication/active");
  await page.getByRole("button", { name: /^PropLane Assistant / }).click();
  await expect(page).toHaveURL(/\/communication\/active\/agent_notice_/);

  // Exercise a banner independently of the seeded account's work-number state.
  // This occupies real layout space without changing account configuration.
  await page.locator("#portal-main-content").evaluate((main) => {
    const banner = document.createElement("div");
    banner.textContent = "Messaging QA: portal status banner";
    banner.style.cssText = "height:54px;flex-shrink:0";
    main.before(banner);
  });

  const composer = page.getByRole("textbox", { name: "Write a reply…" });
  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await composer.click({ timeout: 5_000 }); // Visibility alone misses nav overlap.
    await expect(composer).toBeFocused();
  }

});
