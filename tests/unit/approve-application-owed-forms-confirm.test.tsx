// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DemoApplicantRow } from "@/data/demo-portal";
import type { LinkedFormRequestView } from "@/lib/application-linked-form-requests";

const mocks = vi.hoisted(() => ({
  requests: [] as LinkedFormRequestView[],
  transition: vi.fn(async () => ({ ok: true, approvalSms: null })),
}));

vi.mock("@/hooks/use-linked-form-requests", () => ({
  useLinkedFormRequests: () => ({ requests: mocks.requests, loading: false, reload: async () => mocks.requests }),
}));
vi.mock("@/components/providers/app-ui-provider", () => ({ useAppUi: () => ({ showToast: vi.fn() }) }));
vi.mock("@/hooks/use-manager-communication-deliver-via", () => ({
  useManagerCommunicationDeliverVia: () => ({ channelsFor: () => ({ viaEmail: false, viaSms: false }) }),
}));
vi.mock("@/lib/application-review", () => ({ transitionApplicationBucket: mocks.transition }));
vi.mock("@/lib/manager-applications-storage", () => ({
  readManagerApplicationRows: () => [],
  residentSlotOverrideFields: () => ({}),
  syncManagerApplicationsFromServer: async () => undefined,
  upsertApplicationRowToServerAwait: async () => ({ ok: true }),
  writeManagerApplicationRows: () => undefined,
}));

import { ApproveApplicationDialog } from "@/components/portal/approve-application-dialog";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function owed(overrides: Partial<LinkedFormRequestView> = {}): LinkedFormRequestView {
  return {
    id: "r1",
    applicationId: "PROPLANE-APP00001",
    ruleId: "r",
    formKind: "application",
    formId: "cos",
    formLabel: "Co-signer form",
    questionCount: 4,
    sourceQuestionLabel: "Co-signer planned",
    sourceAnswerLabel: "Yes",
    neededBeforeReview: true,
    status: "owed",
    feeCents: null,
    feePaid: false,
    completedAt: null,
    applicantName: "Ava Lee",
    viewerRole: "manager",
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    ...overrides,
  };
}

const row = { id: "PROPLANE-APP00001", name: "Ava Lee", email: "ava@example.com", bucket: "pending", property: "Alder House", application: {} } as unknown as DemoApplicantRow;

function open() {
  render(<ApproveApplicationDialog row={row} userId="manager-1" onClose={() => undefined} />);
}

describe("approving with a needed-before-review form still owed", () => {
  beforeEach(() => {
    mocks.requests = [];
  });

  it("says plainly that the application is waiting on a form", () => {
    mocks.requests = [owed()];
    open();
    expect(screen.getByText("Waiting on 1 form")).toBeInTheDocument();
  });

  it("asks one confirm, then approves anyway: a soft stop, never a hard block", async () => {
    mocks.requests = [owed()];
    open();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(mocks.transition).not.toHaveBeenCalled();
    expect(await screen.findByText(/Waiting on 1 form\. Approve without it\?/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Approve anyway" }));
    await waitFor(() => expect(mocks.transition).toHaveBeenCalledTimes(1));
  });

  it("approves straight away when nothing needed is owed", async () => {
    mocks.requests = [owed({ status: "done" }), owed({ id: "r2", neededBeforeReview: false })];
    open();
    expect(screen.queryByText(/Waiting on/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(mocks.transition).toHaveBeenCalledTimes(1));
  });
});
