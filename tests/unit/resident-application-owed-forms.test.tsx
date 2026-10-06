// @vitest-environment jsdom
/**
 * A paid co-signer=Yes application lands the applicant on the application's status screen and its Overview.
 * Both list the forms the answers owe ("N more forms to finish"), read from /api/linked-form-requests.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DemoApplicantRow } from "@/data/demo-portal";
import type { LinkedFormRequestView } from "@/lib/application-linked-form-requests";

const fetchForApplication = vi.hoisted(() => vi.fn());
vi.mock("@/lib/linked-form-requests-client", () => ({
  fetchLinkedFormsForApplication: fetchForApplication,
  mintLinkedFormShareUrl: vi.fn(),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/components/portal/resident-lifecycle-status-panel", () => ({
  ResidentLifecycleStatusPanel: () => <div data-testid="status-panel" />,
}));
vi.mock("@/hooks/use-resident-manager-contacts", () => ({ useResidentManagerContacts: () => [] }));
vi.mock("@/hooks/use-resident-portal-axis", () => ({
  useResidentPortalAxisContext: () => ({ residentAxisId: null, profileManagerId: null, axisResolved: false }),
}));
vi.mock("@/lib/household-charges", () => ({
  findApplicationFeeCharge: () => null,
  HOUSEHOLD_CHARGES_EVENT: "household-charges",
  isPendingUpfrontMoveInCharge: () => false,
  readChargesForResident: () => [],
  syncHouseholdChargesFromServer: async () => undefined,
}));
vi.mock("@/lib/lease-pipeline-storage", () => ({
  LEASE_PIPELINE_EVENT: "lease-pipeline",
  findLeaseForResidentEmail: () => null,
  syncLeasePipelineFromServer: async () => undefined,
}));
vi.mock("@/lib/resident-lifecycle-journey", () => ({
  residentLifecycleInputFromApplicationRow: () => ({}),
}));

import {
  ResidentApplicationOwedForms,
  ResidentApplicationStatusScreen,
} from "@/components/portal/resident-application-status-screen";

function owedRequest(overrides: Partial<LinkedFormRequestView> = {}): LinkedFormRequestView {
  return {
    id: "req-1",
    applicationId: "PROPLANE-OWED0001",
    ruleId: "lfr-derived-cosigner",
    formKind: "application",
    formId: "tpl-cosigner",
    formLabel: "Co-signer application",
    questionCount: 12,
    sourceQuestionLabel: "Co-signer planned",
    sourceAnswerLabel: "Yes",
    neededBeforeReview: true,
    status: "owed",
    feeCents: null,
    feePaid: false,
    completedAt: null,
    applicantName: "Riley",
    viewerRole: "applicant",
    expiresAt: "2099-01-01T00:00:00.000Z",
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  fetchForApplication.mockReset();
});

describe("owed forms on the application's own screens", () => {
  it("lists the owed forms with Fill out now and Someone else will fill it in", async () => {
    fetchForApplication.mockResolvedValue([owedRequest()]);
    render(<ResidentApplicationOwedForms applicationId="PROPLANE-OWED0001" />);
    expect(await screen.findByText("1 more form to finish")).toBeTruthy();
    expect(fetchForApplication).toHaveBeenCalledWith("PROPLANE-OWED0001");
    expect(screen.getByText("Co-signer application")).toBeTruthy();
    expect(screen.getByRole("link", { name: /fill out now/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /someone else will fill it in/i })).toBeTruthy();
  });

  it("draws nothing when nothing is owed or every form is finished", async () => {
    fetchForApplication.mockResolvedValue([owedRequest({ status: "done" })]);
    const { container } = render(<ResidentApplicationOwedForms applicationId="PROPLANE-OWED0001" />);
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.queryByText(/more form/)).toBeNull();
    expect(container.querySelector('[data-attr="linked-forms-finish-list"]')).toBeNull();
  });

  it("the single-application status screen shows them under the six steps", async () => {
    fetchForApplication.mockResolvedValue([owedRequest(), owedRequest({ id: "req-2", formLabel: "Move-in form", formKind: "move_in", formId: "mi-1" })]);
    const row = { id: "PROPLANE-OWED0001", name: "Riley", email: "riley@example.com", property: "Home", bucket: "pending" } as unknown as DemoApplicantRow;
    render(<ResidentApplicationStatusScreen row={row} residentEmail="riley@example.com" residentUserId="u1" basePath="/resident" />);
    expect(screen.getByTestId("status-panel")).toBeTruthy();
    expect(await screen.findByText("2 more forms to finish")).toBeTruthy();
    expect(fetchForApplication).toHaveBeenCalledWith("PROPLANE-OWED0001");
  });
});
