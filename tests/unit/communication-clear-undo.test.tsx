// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useUnifiedCommunicationBulk } from "@/hooks/use-unified-communication-bulk";
import type { PersistedInboxThread } from "@/lib/portal-inbox-storage";
import type { UnifiedInboxListItem } from "@/lib/unified-inbox-merge";
import type { ToastOptions } from "@/components/providers/app-ui-provider";
const clear = vi.hoisted(() => vi.fn(async () => ({ok: true, next: []})));
vi.mock("@/components/providers/app-ui-provider", () => ({useConfirm: () => vi.fn(async () => true)}));
vi.mock("@/lib/communication-inbox-thread-mutations", () => ({clearPersistedInboxThread: clear}));
const id = "agent_notice_00000000-0000-4000-8000-000000000001";
const row: UnifiedInboxListItem = {key: `email:${id}`, threadId: id, channel: "email", name: "PropLane Assistant", preview: "Hi", time: "", unread: false, sortMs: 1};
const thread: PersistedInboxThread = {id, folder: "inbox", from: "PropLane Assistant", email: "", subject: "Assistant", body: "Hi", preview: "Hi", time: "", unread: false};
afterEach(() => {cleanup(); vi.useRealTimers(); clear.mockClear();});
function setup() {
  vi.useFakeTimers();
  const toast = vi.fn<(message: string, options?: ToastOptions) => void>();
  const hook = renderHook(() => useUnifiedCommunicationBulk({mergedRows: [row], listSegment: "active", storageKey: "test", emailThreads: [thread], onEmailThreadsChange: vi.fn(), showToast: toast}));
  return {...hook, toast};
}
it("Undo cancels clear before any server mutation", async () => {
  const {result, toast} = setup();
  await act(() => result.current.handleClearAssistant(row));
  expect(clear).not.toHaveBeenCalled();
  await act(async () => {await toast.mock.calls[0]?.[1]?.undo?.(); await vi.advanceTimersByTimeAsync(6200);});
  expect(clear).not.toHaveBeenCalled();
});
it("clears only after the Undo window and cancels on unmount", async () => {
  const {result, unmount} = setup();
  await act(() => result.current.handleClearAssistant(row));
  await act(() => vi.advanceTimersByTimeAsync(6100));
  expect(clear).toHaveBeenCalledTimes(1);
  await act(() => result.current.handleClearAssistant(row));
  unmount();
  await vi.advanceTimersByTimeAsync(6200);
  expect(clear).toHaveBeenCalledTimes(1);
});
