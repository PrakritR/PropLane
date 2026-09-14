import { expect, test } from "@playwright/test";
import { signInAsManager } from "../helpers/auth";

test("assistant reply composer stays clickable above phone navigation with a portal banner", async ({ page }) => {
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
  await expect(page.getByRole("checkbox", { name: "Schedule for later", exact: true })).toHaveCount(0);
  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await composer.click({ timeout: 5_000 }); // Visibility alone misses nav overlap.
    await expect(composer).toBeFocused();

    // The assistant has no scheduling controls by design. This test keeps the
    // existing layout regression focused on its banner and normal click path.
    const composerBox = await composer.boundingBox();
    expect(composerBox?.width ?? 0, `textarea too narrow at ${width}px`).toBeGreaterThan(140);
    await composer.fill("");
  }
});

test("resident reply composer supports draft controls at every target width", async ({ page }) => {
  test.skip(process.env.E2E_TESTS_ENABLED !== "1", "Requires the seeded dev/test manager");
  await signInAsManager(page);
  await page.goto("/portal/communication/active");

  const conversationLabel = process.env.E2E_INBOX_RESIDENT_LABEL?.trim() || "Test Resident";
  const residentRow = page.locator(".portal-inbox-row").filter({ hasText: conversationLabel }).getByRole("button").first();
  await expect(residentRow).toBeVisible();
  await residentRow.click();

  // This is the actual compose prefix rendered by the manager's ordinary
  // resident detail thread. Keep all controls scoped to its form.
  const composer = page.locator('textarea[data-attr="resident-direct-chat-compose"]');
  const composerForm = composer.locator("xpath=ancestor::form");
  await expect(composer).toBeVisible();
  const send = composerForm.getByRole("button", { name: "Send", exact: true });
  const schedule = composerForm.locator('[data-attr="inbox-thread-schedule-later"]');
  const attachmentInput = composerForm.locator('input[type="file"]');
  const attachmentTarget = attachmentInput.locator("xpath=ancestor::label");

  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await composer.click({ timeout: 5_000 });
    await expect(composer).toBeFocused();
    // A retained local draft must not make the disabled-state assertion pass.
    await composer.fill("");
    await expect(send).toBeDisabled();

    const composerBox = await composer.boundingBox();
    expect(composerBox?.width ?? 0, `textarea too narrow at ${width}px`).toBeGreaterThan(140);
    await composer.fill("Resident composer reachability check");

    const emoji = composerForm.getByRole("button", { name: "Insert emoji", exact: true });
    if (width < 768) {
      await expect(emoji).toBeHidden();
    } else {
      await expect(emoji).toBeVisible();
      const emojiBox = await emoji.boundingBox();
      expect(emojiBox?.width ?? 0, `emoji control unavailable at ${width}px`).toBeGreaterThanOrEqual(32);
      await emoji.click();
      const emojiMenu = page.getByRole("menu", { name: "Insert emoji" });
      await expect(emojiMenu).toBeVisible();
      await emojiMenu.getByRole("menuitem").first().click();
      await expect(composer).toHaveValue("Resident composer reachability check👍");
    }

    await expect(attachmentInput).toBeAttached();
    const attachmentBox = await attachmentTarget.boundingBox();
    const minimumAttachmentSize = width < 768 ? 36 : 40;
    expect(attachmentBox?.width ?? 0, `attachment control unavailable at ${width}px`).toBeGreaterThanOrEqual(minimumAttachmentSize);
    const fileChooserPromise = page.waitForEvent("filechooser");
    await attachmentTarget.click();
    await fileChooserPromise;

    await expect(send).toBeEnabled();
    const sendBox = await send.boundingBox();
    expect(sendBox?.width ?? 0, `send control unavailable at ${width}px`).toBeGreaterThanOrEqual(40);

    await expect(schedule).toBeVisible();
    await schedule.click();
    const sendAt = page.getByRole("textbox", { name: "Send date and time", exact: true });
    await expect(sendAt).toBeVisible();
    await sendAt.fill("2026-12-31T12:00");
    await expect(sendAt).toHaveValue("2026-12-31T12:00");
    await page.getByRole("menuitem", { name: "Send at this time", exact: true }).click();
    await expect(schedule).toHaveAttribute("aria-pressed", "true");
    // The desktop dropdown animates out after its selection state changes.
    // Reopen only after that menu has unmounted.
    await expect(sendAt).toHaveCount(0);
    await schedule.click();
    await page.getByRole("menuitem", { name: "Send now instead", exact: true }).click();
    await expect(schedule).toHaveAttribute("aria-pressed", "false");
    await expect(sendAt).toHaveCount(0);

    // Clear both message and schedule state without submitting or selecting a file.
    await composer.fill("");
    await expect(send).toBeDisabled();
  }

});
