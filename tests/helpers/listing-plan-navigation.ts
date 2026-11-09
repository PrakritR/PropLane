import type { Page, Request } from "@playwright/test";

/**
 * Navigate to the real Properties document and capture the plan response from that page's
 * main-frame load. This avoids consuming a late subscription response from a prior portal tab.
 */
export async function navigateToPropertiesAndCapturePlan(page: Page, documentPath = "/portal/properties") {
  if (!documentPath.startsWith("/portal/properties")) throw new Error("Manager plan capture requires a Properties document path.");
  let committedPropertiesDocument = false;
  let planRequest: Request | null = null;
  const trackCommittedDocument = (frame: import("@playwright/test").Frame) => {
    if (frame === page.mainFrame() && new URL(frame.url()).pathname === documentPath) {
      committedPropertiesDocument = true;
      planRequest = null;
    }
  };
  const trackPlanRequest = (request: Request) => {
    if (!committedPropertiesDocument || planRequest !== null || request.frame() !== page.mainFrame()) return;
    if (new URL(request.url()).pathname === "/api/manager/subscription") planRequest = request;
  };
  page.on("framenavigated", trackCommittedDocument);
  page.on("request", trackPlanRequest);
  const planCapturePromise = page.waitForResponse((response) => {
    const request = planRequest;
    return request !== null && response.request() === request;
  }, { timeout: 30_000 }).then(async (response) => ({
    status: response.status(),
    body: await response.json() as { effectiveTier?: unknown; planUnknown?: unknown },
  }));
  void planCapturePromise.catch(() => undefined);
  try {
    const documentResponse = await page.goto(documentPath, { waitUntil: "domcontentloaded" });
    if (!documentResponse || !documentResponse.ok()) {
      throw new Error(`Properties document navigation failed (HTTP ${documentResponse?.status() ?? "no response"}).`);
    }
    // Parse the subscription body as soon as its exact, navigation-bound response arrives.
    const plan = await planCapturePromise;
    return { planStatus: plan.status, planBody: plan.body };
  } finally {
    page.off("framenavigated", trackCommittedDocument);
    page.off("request", trackPlanRequest);
  }
}
