// @vitest-environment jsdom
//
// The record Communication section's scheduled cards must never reach the scheduled-messages API when
// their section is disabled, and `/demo` must never read or write real rows through them.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor, act } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";

const state = vi.hoisted(() => ({
  demo: false,
  cardProps: null as null | { onCancel: () => void; onSaveEdit?: (next: { subject: string; body: string }) => Promise<void> | void },
  automationReload: vi.fn(),
  patchScheduledMessage: vi.fn(async () => undefined),
}));

vi.mock("@/lib/demo/demo-session", () => ({ isDemoModeActive: () => state.demo }));
vi.mock("@/components/providers/app-ui-provider", () => ({ useOptionalAppUi: () => null }));
vi.mock("@/components/portal/payment-schedule-ui", () => ({
  useScheduledPaymentMessages: () => ({ messages: [], settings: null, reload: state.automationReload }),
  patchScheduledMessage: state.patchScheduledMessage,
}));
vi.mock("@/components/portal/portal-inbox-selection", () => ({
  sendAutomationScheduledMessageNow: vi.fn(),
  sendManualScheduledMessageNow: vi.fn(),
}));
vi.mock("@/lib/inbox-scheduled-thread", () => ({
  automationChannelDefaultsFromSettings: () => ({}),
  scheduledItemsForRecipient: () => [
    { id: "m1", source: "manual", editable: true, sendLabel: "Soon", subject: "s", body: "b", meta: "", channel: "inbox", deliveryStatus: "scheduled", sendAt: "2026-10-10T10:00:00Z" },
  ],
}));
vi.mock("@/components/portal/portal-inbox-ui", () => ({
  InboxScheduledThreadList: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  InboxScheduledCard: (props: { onCancel: () => void; onSaveEdit?: (next: { subject: string; body: string }) => Promise<void> | void }) => {
    state.cardProps = props;
    return <div data-testid="card" />;
  },
}));

import { useThreadScheduledCards } from "@/components/portal/use-thread-scheduled-cards";

const handle: { reload?: () => void } = {};

function Harness({ enabled }: { enabled?: boolean }) {
  const { scheduledCards, reloadScheduled } = useThreadScheduledCards({ recipientEmail: "a@b.test", smsAvailable: false, enabled });
  useEffect(() => {
    handle.reload = reloadScheduled;
  }, [reloadScheduled]);
  return <>{scheduledCards}</>;
}

const fetchMock = vi.fn();

beforeEach(() => {
  state.demo = false;
  state.cardProps = null;
  state.automationReload.mockClear();
  state.patchScheduledMessage.mockClear();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ messages: [] }) });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useThreadScheduledCards gating", () => {
  it("reads the scheduled messages when enabled", async () => {
    render(<Harness />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/portal/scheduled-inbox-messages", expect.anything()));
  });

  it("makes no request at all when disabled, even if reload is called", async () => {
    render(<Harness enabled={false} />);
    await act(async () => { handle.reload?.(); });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.automationReload).not.toHaveBeenCalled();
  });

  it("makes no request under /demo: load, cancel and save are all no-ops", async () => {
    state.demo = true;
    render(<Harness />);
    await act(async () => { handle.reload?.(); });
    expect(fetchMock).not.toHaveBeenCalled();
    await waitFor(() => expect(state.cardProps).not.toBeNull());
    await act(async () => { state.cardProps!.onCancel(); await state.cardProps!.onSaveEdit?.({ subject: "x", body: "y" }); });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.patchScheduledMessage).not.toHaveBeenCalled();
  });

  it("cancel and save reach the API when live", async () => {
    render(<Harness />);
    await waitFor(() => expect(state.cardProps).not.toBeNull());
    fetchMock.mockClear();
    await act(async () => { await state.cardProps!.onSaveEdit?.({ subject: "x", body: "y" }); });
    expect(fetchMock).toHaveBeenCalledWith("/api/portal/scheduled-inbox-messages/m1", expect.objectContaining({ method: "PATCH" }));
  });
});
