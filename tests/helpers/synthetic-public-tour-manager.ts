import type { Browser, BrowserContext, Page } from "@playwright/test";
import { requestManagerEmailProof, finishManagerEmailProof } from "./email-onboarding-e2e";
import { completeManagerSignupOnboarding } from "./manager-onboarding-e2e";
import { syntheticSignupDomain } from "./synthetic-signup-domain";
import { cleanupSyntheticProperties, createSyntheticProperty } from "./synthetic-property-e2e";
import { syntheticFixtureActorId } from "./synthetic-property-e2e";
import { clearManagerPhoneGate, type SyntheticPhoneVerification } from "./synthetic-phone-verification";

export type SyntheticPublicTourManager = {
  page: Page;
  context: BrowserContext;
  property: { id: string; name: string };
  actorId: string;
  /** Present only when the mandatory phone gate applied; restored by the cleanup. */
  phoneFixture: SyntheticPhoneVerification | null;
};

function assertLocalDevBaseUrl(): string {
  const baseURL = process.env.PLAYWRIGHT_BASE_URL;
  if (!baseURL || process.env.NEXT_PUBLIC_SUPABASE_URL !== "https://emstjswhotsnyksqhqyf.supabase.co") {
    throw new Error("Public tour fixture requires the DEV database and localhost.");
  }
  const base = new URL(baseURL);
  const port = Number(base.port);
  if (base.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(base.hostname) || !Number.isInteger(port) || port < 3000 || port > 3014) {
    throw new Error("Public tour fixture requires a localhost port from 3000 through 3014.");
  }
  return baseURL;
}

/** Creates a real non-sandbox manager/listing so production-mode localhost uses the public projection. */
export async function createSyntheticPublicTourManager(browser: Browser): Promise<SyntheticPublicTourManager> {
  const context = await browser.newContext({ baseURL: assertLocalDevBaseUrl() });
  const page = await context.newPage();
  const stamp = Date.now();
  const email = `e2e-manager-${stamp}@${syntheticSignupDomain()}`;
  const fullName = "E2E Public Tour Manager";
  const phone = `+1206555${String(stamp).slice(-4)}`;
  let phoneFixture: SyntheticPhoneVerification | null = null;

  try {
    await page.goto("/partner/pricing");
    await Promise.all([
      page.waitForURL(/\/auth\/create-account/, { timeout: 30_000 }),
      page.locator('[data-attr="pricing-choose-free"]').click(),
    ]);
    const href = await requestManagerEmailProof(page, email, undefined, "free");
    await finishManagerEmailProof(page, href, email, fullName, phone, undefined, "free");
    await page.getByRole("button", { name: "Go to portal" }).click();
    await page.waitForURL(/\/auth\/(verify-phone|get-started|manager\/choose-plan|connect-google-services)|\/portal/, { timeout: 90_000 });
    // The mandatory phone gate stands between the proven mailbox and the portal. It is cleared
    // as FIXTURE SETUP for this one synthetic account; no OTP is exercised.
    phoneFixture = await clearManagerPhoneGate(page, { email, phone });
    await completeManagerSignupOnboarding(page);
    const property = await createSyntheticProperty(page);
    const actorId = await syntheticFixtureActorId(page);
    return { page, context, property, actorId, phoneFixture };
  } catch (error) {
    let cleanupFailed = false;
    const failures: string[] = [];
    try {
      await cleanupSyntheticProperties(page);
    } catch {
      cleanupFailed = true;
    }
    try {
      await phoneFixture?.restore();
    } catch (restoreError) {
      failures.push(restoreError instanceof Error ? restoreError.message : "phone fixture restore failed");
    }
    await context.close();
    if (cleanupFailed || failures.length) {
      throw new Error(`Public tour manager setup failed and its fixture cleanup also failed. ${failures.join("; ")}`.trim(), { cause: error });
    }
    throw error;
  }
}

/**
 * Removes only the owned property tracked by createSyntheticPublicTourManager, and puts the
 * phone-verification stamp back. A restore conflict is REPORTED: a left-behind verified flag is
 * a fixture leak, not something to pass over quietly.
 */
export async function cleanupSyntheticPublicTourManager(manager: SyntheticPublicTourManager): Promise<void> {
  const failures: string[] = [];
  try {
    await cleanupSyntheticProperties(manager.page);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : "property cleanup failed");
  }
  try {
    await manager.phoneFixture?.restore();
  } catch (error) {
    failures.push(error instanceof Error ? error.message : "phone fixture restore failed");
  }
  await manager.context.close();
  if (failures.length) throw new Error(`Public tour manager cleanup failed: ${failures.join("; ")}`);
}
