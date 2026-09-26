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

type PropertyWrite = {
  id?: unknown;
  rowData?: unknown;
  propertyData?: unknown;
};

function propertyWriteBody(request: Request): PropertyWrite | null {
  if (!isPropertyWrite(request)) return null;
  try {
    const body: unknown = request.postDataJSON();
    return body && typeof body === "object" && !Array.isArray(body)
      ? body as PropertyWrite
      : null;
  } catch {
    return null;
  }
}

function writeCarriesMarker(request: Request, marker: string): boolean {
  const body = propertyWriteBody(request);
  return body ? JSON.stringify(body).includes(marker) : false;
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
    await page.locator('[data-attr="manager-properties-add-property"]').click();

    // The property-name field is the editor's first text input.
    const nameField = page.getByPlaceholder("Magnolia House");
    await expect(nameField).toBeVisible({ timeout: 20_000 });

    // Capture parsed writes. The Properties page also mirrors previously cached
    // rows in the background, so this test attributes writes to this draft by
    // its unique marker and then by the exact id minted for that marker.
    const writes: PropertyWrite[] = [];
    page.on("request", (request) => {
      const body = propertyWriteBody(request);
      if (body) writes.push(body);
    });

    // Type, then wait well past the old 2s debounce — nothing must be sent.
    await nameField.fill(marker);
    await page.waitForTimeout(5_000);
    expect(
      writes.filter((write) => JSON.stringify(write).includes(marker)),
      "typing must not write this draft on a timer",
    ).toHaveLength(0);

    // ✕ writes exactly one draft, then closes.
    const closeWrite = page.waitForRequest(
      (request) => writeCarriesMarker(request, marker),
      { timeout: 20_000 },
    );
    await page.getByRole("button", { name: /^Close$/ }).click();
    const savedDraft = propertyWriteBody(await closeWrite);
    const draftId = typeof savedDraft?.id === "string" ? savedDraft.id : "";
    expect(draftId, "close write must carry the persisted draft id").not.toBe("");
    await expect(nameField).not.toBeVisible();
    // Give any (unwanted) extra writes a moment to arrive, then assert one.
    await page.waitForTimeout(1_500);
    expect(
      writes.filter(
        (write) => write.id === draftId || JSON.stringify(write).includes(marker),
      ),
      "✕ must write the exact draft id once",
    ).toHaveLength(1);

    // The draft is in Drafts, carrying the text that was typed.
    await page.goto("/portal/properties/drafts", { waitUntil: "domcontentloaded" });
    await expect(page.getByText(marker).first()).toBeVisible({ timeout: 30_000 });
  });
});
