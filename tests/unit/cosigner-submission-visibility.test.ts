import { describe, expect, it } from "vitest";
import { cosignerSubmissionSummary, mayReadCompletedLinkedSubmission } from "@/lib/cosigner-submission-visibility";
import type { CosignerSubmission } from "@/lib/cosigner-submissions-storage";

describe("co-signer access projection", () => {
  it("uses an allowlist that excludes identity, financial answers and future fields", () => {
    const summary = cosignerSubmissionSummary({ signerAppId: "app", submittedAt: "today", fullName: "Private Person", email: "private@example.com", monthlyIncome: "9000", ssn: "encrypted", customFieldAnswers: [{ value: "secret" }], futureSensitiveField: "secret" } as unknown as CosignerSubmission, "sub");
    expect(summary).toMatchObject({ id: "sub", signerAppId: "app", submittedAt: "today", fullName: "Co-signer" });
    expect(JSON.stringify(summary)).not.toMatch(/Private|private|9000|encrypted|secret/);
  });
  it("only exposes a completed request to its actual filler or authorized manager", () => {
    const request = { status: "done", completed_submission_ref: "sub", filled_by_user_id: "filler" };
    expect(mayReadCompletedLinkedSubmission(request, "filler", "helper")).toBe(true);
    expect(mayReadCompletedLinkedSubmission(request, "parent", "applicant")).toBe(false);
    expect(mayReadCompletedLinkedSubmission(request, "other-helper", "helper")).toBe(false);
    expect(mayReadCompletedLinkedSubmission({ ...request, status: "shared" }, "filler", "helper")).toBe(false);
  });
});
