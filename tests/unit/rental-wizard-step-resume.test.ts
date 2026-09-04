// @vitest-environment jsdom
//
// Regression coverage for the captain's "glitches back to start of application"
// bug. `RentalApplicationWizardInner`'s own step-tracking effect writes
// `?wizardStep=N` to the URL for steps 1-3 (deleting it above step 3) so a
// resumed session can land back where it left off — but nothing ever read it
// back on mount: `step` always started at `useState(1)`, so ANY remount while
// on steps 1-3 (a real reload, or any other unmount/remount within the SPA)
// silently threw the resident back to "Group Application" even though their
// draft — property, room, everything — was intact. `initialWizardStepFromRequest`
// is the read-back half of that persistence; this only trusts the URL's step
// when the locally-loaded draft still matches THIS request's target, so a
// stale `wizardStep` left over from a different property/room can never skip
// a fresh application ahead.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RentalWizardFormState } from "@/lib/rental-application/types";

const mocks = vi.hoisted(() => ({ draft: null as Partial<RentalWizardFormState> | null }));

vi.mock("@/lib/rental-application/drafts", () => ({
  loadRentalWizardDraft: () => mocks.draft,
  loadRentalWizardDraftAxisId: () => null,
  saveRentalWizardDraft: () => {},
  saveRentalWizardDraftAxisId: () => {},
  clearRentalWizardDraft: () => {},
}));

import {
  initialWizardStepFromRequest,
  isElementOnScreen,
  parsePersistedWizardStep,
  resumeActionForLiveDraft,
} from "@/components/marketing/rental-application-wizard";
import { RENTAL_WIZARD_STEP_SCHEMA } from "@/lib/rental-application/wizard-step-schema";

function params(query: Record<string, string>): URLSearchParams {
  return new URLSearchParams(query);
}

afterEach(() => {
  mocks.draft = null;
});

describe("initialWizardStepFromRequest", () => {
  it("defaults to step 1 outside portal mode", () => {
    mocks.draft = { propertyId: "mgr-alder", roomChoice1: "mgr-alder::room-1" };
    expect(
      initialWizardStepFromRequest("public", { propertyId: "mgr-alder" }, params({ wizardStep: "3" })),
    ).toBe(1);
  });

  it("defaults to step 1 when the URL carries no wizardStep param", () => {
    mocks.draft = { propertyId: "mgr-alder" };
    expect(initialWizardStepFromRequest("portal", { propertyId: "mgr-alder" }, params({}))).toBe(1);
  });

  it("defaults to step 1 for an out-of-range or malformed wizardStep", () => {
    mocks.draft = { propertyId: "mgr-alder" };
    expect(
      initialWizardStepFromRequest("portal", { propertyId: "mgr-alder" }, params({ wizardStep: "4" })),
    ).toBe(1);
    expect(
      initialWizardStepFromRequest("portal", { propertyId: "mgr-alder" }, params({ wizardStep: "0" })),
    ).toBe(1);
    expect(
      initialWizardStepFromRequest("portal", { propertyId: "mgr-alder" }, params({ wizardStep: "abc" })),
    ).toBe(1);
  });

  it("defaults to step 1 when there is no locally-loaded draft to trust the param against", () => {
    mocks.draft = null;
    expect(
      initialWizardStepFromRequest("portal", { propertyId: "mgr-alder" }, params({ wizardStep: "3" })),
    ).toBe(1);
  });

  it("defaults to step 1 when the draft is for a DIFFERENT property than this request", () => {
    mocks.draft = { propertyId: "mgr-birch" };
    expect(
      initialWizardStepFromRequest("portal", { propertyId: "mgr-alder" }, params({ wizardStep: "3" })),
    ).toBe(1);
  });

  it("resumes at the persisted step when the draft matches this request's target", () => {
    mocks.draft = { propertyId: "mgr-alder", roomChoice1: "mgr-alder::room-1" };
    expect(
      initialWizardStepFromRequest("portal", { propertyId: "mgr-alder", listingRoomId: "room-1" }, params({ wizardStep: "3" })),
    ).toBe(3);
  });

  it("resumes at the persisted step when the request names no target at all (legacy bare /apply)", () => {
    mocks.draft = { propertyId: "mgr-alder" };
    expect(initialWizardStepFromRequest("portal", null, params({ wizardStep: "2" }))).toBe(2);
  });
});

// The URL param (`initialWizardStepFromRequest`) only ever carries steps 1-3, so
// it can never resume a resident at step 12 after they return from an external
// redirect (a Stripe checkout) — that reload wipes the in-memory draft entirely.
// The step PERSISTED on the server application record covers the full range and
// is what the reconciliation effect uses to land them back where they were.
/**
 * PRP-181: "when i click my application it has all the saved info but it takes
 * me back to the beginning of the application."
 *
 * The reconciliation effect refused to overwrite the form when a local draft
 * was already loaded — correct, a save may have landed while its reads were in
 * flight. But it returned OUTRIGHT, so the step restore never ran: the fields
 * repopulated from the local draft while `step` stayed at its initial 1, i.e.
 * a mostly-finished application reopening on "Group Application".
 */
describe("PRP-181: resumeActionForLiveDraft", () => {
  it("restores everything when no draft is loaded", () => {
    expect(resumeActionForLiveDraft(null, "app-1")).toBe("restore_all");
    expect(resumeActionForLiveDraft("", "app-1")).toBe("restore_all");
    expect(resumeActionForLiveDraft("   ", "app-1")).toBe("restore_all");
  });

  it("restores the STEP but not the form when the draft is the same application", () => {
    // The form is already correct from the draft — only the step was lost.
    expect(resumeActionForLiveDraft("app-1", "app-1")).toBe("restore_step_only");
    expect(resumeActionForLiveDraft(" app-1 ", "app-1")).toBe("restore_step_only");
  });

  it("leaves a draft for a DIFFERENT application completely alone", () => {
    // Restoring another application's step here would jump the resident into
    // the middle of a form they have not filled in.
    expect(resumeActionForLiveDraft("app-1", "app-2")).toBe("leave_alone");
    expect(resumeActionForLiveDraft("app-1", null)).toBe("leave_alone");
    expect(resumeActionForLiveDraft("app-1", undefined)).toBe("leave_alone");
  });
});

describe("parsePersistedWizardStep", () => {
  it("accepts any real step 1..11 on the current schema", () => {
    expect(parsePersistedWizardStep(1, RENTAL_WIZARD_STEP_SCHEMA)).toBe(1);
    expect(parsePersistedWizardStep(4, RENTAL_WIZARD_STEP_SCHEMA)).toBe(4);
    expect(parsePersistedWizardStep(11, RENTAL_WIZARD_STEP_SCHEMA)).toBe(11);
    expect(parsePersistedWizardStep("11", RENTAL_WIZARD_STEP_SCHEMA)).toBe(11);
  });

  it("remaps legacy 12-step persisted values onto the current flow", () => {
    expect(parsePersistedWizardStep(12)).toBe(11);
    expect(parsePersistedWizardStep(11)).toBe(10);
    expect(parsePersistedWizardStep(4)).toBe(2);
    expect(parsePersistedWizardStep(2)).toBe(1);
  });

  it("rejects out-of-range, missing, or malformed values", () => {
    expect(parsePersistedWizardStep(0)).toBeNull();
    expect(parsePersistedWizardStep(13)).toBeNull();
    expect(parsePersistedWizardStep(undefined)).toBeNull();
    expect(parsePersistedWizardStep(null)).toBeNull();
    expect(parsePersistedWizardStep("abc")).toBeNull();
  });
});

// Regression coverage for the actual root cause behind the captain's "glitches
// and goes back to start of application" report: `ResidentApplicationsPanel`
// renders an expanded in-progress row's detail TWICE — once inside the
// `lg:hidden` mobile card list, once inside the `hidden lg:block` desktop
// table — so BOTH copies of `RentalApplicationWizard` are simultaneously
// live, each with independent `step` state. The off-screen copy's `step`
// never advances (it gets no clicks), so its own copy of the URL-tracking
// effect kept firing on every `searchParams` change and rewriting
// `?wizardStep=` back down to its stale value, fighting the on-screen
// instance's writes in an unthrottled `router.replace` loop hundreds of
// times per second — this measured in a real browser via a `window` debug
// log during manual reproduction. `isElementOnScreen` (via `offsetParent`,
// which is null for `display:none` elements and their descendants) is what
// lets the wizard's side-effecting hooks (the step/URL sync effect, the
// draft-save effect, the per-keystroke server-sync effect) tell the two
// mounts apart and let only the one actually on screen touch shared state.
describe("isElementOnScreen", () => {
  it("is false for a detached element (no offsetParent, e.g. never attached to the document)", () => {
    const el = document.createElement("div");
    expect(isElementOnScreen(el)).toBe(false);
  });

  it("is false for null", () => {
    expect(isElementOnScreen(null)).toBe(false);
  });

  it("is true once offsetParent resolves, matching a genuinely visible element", () => {
    const el = document.createElement("div");
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    parent.appendChild(el);
    // jsdom never computes real layout, so simulate what a `display:none`
    // ancestor (e.g. the `lg:hidden` / `hidden lg:block` wrapper) vs. a
    // visible one does to `offsetParent` in a real browser.
    Object.defineProperty(el, "offsetParent", { value: parent, configurable: true });
    expect(isElementOnScreen(el)).toBe(true);
    Object.defineProperty(el, "offsetParent", { value: null, configurable: true });
    expect(isElementOnScreen(el)).toBe(false);
    document.body.removeChild(parent);
  });
});
