import type { Page } from "@playwright/test";

/**
 * Navigate to the real Properties document, then read the authenticated manager plan.
 * Callers still verify the actual Add control is enabled before using it.
 */
export async function navigateToPropertiesAndReadPlan(page: Page, documentPath = "/portal/properties") {
  if (!documentPath.startsWith("/portal/properties")) throw new Error("Manager plan read requires a Properties document path.");
  const documentResponse = await page.goto(documentPath, { waitUntil: "domcontentloaded", timeout: 45_000 });
  if (!documentResponse || !documentResponse.ok()) {
    throw new Error(`Properties document navigation failed (HTTP ${documentResponse?.status() ?? "no response"}).`);
  }

  const planResponse = await page.request.get("/api/manager/subscription", { timeout: 30_000 });
  return {
    planStatus: planResponse.status(),
    planBody: await planResponse.json() as { effectiveTier?: unknown; planUnknown?: unknown },
  };
}
