/**
 * A refused listing save has to say WHY.
 *
 * `POST /api/property-records` upserts the property row FIRST and only then
 * applies the application-fee promo code, so a refusal at the promo step
 * answers 400 after the record has already landed. The listing-edit path threw
 * that explanation away — `upsertPropertyRecordToServer` has taken an
 * `onError` callback for exactly this since the plan-limit 403, and this caller
 * simply never passed one — so the wizard fell back to "Could not save changes.
 * Check your connection and try again."
 *
 * That is what a manager saw for a full night while the rest of the product
 * worked normally: the real cause was a production database missing the
 * `property_id` column the promo write needs, and the interface blamed their
 * internet.
 *
 * Pinned here: the server's own sentence reaches the caller.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// /demo is browser-local and short-circuits the server write to `true`, so the
// refusal path only exists outside it.
vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
}));

import { updateExtraListingFromSubmissionOnServer } from "@/lib/demo-property-pipeline";
import { createNewListingWizardSubmission } from "@/lib/manager-listing-submission";

const REFUSAL = "Application-fee promo code: Codes must be 4-32 letters, numbers, or hyphens.";

function stubFetch(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a refused listing-edit save explains itself", () => {
  it("hands the server's refusal to the caller instead of swallowing it", async () => {
    stubFetch(400, { error: REFUSAL });
    const seen: string[] = [];
    const ok = await updateExtraListingFromSubmissionOnServer(
      "listing-1",
      "mgr-1",
      createNewListingWizardSubmission(),
      { onError: (message) => seen.push(message) },
    );
    expect(ok).toBe(false);
    // Without this the wizard can only say "check your connection" for a
    // refusal the server already described in words.
    expect(seen).toEqual([REFUSAL]);
  });

  it("stays silent when the write succeeds", async () => {
    stubFetch(200, { ok: true });
    const seen: string[] = [];
    await updateExtraListingFromSubmissionOnServer(
      "listing-1",
      "mgr-1",
      createNewListingWizardSubmission(),
      { onError: (message) => seen.push(message) },
    );
    expect(seen).toEqual([]);
  });

  it("reports failure without a message when the server said nothing", async () => {
    // A genuine network failure has no sentence to show, and THAT is the only
    // case where blaming the connection is honest.
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    const seen: string[] = [];
    const ok = await updateExtraListingFromSubmissionOnServer(
      "listing-1",
      "mgr-1",
      createNewListingWizardSubmission(),
      { onError: (message) => seen.push(message) },
    );
    expect(ok).toBe(false);
    expect(seen).toEqual([]);
  });
});
