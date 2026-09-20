/**
 * PLAN-0916-1119 — the listing editor saves ONCE, on ✕, never on a typing
 * timer, and a refused save shows one dialog instead of a repeating toast.
 *
 * Drives the real portal against the dev/test project. Skipped unless
 * E2E_TESTS_ENABLED=1 (i.e. `npm run test:seed` has run), like every other
 * portal spec here.
 */
import { test, expect, type Request } from "@playwright/test";
import { signInAsManager } from "../helpers/auth";

const enabled = process.env.E2E_TESTS_ENABLED === "1";

/** Every write the editor makes goes through POST /api/property-records. */
function isPropertyWrite(request: Request): boolean {
  return (
    request.method() === "POST" &&
    new URL(request.url()).pathname === "/api/property-records"
  );
}

test.describe("listing editor — save on close, no typing timer", () => {
  test.skip(!enabled, "Set E2E_TESTS_ENABLED=1 after running npm run test:seed");

  test("typing writes nothing; ✕ writes exactly one draft that reopens with the text", async ({
    page,
  }) => {
    const marker = `Close-save QA ${Date.now()}`;

    await signInAsManager(page);
    await page.goto("/portal/properties", { waitUntil: "domcontentloaded" });

    // Open the editor via the primary Create action.
    const createButton = page.locator('[data-attr="manager-properties-add-top"]');
    await expect(createButton).toBeEnabled({ timeout: 30_000 });
    await createButton.click();

    // The property-name field is the editor's first text input.
    const nameField = page.getByPlaceholder("Magnolia House");
    await expect(nameField).toBeVisible({ timeout: 20_000 });

    // Count every write from now on.
    const writes: string[] = [];
    page.on("request", (request) => {
      if (isPropertyWrite(request)) writes.push(request.url());
    });

    // Type, then wait well past the old 2s debounce — nothing must be sent.
    await nameField.fill(marker);
    await page.waitForTimeout(5_000);
    expect(writes, "typing must not write on a timer").toHaveLength(0);

    // ✕ writes exactly one draft, then closes.
    const closeWrite = page.waitForRequest(isPropertyWrite, { timeout: 20_000 });
    await page.getByRole("button", { name: /^Close$/ }).click();
    await closeWrite;
    // Give any (unwanted) extra writes a moment to arrive, then assert one.
    await page.waitForTimeout(1_500);
    expect(writes, "✕ must write exactly one draft").toHaveLength(1);

    // The draft is in Drafts, carrying the text that was typed.
    await page.goto("/portal/properties/drafts", { waitUntil: "domcontentloaded" });
    await expect(page.getByText(marker).first()).toBeVisible({ timeout: 30_000 });
  });
});
