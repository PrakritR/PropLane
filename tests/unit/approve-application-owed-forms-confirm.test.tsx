// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DemoApplicantRow } from "@/data/demo-portal";
import type { LinkedFormRequestView } from "@/lib/application-linked-form-requests";

const mocks = vi.hoisted(() => ({
  requests: [] as LinkedFormRequestView[],
  transition: vi.fn(async () => ({ ok: true, approvalSms: null })),
  syncProperty: vi.fn(async () => true),
  sharedReady: false,
  demo: false,
}));

vi.mock("@/hooks/use-linked-form-requests", () => ({
  useLinkedFormRequests: () => ({ requests: mocks.requests, loading: false, reload: async () => mocks.requests }),
}));
vi.mock("@/components/providers/app-ui-provider", () => ({ useAppUi: () => ({ showToast: vi.fn() }) }));
vi.mock("@/hooks/use-manager-communication-deliver-via", () => ({
  useManagerCommunicationDeliverVia: () => ({ channelsFor: () => ({ viaEmail: false, viaSms: false }) }),
}));
vi.mock("@/lib/demo-property-pipeline", () => ({ syncPropertyPipelineFromServer: () => mocks.syncProperty() }));
vi.mock("@/lib/demo/demo-session", () => ({ isDemoModeActive: () => mocks.demo }));
vi.mock("@/lib/rental-application/data", () => ({ getPropertyById: () => ({ listingSubmission: {} }) }));
vi.mock("@/lib/application-approval-placement", () => ({ approvalPlacementBlocker: () => null }));
vi.mock("@/lib/rental-application/placement-values", () => ({ resolvePlacementValuesForRow: () => ({ signedMonthlyRent: 1250, roomLabel: "" }) }));
vi.mock("@/lib/application-approval-slots", () => ({
  applicationRoomPricesPerResident: () => mocks.sharedReady, approvalBedOptions: () => mocks.sharedReady ? [{ slot: 1, label: "Bed A · $1,250/mo", monthlyRent: 1250 }] : [], bedLabelForSlot: () => "Bed A",
  residentSlotsForApplicationRow: () => mocks.sharedReady ? [{ slot: 1, price: { slot: 1, monthlyRent: 1250 }, holder: null }] : [], roomForApplicationRow: () => null,
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

// The confirm is a Radix dialog. Its focus scope schedules a 0 ms timer on unmount that dispatches an event on the
// (by then removed) container. Under a loaded full run that timer could fire after the test environment was
// torn down: an unhandled "dispatchEvent" TypeError that made the whole run exit 1. Fake timers (still advancing
// with the clock, so waitFor and findBy keep working) let the test unmount first and run every pending timer
// while the document still exists.
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(async () => {
  cleanup();
  await vi.runAllTimersAsync();
  vi.useRealTimers();
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
    mocks.sharedReady = false;
    mocks.demo = false;
    mocks.syncProperty.mockReset().mockResolvedValue(true);
  });

  it("blocks approval during a failed property load and retries before showing the rate", async () => {
    mocks.syncProperty.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    open();
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not verify");
    expect(mocks.transition).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled());
    expect(screen.getAllByText(/1,250/).length).toBeGreaterThan(0);
  });

  it("keeps demo approval available without a property sync", async () => {
    mocks.demo = true;
    open();
    await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled());
    expect(mocks.syncProperty).not.toHaveBeenCalled();
  });

  it("selects the first bed when shared-room data arrives after opening", async () => {
    mocks.syncProperty.mockImplementationOnce(async () => { mocks.sharedReady = true; return true; });
    open();
    await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled());
    expect(screen.getByText(/Bed A/)).toBeInTheDocument();
  });

  it("says plainly that the application is waiting on a form", () => {
    mocks.requests = [owed()];
    open();
    expect(screen.getByText("Waiting on 1 form")).toBeInTheDocument();
  });

  it("asks one confirm, then approves anyway: a soft stop, never a hard block", async () => {
    mocks.requests = [owed()];
    open();
    await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled());
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
    await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(mocks.transition).toHaveBeenCalledTimes(1));
  });
});
