/**
 * PLAN-0916-1119 — the listing editor saves ONCE, on ✕, never on a typing
 * timer, and a refused save shows one dialog instead of a repeating toast.
 *
 * Drives the real portal against the dev/test project. Skipped unless
 * E2E_TESTS_ENABLED=1 (i.e. `npm run test:seed` has run), like every other
 * portal spec here.
 */
import { test, expect, type Request } from "@playwright/test";
import { createWritableSyntheticManager, cleanupWritableSyntheticManager } from "../helpers/writable-synthetic-manager";

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

  test("typing writes nothing; ✕ writes exactly one draft that reopens with the text", async ({ browser }) => {
    const marker = `Close-save QA ${Date.now()}`;
    const manager = await createWritableSyntheticManager(browser, { properties: 0 });
    const page = manager.page;

    try {
    await page.goto("/portal/properties", { waitUntil: "domcontentloaded" });
    // Open the editor via the primary Create action.
    const createButton = page.locator('[data-attr="manager-properties-add-top"]');
    await expect(createButton).toBeEnabled({ timeout: 30_000 });
    await createButton.click();

    // The current primary action opens the listing editor directly.
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

    let draftId = "";
    try {
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
    const closeResponse = page.waitForResponse((response) => writeCarriesMarker(response.request(), marker), { timeout: 20_000 });
    await page.getByRole("button", { name: /^Close$/ }).click();
    const savedDraft = propertyWriteBody(await closeWrite);
    expect((await closeResponse).ok()).toBe(true);
    draftId = typeof savedDraft?.id === "string" ? savedDraft.id : "";
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
    const planReady = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/manager/subscription" && response.ok(), { timeout: 30_000 });
    await page.goto(`/portal/properties/drafts/${encodeURIComponent(draftId)}/preview`, { waitUntil: "domcontentloaded" });
    await planReady;
    const resume = page.locator('[data-attr="draft-continue-editing"]').filter({ visible: true }).first();
    await expect(resume).toBeVisible({ timeout: 30_000 });
    await resume.click();
    await expect(page.getByPlaceholder("Magnolia House")).toHaveValue(marker, { timeout: 30_000 });
    await page.goto("/portal/properties/drafts", { waitUntil: "domcontentloaded" });
    } finally {
      // Remove only the exact draft this test created, through its normal owner-scoped route.
      const snapshotResponse = await page.request.get("/api/property-records");
      if (!snapshotResponse.ok()) throw new Error("Could not read the owned listing draft for cleanup.");
      const snapshot = await snapshotResponse.json() as {
        snapshot?: { pendingByUser?: Record<string, Array<{ id?: string; buildingName?: string }>> };
      };
      const candidates = (snapshot.snapshot?.pendingByUser?.[manager.actorId] ?? []).filter((row) => row.buildingName === marker);
      if (candidates.length > 1 || (draftId && (candidates.length !== 1 || candidates[0]?.id !== draftId))) {
        throw new Error("Owned draft marker did not resolve to the exact saved row.");
      }
      if (candidates.length === 1) {
        const cleanupId = candidates[0]?.id;
        if (!cleanupId) throw new Error("Owned draft cleanup could not resolve the saved ID.");
        const deleted = await page.request.post("/api/property-records", { data: { action: "delete", id: cleanupId } });
        if (!deleted.ok()) throw new Error(`Owned draft cleanup failed (HTTP ${deleted.status()}).`);
        const afterDelete = await page.request.get("/api/property-records");
        if (!afterDelete.ok()) throw new Error("Could not verify owned draft cleanup.");
        const afterSnapshot = await afterDelete.json() as typeof snapshot;
        if ((afterSnapshot.snapshot?.pendingByUser?.[manager.actorId] ?? []).some((row) => row.id === cleanupId)) throw new Error("Owned draft remained after cleanup.");
      }
    }
    } finally {
      await cleanupWritableSyntheticManager(manager);
    }
  });
});
