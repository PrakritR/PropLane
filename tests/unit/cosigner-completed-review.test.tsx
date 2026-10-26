// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ManagerCosignerReadonlyReview } from "@/components/portal/pro-cosigner-readonly-review";
import { cosignerSubmissionSummary } from "@/lib/cosigner-submission-visibility";
import type { CosignerSubmission } from "@/lib/cosigner-submissions-storage";
import { STANDARD_APPLICATION_FIELD_CATALOG } from "@/lib/rental-application/application-field-catalog";

afterEach(cleanup);

const sub = {
  ...cosignerSubmissionSummary({ signerAppId: "PROPLANE-ONE", submittedAt: "2026-10-25" } as CosignerSubmission, "submitted-1"),
  fullName: "Maria Lee", email: "maria@example.com", signerFullName: "Ava Lee",
  customFieldAnswers: [{ key: "relationship", label: "Relationship", type: "text" as const, value: "Parent", section: "personal" as const }],
};
const config = {
  applicationConfigMode: "custom" as const,
  disabledStandardApplicationKeys: STANDARD_APPLICATION_FIELD_CATALOG.filter((field) => !["personal-full-legal-name", "personal-email"].includes(field.standardKey)).map((field) => field.standardKey),
  customApplicationFields: [{ id: "relationship", key: "relationship", label: "Relationship", type: "text" as const, required: true, options: [], section: "personal" as const }],
};

describe("completed co-signer question visibility", () => {
  it("shows only the helper's published questions and custom answers", () => {
    render(<ManagerCosignerReadonlyReview sub={sub} questionConfig={config} />);
    expect(screen.getByText("Maria Lee")).toBeInTheDocument();
    expect(screen.getByText("maria@example.com")).toBeInTheDocument();
    expect(screen.getByText("Parent")).toBeInTheDocument();
    for (const label of ["Employment", "Not employed", "SSN", "Background", "Signature", "Group application", "Not checked", "Not provided"]) {
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    }
  });
  it("keeps the existing complete manager review when no filter is supplied", () => {
    render(<ManagerCosignerReadonlyReview sub={sub} />);
    expect(screen.getByText("Employment")).toBeInTheDocument();
    expect(screen.getByText("Credit consent")).toBeInTheDocument();
    expect(screen.getByText("SSN")).toBeInTheDocument();
  });
  it("does not invent unasked answers if the historical template is unavailable", () => {
    render(<ManagerCosignerReadonlyReview sub={sub} questionConfig={null} />);
    expect(screen.getByText("Maria Lee")).toBeInTheDocument();
    expect(screen.queryByText("Not employed")).not.toBeInTheDocument();
    expect(screen.queryByText("Credit consent")).not.toBeInTheDocument();
  });
});
