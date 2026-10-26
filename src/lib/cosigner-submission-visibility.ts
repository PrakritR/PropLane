import type { CosignerSubmission } from "@/lib/cosigner-submissions-storage";

/** Primary applicants see completion, never a co-signer's identity or finances. An allowlist also excludes future fields. */
export function cosignerSubmissionSummary(sub: CosignerSubmission, id: string): CosignerSubmission {
  return {
    id, signerAppId: sub.signerAppId, signerFullName: "", fullName: "Co-signer", submittedAt: sub.submittedAt,
    email: "", phone: "", dob: "", dlNumber: "", ssn: "", address: "", city: "", state: "", zip: "",
    notEmployed: false, employerName: "", employerAddress: "", supervisorName: "", supervisorPhone: "", jobTitle: "",
    monthlyIncome: "", annualIncome: "", employmentStart: "", otherIncome: "", bankruptcy: "", criminal: "",
    consentCredit: false, signature: "", dateSigned: "",
  };
}

/** The completed response belongs to its exact filler, or a manager authorized on the parent application. */
export function mayReadCompletedLinkedSubmission(request: { status: string; filled_by_user_id: string | null; completed_submission_ref: string | null }, userId: string, role: string): boolean {
  return request.status === "done" && Boolean(request.completed_submission_ref) && (role === "manager" || request.filled_by_user_id === userId);
}
