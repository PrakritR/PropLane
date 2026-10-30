/** Dedicated, reviewed split-B proof only; post-stop cleanup is separate. */
import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { signInAsManager } from "../helpers/auth";
import { persistSplitBManifest, preflightSplitBDraftOnDev, type SplitBDraftManifest } from "../helpers/split-b-draft-proof";

test("canonical manager saves one private draft", async ({ page }) => {
  test.skip(process.env.SPLIT_B_DEDICATED_RUNNER !== "1", "Dedicated split-B proof required");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const managerId = process.env.SPLIT_B_MANAGER_ID, workspaceId = process.env.SPLIT_B_WORKSPACE_ID, dir = process.env.SPLIT_B_PRIVATE_DIR;
  if (url !== "https://emstjswhotsnyksqhqyf.supabase.co" || !serviceKey || !managerId || !workspaceId || !dir || !path.isAbsolute(dir)) throw new Error("Exact DEV fixture and private directory required.");
  const db = createClient(url, serviceKey, { auth: { persistSession: false } });
  const marker = `split-b-${randomUUID()}`;
  const file = path.join(dir, "split-b-manifest.json");
  let manifest: SplitBDraftManifest | null = null;
  await signInAsManager(page);
  await page.goto("/portal/properties", { waitUntil: "domcontentloaded" });
  await page.route("**/api/property-records", async (route) => {
    const request = route.request();
    if (request.method() !== "POST") { await route.continue(); return; }
    const body = request.postDataJSON() as { action?: unknown; status?: unknown; id?: unknown; managerUserId?: unknown; rowData?: unknown };
    if (manifest || body.status !== "draft" || typeof body.id !== "string" || body.managerUserId !== managerId || !JSON.stringify(body.rowData).includes(marker)) { await route.abort(); return; }
    const candidate: SplitBDraftManifest = { managerId, workspaceId, propertyId: body.id, marker, state: "reserved" };
    await preflightSplitBDraftOnDev(candidate, "absent");
    persistSplitBManifest(file, candidate);
    manifest = candidate;
    await route.continue();
  });
  await page.locator('[data-attr="manager-properties-add-top"]').click();
  await page.locator('[data-attr="manager-properties-add-property"]').click();
  await page.getByPlaceholder("Magnolia House").fill(marker);
  const saved = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/property-records" && response.request().postData()?.includes(marker) === true, { timeout: 20000 });
  await page.getByRole("button", { name: /^Close$/ }).click();
  expect((await saved).ok()).toBeTruthy();
  if (!manifest) throw new Error("Draft request was not captured.");
  const captured: SplitBDraftManifest = manifest;
  const row = await db.from("manager_property_records").select("updated_at").eq("id", captured.propertyId).eq("manager_user_id", managerId).eq("workspace_id", workspaceId).eq("status", "draft").single();
  if (row.error || typeof row.data?.updated_at !== "string") throw new Error("Draft revision unavailable.");
  captured.updatedAt = row.data.updated_at; captured.state = "saved"; persistSplitBManifest(file, captured);
  await preflightSplitBDraftOnDev(captured, "draft");
  await page.goto("/portal/properties/drafts");
  await expect(page.getByText(marker).first()).toBeVisible();
});
