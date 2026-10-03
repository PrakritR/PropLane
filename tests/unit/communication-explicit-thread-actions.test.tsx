// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useUnifiedCommunicationBulk } from "@/hooks/use-unified-communication-bulk";
import type { UnifiedInboxListItem } from "@/lib/unified-inbox-merge";
const restore = vi.hoisted(() => vi.fn(async () => ({ ok: true, next: [] })));
vi.mock("@/components/providers/app-ui-provider", () => ({ useConfirm: () => vi.fn(async () => true) }));
vi.mock("@/lib/communication-inbox-thread-mutations", () => ({
  restorePersistedInboxThreads: restore,
  previewRestoredInboxThreads: () => ({ changed: [], next: [] }),
}));
afterEach(() => { cleanup(); restore.mockClear(); });
it("restores the explicit open conversation without depending on asynchronous selection", async () => {
  const row: UnifiedInboxListItem = { key: "email:one", threadId: "one", channel: "email", name: "Resident", preview: "", time: "", unread: false, sortMs: 1, memberKeys: ["email:one", "email:two"] };
  const { result } = renderHook(() => useUnifiedCommunicationBulk({ mergedRows: [row], listSegment: "archived", storageKey: "test", emailThreads: [], onEmailThreadsChange: vi.fn() }));
  expect(result.current.selection.selectedIds.size).toBe(0);
  await act(() => result.current.handleRestore([row.key]));
  expect(restore).toHaveBeenCalledWith("test", ["one", "two"]);
});
