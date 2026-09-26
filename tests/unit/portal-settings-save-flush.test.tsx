// @vitest-environment jsdom
/**
 * `closeAndSave` used to run `onClose()` BEFORE `flushPendingSaves()` — every
 * autosaving panel is mounted only while its tab is selected, so a synchronous
 * unmount on close had already nulled the panel's ref by the time the save
 * fired, and because every save was `void`-ed, a rejected save looked exactly
 * like a successful one. This suite drives the real `ProPortalSettingsModal`
 * with lightweight stand-ins for the two autosaving panels so it can control
 * exactly when a save resolves, rejects, or fails — and asserts the fix:
 * flush-and-await BEFORE close, `allSettled` so one panel's failure cannot
 * stop another's save, and a rejection keeps the dialog open with the error
 * surfaced instead of silently discarding the edit.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";

const { showToast, paymentsSaveIfDirty, paymentsOutgoingReminderSaveIfDirty, tourPanelSaveIfDirty } = vi.hoisted(() => ({
  showToast: vi.fn(),
  paymentsSaveIfDirty: vi.fn(async () => true),
  paymentsOutgoingReminderSaveIfDirty: vi.fn(async () => true),
  tourPanelSaveIfDirty: vi.fn(async () => true),
}));

vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => (req: { description?: unknown }) =>
    Promise.resolve(
      typeof window === "undefined"
        ? true
        : window.confirm(typeof req?.description === "string" ? req.description : "Are you sure?"),
    ),
  useAppUi: () => ({ showToast }),
}));
vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  // Spread the real module: this file only needs to override demo mode, and a
  // hand-listed mock silently breaks every time the module gains an export a
  // component calls at import time.
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
}));
vi.mock("@/hooks/use-manager-user-id", () => ({ useManagerUserId: () => ({ userId: "mgr-1" }) }));
vi.mock("@/hooks/use-work-assignment-directory", () => ({
  useWorkAssignmentDirectory: () => ({ teamMembers: [] }),
}));

/**
 * Only the two autosaving panels the assertions drive are replaced — every
 * other export (types, other panels, helpers) passes through the real
 * module untouched, so it stays true to the real modal's wiring.
 */
vi.mock("@/components/portal/pro-portal-settings-panels", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/portal/pro-portal-settings-panels")>();
  const React = await import("react");

  // Payments registers its OWN handle plus an independent outgoing-reminder
  // sub-panel handle — the natural place two independent saves are already
  // in flight together under one tab, which is exactly what the "one
  // failure must not block the other" assertion needs. (WS4, PLAN-0925 Part
  // 5: `TourSettingsPanel` used to be this suite's example of that shape too,
  // via an embedded `managerReminderFormRef` sub-panel, but C191 trimmed
  // Tours down to booking rules only — it has a single handle now.)
  function MockPaymentsSettingsPanel({
    formRef,
    outgoingReminderFormRef,
  }: ComponentProps<typeof actual.PaymentsSettingsPanel>) {
    React.useImperativeHandle(formRef, () => ({ saveIfDirty: paymentsSaveIfDirty }), []);
    React.useImperativeHandle(outgoingReminderFormRef, () => ({ saveIfDirty: paymentsOutgoingReminderSaveIfDirty }), []);
    return <div>Payments panel</div>;
  }

  function MockTourSettingsPanel({ formRef }: ComponentProps<typeof actual.TourSettingsPanel>) {
    React.useImperativeHandle(formRef, () => ({ saveIfDirty: tourPanelSaveIfDirty }), []);
    return <div>Tours panel</div>;
  }

  return {
    ...actual,
    PaymentsSettingsPanel: MockPaymentsSettingsPanel,
    TourSettingsPanel: MockTourSettingsPanel,
  };
});

// C111 moved every area's reminders onto ONE tab (`automation` — the
// Reminders hub), which is now where several INDEPENDENTLY registered
// handles are actually mounted together under a single tab (Payments' own
// outgoing-reminder sub-panel lost that shape in the same move — it no
// longer carries a second handle of its own).
vi.mock("@/components/portal/pro-portal-automation-settings-panel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/portal/pro-portal-automation-settings-panel")>();
  const React = await import("react");

  function MockManagerPortalAutomationSettingsPanel({
    formRef,
    applicationsReminderFormRef,
  }: ComponentProps<typeof actual.ManagerPortalAutomationSettingsPanel>) {
    React.useImperativeHandle(formRef, () => ({ saveIfDirty: paymentsSaveIfDirty }), []);
    React.useImperativeHandle(
      applicationsReminderFormRef,
      () => ({ saveIfDirty: paymentsOutgoingReminderSaveIfDirty }),
      [],
    );
    return <div>Reminders hub</div>;
  }

  return { ...actual, ManagerPortalAutomationSettingsPanel: MockManagerPortalAutomationSettingsPanel };
});

import { ProPortalSettingsModal } from "@/components/portal/pro-portal-settings-modal";

/** A save whose resolution the test controls by hand, to assert ordering. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  showToast.mockReset();
  paymentsSaveIfDirty.mockReset().mockResolvedValue(true);
  tourPanelSaveIfDirty.mockReset().mockResolvedValue(true);
  paymentsOutgoingReminderSaveIfDirty.mockReset().mockResolvedValue(true);
});

describe("ProPortalSettingsModal — save-before-close ordering", () => {
  it("awaits a pending save before onClose is called", async () => {
    const order: string[] = [];
    const pending = deferred<boolean>();
    paymentsSaveIfDirty.mockImplementation(() => {
      order.push("save-called");
      return pending.promise;
    });
    const onClose = vi.fn(() => order.push("onClose-called"));

    render(<ProPortalSettingsModal open onClose={onClose} initialTab="payments" />);
    await screen.findByText("Payments panel");

    await userEvent.click(screen.getByRole("button", { name: "Close" }));

    // The save has started, but onClose must not fire while it is still pending.
    await waitFor(() => expect(paymentsSaveIfDirty).toHaveBeenCalledTimes(1));
    expect(onClose).not.toHaveBeenCalled();

    pending.resolve(true);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(order).toEqual(["save-called", "onClose-called"]);
  });

  it("keeps the dialog open and surfaces the error when a save rejects", async () => {
    paymentsSaveIfDirty.mockRejectedValueOnce(new Error("Network down"));
    const onClose = vi.fn();

    render(<ProPortalSettingsModal open onClose={onClose} initialTab="payments" />);
    await screen.findByText("Payments panel");

    await userEvent.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith("Network down"));
    expect(onClose).not.toHaveBeenCalled();
    // The panel is still mounted — the edit was never discarded.
    expect(screen.getByText("Payments panel")).toBeTruthy();
  });

  it("runs every panel's save even when one of them rejects (allSettled, not all)", async () => {
    // C111: the Reminders hub (`automation` tab) is where several
    // independently registered handles are actually mounted together now.
    paymentsSaveIfDirty.mockRejectedValueOnce(new Error("Reminders save failed"));
    const onClose = vi.fn();

    render(<ProPortalSettingsModal open onClose={onClose} initialTab="automation" />);
    await screen.findByText("Reminders hub");

    await userEvent.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() => expect(paymentsSaveIfDirty).toHaveBeenCalledTimes(1));
    // The sibling handle's save still ran despite the other rejecting.
    await waitFor(() => expect(paymentsOutgoingReminderSaveIfDirty).toHaveBeenCalledTimes(1));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("flushes the outgoing panel before a tab switch unmounts it", async () => {
    render(
      <ProPortalSettingsModal open onClose={() => undefined} initialTab="payments" scoped={false} />,
    );
    await screen.findByText("Payments panel");

    await userEvent.click(screen.getByRole("button", { name: "Tours" }));

    // If the save had fired AFTER the switch, the panel (and its ref) would
    // already be unmounted and this mock would never have been called.
    await waitFor(() => expect(paymentsSaveIfDirty).toHaveBeenCalledTimes(1));
    await screen.findByText("Tours panel");
  });

  it("does not switch tabs when the outgoing panel's save rejects", async () => {
    paymentsSaveIfDirty.mockRejectedValueOnce(new Error("Could not save payments"));

    render(
      <ProPortalSettingsModal open onClose={() => undefined} initialTab="payments" scoped={false} />,
    );
    await screen.findByText("Payments panel");

    await userEvent.click(screen.getByRole("button", { name: "Tours" }));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith("Could not save payments"));
    expect(screen.getByText("Payments panel")).toBeTruthy();
    expect(screen.queryByText("Tours panel")).toBeNull();
  });

  it("flushes and awaits before the editAction path closes and opens the editor", async () => {
    const order: string[] = [];
    const pending = deferred<boolean>();
    paymentsSaveIfDirty.mockImplementation(() => {
      order.push("save-called");
      return pending.promise;
    });
    const onClose = vi.fn(() => order.push("onClose-called"));
    const onSelect = vi.fn(() => order.push("onSelect-called"));

    render(
      <ProPortalSettingsModal
        open
        onClose={onClose}
        initialTab="payments"
        editAction={{ label: "Edit configuration", onSelect }}
      />,
    );
    await screen.findByText("Payments panel");

    await userEvent.click(screen.getByRole("button", { name: /edit configuration/i }));

    await waitFor(() => expect(paymentsSaveIfDirty).toHaveBeenCalledTimes(1));
    expect(onClose).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();

    pending.resolve(true);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["save-called", "onClose-called", "onSelect-called"]);
  });

  it("does not open the editor when the editAction flush rejects", async () => {
    paymentsSaveIfDirty.mockRejectedValueOnce(new Error("Could not save payments"));
    const onClose = vi.fn();
    const onSelect = vi.fn();

    render(
      <ProPortalSettingsModal
        open
        onClose={onClose}
        initialTab="payments"
        editAction={{ label: "Edit configuration", onSelect }}
      />,
    );
    await screen.findByText("Payments panel");

    await userEvent.click(screen.getByRole("button", { name: /edit configuration/i }));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith("Could not save payments"));
    expect(onClose).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });
});
