// @vitest-environment jsdom
/**
 * A tour can be deleted from the Tours list.
 *
 * The row's ⋯ menu used to stop at View / Message: nothing on any tab removed a
 * tour, so cancelled, declined and stale tours piled up in Past forever. Delete
 * now sits on the selection bar (which is what the row menu renders) and on the
 * detail header. A past row gets a plain confirm; a live tour the guest can
 * still be reached about opens the notification sheet first, so dropping it
 * silently is a choice, not the default.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ManagerTourRow } from "@/lib/manager-tour-list";

const showToast = vi.fn();
const navigate = vi.fn();
const deletePlanned = vi.fn(async () => ({ ok: true as const }));
const deleteInquiry = vi.fn(async () => ({ ok: true }));
const previewProps = vi.fn();
let ROWS: ManagerTourRow[] = [];

vi.mock("next/navigation", () => ({
  usePathname: () => "/portal/tours",
  useRouter: () => ({ push: navigate, replace: navigate, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/hooks/use-manager-user-id", () => ({
  useManagerUserId: () => ({ userId: "mgr-1", email: "m@example.com", ready: true }),
}));
vi.mock("@/hooks/use-scheduled-tour-reminders", () => ({
  useScheduledTourReminders: () => ({ reminders: [], loading: false, reload: async () => {} }),
}));
vi.mock("@/hooks/use-work-assignment-directory", () => ({
  useWorkAssignmentDirectory: () => ({ teamMembers: [], vendors: [] }),
}));
vi.mock("@/components/providers/app-ui-provider", () => ({ useAppUi: () => ({ showToast }) }));
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => navigate }));
vi.mock("@/lib/demo-property-pipeline", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo-property-pipeline")>()),
  syncPropertyPipelineFromServer: async () => {},
}));
vi.mock("@/lib/manager-portfolio-access", () => ({
  buildManagerPropertyFilterOptions: () => [{ id: "prop-1", label: "5257 Brooklyn Avenue Northeast" }],
}));
vi.mock("@/lib/workspaces/selection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspaces/selection")>()),
  workspaceContainsProperty: () => true,
}));
vi.mock("@/lib/manager-tour-list", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/manager-tour-list")>()),
  buildManagerTourRows: () => ROWS,
}));
vi.mock("@/lib/demo-admin-scheduling", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo-admin-scheduling")>()),
  syncScheduleRecordsFromServer: async () => {},
  deletePartnerInquiryFromServer: (...args: unknown[]) => deleteInquiry(...(args as [])),
}));
vi.mock("@/lib/tour-planned-change.client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tour-planned-change.client")>()),
  deletePlannedTourFromServer: (...args: unknown[]) => deletePlanned(...(args as [])),
}));
vi.mock("@/components/portal/portal-notification-preview-modal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/portal/portal-notification-preview-modal")>()),
  PortalNotificationPreviewModal: (props: {
    title: string;
    confirmLabel: string;
    confirmLabelWithoutMessage?: string;
    subject: string;
    onConfirm: (skip: boolean, channels: { viaEmail?: boolean; viaSms?: boolean }, draft: { subject: string; body: string }) => void;
  }) => {
    previewProps(props);
    return (
      <div role="dialog" aria-label={props.title}>
        <button type="button" onClick={() => props.onConfirm(false, { viaEmail: true, viaSms: false }, { subject: props.subject, body: "custom body" })}>
          {props.confirmLabel}
        </button>
        <button type="button" onClick={() => props.onConfirm(true, {}, { subject: "", body: "" })}>
          {props.confirmLabelWithoutMessage}
        </button>
      </div>
    );
  },
}));
vi.mock("@/components/portal/pro-add-scheduled-tour-modal", () => ({ ManagerAddScheduledTourModal: () => null }));
vi.mock("@/components/portal/manager-tour-availability-modal", () => ({ ManagerTourAvailabilityModal: () => null }));
vi.mock("@/components/portal/pro-portal-settings-modal", () => ({ ManagerPortalSettingsModal: () => null }));
vi.mock("@/components/portal/share-lead-link-modal", () => ({ ShareLeadLinkModal: () => null }));

import { ManagerTours } from "@/components/portal/pro-tours";
import { RECORD_ACTION_DESTRUCTIVE_SETTLE_MS } from "@/components/ui/record-action-menu";

function row(overrides: Partial<ManagerTourRow> & Pick<ManagerTourRow, "id" | "source" | "sourceId" | "bucket">): ManagerTourRow {
  return {
    guestName: "Heh",
    guestEmail: "hs@gmail.com",
    guestPhone: "",
    propertyTitle: "5257 Brooklyn Avenue Northeast",
    propertyId: "prop-1",
    whenLabel: "Tue, Sep 15, 10:00 AM – 11:00 AM",
    startIso: "2026-09-15T17:00:00.000Z",
    endIso: "2026-09-15T18:00:00.000Z",
    startMs: Date.parse("2026-09-15T17:00:00.000Z"),
    endMs: Date.parse("2026-09-15T18:00:00.000Z"),
    statusLabel: "Confirmed",
    tourFormat: "virtual",
    ...overrides,
  };
}

const PAST = row({ id: "planned-past", source: "planned", sourceId: "ev-past", bucket: "past" });
const UPCOMING = row({
  id: "planned-up",
  source: "planned",
  sourceId: "ev-up",
  bucket: "upcoming",
  guestName: "Maya Chen",
  guestEmail: "maya@example.com",
  whenLabel: "Thu, Sep 17, 4:00 PM – 4:30 PM",
});
const PENDING = row({
  id: "inquiry-1-0",
  source: "inquiry",
  sourceId: "inq-1",
  bucket: "pending",
  guestName: "Sam Lee",
  guestEmail: "sam@example.com",
  statusLabel: "Pending",
});
const PROPOSAL = row({
  id: "proposal-1",
  source: "proposal",
  sourceId: "inq-2",
  proposalActionId: "act-1",
  bucket: "pending",
  guestName: "Pat Doe",
  statusLabel: "New time proposed",
});

/** The confirm renders as a phone drawer in jsdom; its red button is the stable handle. */
function confirmButton(): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>('[data-attr="tours-delete-confirm"]');
  if (!button) throw new Error("delete confirm is not open");
  return button;
}
async function findConfirm(): Promise<HTMLElement> {
  return screen.findByText(/This cannot be undone\./);
}

function openRowMenu(label: string) {
  fireEvent.keyDown(screen.getByRole("button", { name: `Actions for ${label}` }), { key: "ArrowDown" });
}

/**
 * Delete is a destructive item, so the menu ignores it for a short settle
 * window after opening (a stray iOS tap must never fire it). Wait it out.
 */
async function clickDeleteInMenu() {
  const item = await screen.findByRole("menuitem", { name: "Delete" });
  await new Promise((resolve) => setTimeout(resolve, RECORD_ACTION_DESTRUCTIVE_SETTLE_MS + 20));
  fireEvent.click(item);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn(async () => ({ status: 200, ok: true, json: async () => ({ proposals: [] }) })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("deleting a tour from the Tours list", () => {
  it("offers Delete on a past tour's row menu and removes it after one confirm, with no message", async () => {
    ROWS = [PAST];
    render(<ManagerTours embedded bucket="past" />);
    openRowMenu("Heh · Tue, Sep 15, 10:00 AM – 11:00 AM");
    await clickDeleteInMenu();

    const body = await findConfirm();
    expect(body.textContent).toContain("Delete Heh's tour on Tue, Sep 15, 10:00 AM – 11:00 AM?");
    expect(deletePlanned).not.toHaveBeenCalled();

    fireEvent.click(confirmButton());
    await waitFor(() => expect(deletePlanned).toHaveBeenCalledTimes(1));
    expect(deletePlanned).toHaveBeenCalledWith(expect.objectContaining({ plannedEventId: "ev-past", notifyGuest: false }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith("Tour deleted."));
    expect(previewProps).not.toHaveBeenCalled();
  });

  it("keeps the tour when the confirm is dismissed", async () => {
    ROWS = [PAST];
    render(<ManagerTours embedded bucket="past" />);
    openRowMenu("Heh · Tue, Sep 15, 10:00 AM – 11:00 AM");
    await clickDeleteInMenu();
    await findConfirm();
    fireEvent.click(screen.getByRole("button", { name: "Keep tour" }));
    await waitFor(() => expect(document.querySelector('[data-attr="tours-delete-confirm"]')).toBeNull());
    expect(deletePlanned).not.toHaveBeenCalled();
  });

  it("opens the guest-notification sheet for an upcoming tour and deletes with the message", async () => {
    ROWS = [UPCOMING];
    render(<ManagerTours embedded bucket="upcoming" />);
    openRowMenu("Maya Chen · Thu, Sep 17, 4:00 PM – 4:30 PM");
    await clickDeleteInMenu();

    await screen.findByRole("dialog", { name: "Delete tour" });
    expect(previewProps).toHaveBeenLastCalledWith(
      expect.objectContaining({
        title: "Delete tour",
        confirmLabel: "Delete tour & send notification",
        confirmLabelWithoutMessage: "Delete tour only",
        recipient: "maya@example.com",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete tour & send notification" }));
    await waitFor(() => expect(deletePlanned).toHaveBeenCalledTimes(1));
    expect(deletePlanned).toHaveBeenCalledWith(
      expect.objectContaining({ plannedEventId: "ev-up", notifyGuest: true, body: "custom body", deliverViaEmail: true, deliverViaSms: false }),
    );
    await waitFor(() => expect(showToast).toHaveBeenCalledWith("Tour deleted and guest notified."));
  });

  it("lets the manager delete a live tour without messaging, as an explicit choice", async () => {
    ROWS = [UPCOMING];
    render(<ManagerTours embedded bucket="upcoming" />);
    openRowMenu("Maya Chen · Thu, Sep 17, 4:00 PM – 4:30 PM");
    await clickDeleteInMenu();
    fireEvent.click(await screen.findByRole("button", { name: "Delete tour only" }));
    await waitFor(() => expect(deletePlanned).toHaveBeenCalledWith(expect.objectContaining({ plannedEventId: "ev-up", notifyGuest: false })));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith("Tour deleted."));
  });

  it("drops a pending request outright rather than leaving it declined", async () => {
    ROWS = [PENDING];
    render(<ManagerTours embedded bucket="pending" />);
    openRowMenu("Sam Lee · Tue, Sep 15, 10:00 AM – 11:00 AM");
    await clickDeleteInMenu();
    fireEvent.click(await screen.findByRole("button", { name: "Delete tour & send notification" }));
    await waitFor(() => expect(deleteInquiry).toHaveBeenCalledTimes(1));
    expect(deleteInquiry).toHaveBeenCalledWith("inq-1", expect.objectContaining({ notifyTenant: true, purge: true }));
    expect(deletePlanned).not.toHaveBeenCalled();
  });

  it("does not offer Delete on a reschedule proposal — those are declined", async () => {
    ROWS = [PROPOSAL];
    render(<ManagerTours embedded bucket="pending" />);
    openRowMenu("Pat Doe · Tue, Sep 15, 10:00 AM – 11:00 AM");
    await screen.findByRole("menu");
    expect(screen.queryByRole("menuitem", { name: "Delete" })).toBeNull();
  });

  it("keeps the row and names the reason when the server refuses", async () => {
    ROWS = [PAST];
    deletePlanned.mockResolvedValueOnce({ ok: false, error: "Tour not found." } as never);
    render(<ManagerTours embedded bucket="past" />);
    openRowMenu("Heh · Tue, Sep 15, 10:00 AM – 11:00 AM");
    await clickDeleteInMenu();
    await findConfirm();
    fireEvent.click(confirmButton());
    await waitFor(() => expect(showToast).toHaveBeenCalledWith("Tour not found."));
    // The confirm stays up so the manager can back out; nothing celebrates.
    expect(confirmButton()).toBeTruthy();
    expect(showToast).not.toHaveBeenCalledWith("Tour deleted.");
  });

  it("puts a trash icon on the detail header that opens the same confirm", async () => {
    ROWS = [PAST];
    render(<ManagerTours embedded bucket="past" tourId="planned-past" />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete tour" }));
    await findConfirm();
    fireEvent.click(confirmButton());
    await waitFor(() => expect(deletePlanned).toHaveBeenCalledWith(expect.objectContaining({ plannedEventId: "ev-past" })));
    // Back to the tab the tour was on.
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(expect.stringContaining("past")));
  });
});
