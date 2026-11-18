// @vitest-environment jsdom
/**
 * Evidence harness (round 8, 2026-11-17) for the Add-vendor flow:
 *
 * 1. "What they do" carries into Dispatch's "Jobs they take" until the manager
 *    sets Dispatch themselves - after that a newly ticked trade leaves it alone.
 * 2. The Typical price cells wear a `$` and Review states the saved rates.
 * 3. The invite dialog's work-number warning appears only AFTER the number read
 *    comes back and finds none - nothing while the read is in flight.
 *
 * Screenshot-ready HTML is written only when EVIDENCE_DIR is set, so this stays
 * a plain assertion test everywhere else.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearAllWorkspaceDrafts } from "@/components/portal/add-workspace/draft";
import { writeEvidencePage } from "../helpers/evidence-page";
import { renderedBodyHtml } from "../helpers/evidence-dom";

const sharedGet = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/use-manager-user-id", () => ({ useManagerUserId: () => ({ userId: "mgr-test-1", ready: true }) }));
vi.mock("@/lib/manager-vendors-storage", () => ({
  deleteManagerVendorRow: vi.fn(),
  makeVendorId: () => "vend-new-1",
  persistManagerVendorToServer: vi.fn().mockResolvedValue(true),
  readOwnManagerVendorRows: () => [],
  setManagerVendorPriority: vi.fn(),
  upsertManagerVendor: vi.fn(),
}));
vi.mock("@/lib/demo-property-pipeline", () => ({
  readPendingManagerPropertiesForUser: () => [],
  readScopedExtraListings: () => [],
}));
vi.mock("@/lib/manager-vendor-invite-client", () => ({
  deliverManagerDirectoryMessage: vi.fn(),
  deliverManagerVendorInvite: vi.fn().mockResolvedValue({ ok: true, message: "Vendor invitation sent." }),
  fetchManagerVendorRemovalDraft: vi.fn(),
}));
vi.mock("@/lib/invite-links/mint-invite-link-client", () => ({
  mintInviteLinkClient: vi.fn().mockResolvedValue({ ok: true, url: "https://proplane.app/i/vendor-demo" }),
}));
vi.mock("@/lib/manager-portfolio-access", () => ({ buildManagerPropertyFilterOptions: () => [] }));
vi.mock("@/lib/shared-get-cache", () => ({ sharedGet: (...a: unknown[]) => sharedGet(...a), invalidateSharedGets: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => "/portal/vendors" }));
vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => () => Promise.resolve(true),
  useAppUi: () => ({ showToast: vi.fn() }),
}));

import { ManagerVendorFormModal } from "@/components/portal/pro-vendor-form-modal";

function next() {
  fireEvent.click(screen.getByRole("button", { name: /Next: / }));
}
/** Pick an option the way the real menu does: a pointer press on the row. */
function pickOption(trigger: Element, value: string) {
  fireEvent.click(trigger);
  const list = document.getElementById(trigger.getAttribute("aria-controls")!)!;
  const option = list.querySelector(`[data-field-select-option-value="${value}"]`)!;
  fireEvent.pointerDown(option, { pointerId: 1, clientX: 10, clientY: 10 });
  fireEvent.pointerUp(option, { pointerId: 1, clientX: 10, clientY: 10 });
}
function dispatchText(): string {
  return document.querySelector('[data-attr="vendor-form-dispatch"]')?.textContent ?? "";
}
function page(name: string, title: string) {
  writeEvidencePage(name, renderedBodyHtml(), { title, width: 1040 });
}

afterEach(() => {
  cleanup();
  clearAllWorkspaceDrafts();
  sharedGet.mockReset();
});

describe("Add vendor — round 8 evidence", () => {
  it("carries trades into Dispatch, prices with a $, states them on Review, and warns only after the number read", async () => {
    sharedGet.mockReturnValue(new Promise(() => {})); // the work-number read never lands yet
    render(<ManagerVendorFormModal open mode="add" onClose={vi.fn()} showToast={() => {}} />);

    // Invite by → Message, so the flow ends at the invite dialog.
    pickOption(document.querySelector('[data-attr="invite-path"]')!, "message");
    next();

    fireEvent.change(screen.getByLabelText("Invite by first name"), { target: { value: "Dana" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "dana@apexplumbing.test" } });
    fireEvent.change(screen.getByLabelText("Phone"), { target: { value: "2065550147" } });
    next(); // → Properties
    next(); // → What they do

    fireEvent.click(screen.getByLabelText("Plumbing"));
    page("vendor-01-what-they-do", "Add vendor · What they do — General maintenance + Plumbing ticked");

    next(); // → Dispatch
    expect(dispatchText()).toContain("Handyman");
    expect(dispatchText()).toContain("Plumber");
    page("vendor-02-dispatch-carried", "Add vendor · Dispatch — Jobs they take carries both ticked trades (nothing typed here)");

    // The manager now sets Dispatch themselves: drop Plumber.
    pickOption(document.querySelector('[data-attr="vendor-dispatch-trades"]')!, "plumber");
    expect(dispatchText()).not.toContain("Plumber");
    fireEvent.click(screen.getByRole("button", { name: /^Back/ })); // → What they do
    fireEvent.click(screen.getByLabelText("Electrical"));
    next(); // → Dispatch again
    expect(dispatchText()).toContain("Handyman");
    expect(dispatchText()).not.toContain("Electrician");
    page("vendor-03-dispatch-hand-set", "Add vendor · Dispatch after the manager edited it — Electrical was ticked afterwards and Dispatch stayed theirs");

    next(); // → Typical price
    const hourly = screen.getAllByLabelText("Hourly");
    const service = screen.getAllByLabelText("Typical service");
    expect(hourly[0]!.parentElement?.textContent).toContain("$");
    expect(service[0]!.parentElement?.textContent).toContain("$");
    fireEvent.change(hourly[0]!, { target: { value: "75" } });
    fireEvent.change(service[0]!, { target: { value: "150" } });
    fireEvent.change(hourly[1]!, { target: { value: "95" } });
    page("vendor-04-typical-price", "Add vendor · Typical price — each field prefixed with $");

    next(); // → Review
    expect(document.body.textContent).toContain("Typical price: Hourly $75–$95 · Typical service $150");
    page("vendor-05-review-prices", "Add vendor · Review — the typical prices are stated back");

    // Finish → the invite dialog. The work-number read is still in flight.
    fireEvent.click(screen.getByRole("button", { name: "Invite vendor" }));
    await waitFor(() => expect(screen.getByText("New message")).toBeTruthy());
    expect(screen.queryByText(/SMS needs an active work number/)).toBeNull();
    expect(screen.queryByText(/Could not check your work number/)).toBeNull();
    page("vendor-06-invite-read-pending", "Invite dialog · the work-number read is still in flight — no SMS warning is shown yet");
  });

  it("warns once the read comes back and finds no work number", async () => {
    const { PortalNotificationPreviewModal } = await import("@/components/portal/portal-notification-preview-modal");
    // The read lands and reports no work number of their own.
    sharedGet.mockResolvedValue({ ok: true, data: { canSend: true, lineReady: false, number: null } });
    render(
      <PortalNotificationPreviewModal
        open
        title="New message"
        onClose={() => {}}
        recipient="Dana"
        recipientPhone="+12065550147"
        subject="You're invited to PropLane"
        body="Dana — here is your vendor invite: https://proplane.app/i/vendor-demo"
        showChannelPicker
        dynamicSendLabel
        emailAvailable
        smsAvailable
        defaultViaSms
        confirmLabel="Send invite"
        confirmLabelWithoutMessage="Add without sending"
        skipMessageLabel="Don't send a message"
        cancelLabel="Back"
        onConfirm={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText(/SMS needs an active work number/)).toBeTruthy());
    await act(async () => {});
    expect(screen.getByText(/SMS needs an active work number/)).toBeTruthy();
    page("vendor-07-invite-read-found-none", "Invite dialog · the read came back with no work number — the warning is shown");
  });

  it("says the check failed rather than claiming there is no number", async () => {
    const { PortalNotificationPreviewModal } = await import("@/components/portal/portal-notification-preview-modal");
    sharedGet.mockRejectedValue(new Error("offline"));
    render(
      <PortalNotificationPreviewModal
        open
        title="New message"
        onClose={() => {}}
        recipient="Dana"
        recipientPhone="+12065550147"
        subject="You're invited to PropLane"
        body="Dana — here is your vendor invite: https://proplane.app/i/vendor-demo"
        showChannelPicker
        dynamicSendLabel
        emailAvailable
        smsAvailable
        defaultViaSms
        confirmLabel="Send invite"
        skipMessageLabel="Don't send a message"
        cancelLabel="Back"
        onConfirm={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText(/Could not check your work number/)).toBeTruthy());
    await act(async () => {});
    expect(screen.queryByText(/SMS needs an active work number/)).toBeNull();
    page("vendor-08-invite-read-failed", "Invite dialog · the read failed — it says so instead of claiming there is no number");
    await act(async () => {});
  });
});
