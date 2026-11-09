import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { signInAsManager, signInAsManager2 } from "../helpers/auth";
import { syntheticFixtureActorId } from "../helpers/synthetic-property-e2e";

const MANAGER_SCOPE = "axis_portal_inbox_manager_v1";
const threadByPage = new WeakMap<object, { id: string; ownerId: string }>();

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

test("manager reply composer supports resident-thread draft controls at every target width", async ({ page }) => {
  test.skip(process.env.E2E_TESTS_ENABLED !== "1", "Requires the seeded dev/test manager");
  await signInAsManager2(page, "/portal/communication/active");
  const ownerId = await syntheticFixtureActorId(page);
  const id = `msg_${ownerId}_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const residentLabel = `Composer QA ${randomUUID().slice(0, 8)}`;
  const residentEmail = `${residentLabel.toLowerCase().replace(/[^a-z0-9]+/g, "-")}@example.invalid`;
  const created = await page.request.post(`/api/portal-inbox-threads?scope=${MANAGER_SCOPE}`, {
    data: {
      action: "upsert",
      row: {
        id,
        scope: MANAGER_SCOPE,
        folder: "inbox",
        from: residentLabel,
        email: residentEmail,
        subject: "Resident composer layout fixture",
        preview: "No messages yet.",
        unread: false,
        messages: [],
        time: new Date().toISOString(),
      },
    },
  });
  if (!created.ok()) throw new Error(`Owned resident composer fixture creation failed (HTTP ${created.status()}).`);
  threadByPage.set(page, { id, ownerId });
  await page.goto("/portal/communication/active");

  const residentRow = page.locator(".portal-inbox-row").filter({ hasText: residentLabel }).getByRole("button").first();
  // The inbox waits for the conversation list, resident directory and enabled
  // channel sources before exposing rows. Wait for this exact owned thread,
  // while failing promptly on the surface's terminal load error.
  await expect
    .poll(async () => {
      if (await page.getByRole("alert").filter({ hasText: "Could not load conversations." }).count()) return "error";
      if (await residentRow.count()) return "ready";
      return "loading";
    }, { timeout: 45_000 })
    .not.toBe("loading");
  if (await page.getByRole("alert").filter({ hasText: "Could not load conversations." }).count()) {
    throw new Error("Communication inbox failed to load the owned resident composer thread.");
  }
  await expect(residentRow).toBeVisible({ timeout: 10_000 });
  await residentRow.click();

  // A resident conversation opened from Communication is the ORDINARY inbox composer
  // (`InboxComposer`, `dataAttr="inbox-reply"`) — not the record-page direct-chat compose.
  // Keep all controls scoped to its form.
  const composer = page.locator('textarea[data-attr="inbox-reply"]');
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

    // The composer's tools row is Attach · Assistant · Schedule · channel · Send. There is no
    // emoji control any more, so the Assistant menu is what this asserts is reachable at every
    // width — opened and dismissed, never selected: an item there asks a model or drafts a reply.
    await expect(composerForm.getByRole("button", { name: "Insert emoji", exact: true })).toHaveCount(0);
    const assistant = composerForm.locator('[data-attr="inbox-composer-ai-menu"]');
    await expect(assistant).toBeVisible();
    const assistantBox = await assistant.boundingBox();
    const minimumToolSize = width < 768 ? 44 : 28;
    expect(assistantBox?.width ?? 0, `assistant control unavailable at ${width}px`).toBeGreaterThanOrEqual(minimumToolSize);
    await assistant.click();
    await expect(page.locator('[data-attr="inbox-composer-ask-proplane"]')).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-attr="inbox-composer-ask-proplane"]')).toHaveCount(0);
    await expect(composer).toHaveValue("Resident composer reachability check");

    await expect(attachmentInput).toBeAttached();
    const attachmentBox = await attachmentTarget.boundingBox();
    // Declared: `size-7` (28px) from md up, `max-md:size-11` (44px) on a phone.
    expect(attachmentBox?.width ?? 0, `attachment control unavailable at ${width}px`).toBeGreaterThanOrEqual(minimumToolSize);
    const fileChooserPromise = page.waitForEvent("filechooser");
    await attachmentTarget.click();
    await fileChooserPromise;

    await expect(send).toBeEnabled();
    const sendBox = await send.boundingBox();
    // Declared: `size-[30px]` from md up, `max-md:size-11` (44px) on a phone.
    expect(sendBox?.width ?? 0, `send control unavailable at ${width}px`).toBeGreaterThanOrEqual(width < 768 ? 44 : 30);
    // No control in the one-row toolbar may sit on top of another at any width.
    const toolBoxes = await Promise.all([attachmentTarget, assistant, schedule, send].map((control) => control.boundingBox()));
    for (let i = 1; i < toolBoxes.length; i++) {
      const previous = toolBoxes[i - 1];
      const current = toolBoxes[i];
      expect(previous && current, `missing toolbar geometry at ${width}px`).toBeTruthy();
      expect(current!.x, `toolbar controls overlap at ${width}px`).toBeGreaterThanOrEqual(previous!.x + previous!.width - 1);
    }

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

test.afterEach(async ({ page }) => {
  const fixture = threadByPage.get(page);
  if (!fixture) return;
  const actor = await syntheticFixtureActorId(page);
  if (actor !== fixture.ownerId || !fixture.id.startsWith(`msg_${actor}_`)) throw new Error("Resident composer cleanup ownership mismatch.");
  const deleted = await page.request.post(`/api/portal-inbox-threads?scope=${MANAGER_SCOPE}`, {
    data: { action: "delete", id: fixture.id },
  });
  if (!deleted.ok()) throw new Error(`Resident composer fixture cleanup failed (HTTP ${deleted.status()}).`);
  const readback = await page.request.get(`/api/portal-inbox-threads?scope=${MANAGER_SCOPE}`);
  if (!readback.ok()) throw new Error("Resident composer cleanup read failed.");
  const body = await readback.json() as { rows?: Array<{ id?: string }> };
  if ((body.rows ?? []).some((row) => row.id === fixture.id)) throw new Error("Resident composer fixture remained after cleanup.");
  threadByPage.delete(page);
});
