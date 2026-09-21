import { describe, expect, it } from "vitest";
import { createNewListingWizardSubmission } from "@/lib/manager-listing-submission";
import {
  listingSaveFailureMessage,
  prepareListingSubmissionForPersist,
} from "@/lib/prepare-listing-submission-for-persist";

describe("prepareListingSubmissionForPersist", () => {
  it("allows an incomplete application-fee waive code while saving a draft", async () => {
    const sub = createNewListingWizardSubmission();
    sub.applicationFeeWaiverCode = "E.G.BAD";
    const prepared = await prepareListingSubmissionForPersist(sub, { validateWaiverCode: false });
    expect(prepared.submission.applicationFeeWaiverCode).toBe("E.G.BAD");
  });

  it("refuses an invalid application-fee waive code before publishing", async () => {
    const sub = createNewListingWizardSubmission();
    sub.applicationFeeWaiverCode = "E.G.BAD";
    await expect(prepareListingSubmissionForPersist(sub, { validateWaiverCode: true })).rejects.toThrow(
      "Application fee waive code must be 4–32 letters, numbers, or hyphens.",
    );
  });

  it("normalizes a valid waive code", async () => {
    const sub = createNewListingWizardSubmission();
    sub.applicationFeeWaiverCode = "welcome 50";
    const prepared = await prepareListingSubmissionForPersist(sub, { validateWaiverCode: true });
    expect(prepared.submission.applicationFeeWaiverCode).toBe("WELCOME50");
  });
});

describe("listingSaveFailureMessage", () => {
  it("turns a server promo refusal into plain copy", () => {
    expect(
      listingSaveFailureMessage(
        "Application-fee promo code: That code is already in use on another property. Give this one its own code.",
      ),
    ).toBe(
      "Could not save — That code is already in use on another property. Give this one its own code.",
    );
  });

  it("falls back to connection wording only when nothing came back", () => {
    expect(listingSaveFailureMessage("")).toBe(
      "Could not save your changes. Check your connection and try again.",
    );
  });
});
