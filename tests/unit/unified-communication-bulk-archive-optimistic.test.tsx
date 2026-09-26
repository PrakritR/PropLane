// @vitest-environment jsdom
//
// PLAN B3 — Archive/restore must feel instant (the row moves immediately,
// before the network confirms) and every selected SMS row must archive in
// parallel, not one at a time.
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUnifiedCommunicationBulk } from "@/hooks/use-unified-communication-bulk";
import type { PersistedInboxThread } from "@/lib/portal-inbox-storage";
import type { UnifiedInboxListItem } from "@/lib/unified-inbox-merge";

const mocks = vi.hoisted(() => ({
  archivePersistedInboxThreads: vi.fn(),
  restorePersistedInboxThreads: vi.fn(),
  archiveManagerSmsConversation: vi.fn(),
  restoreManagerSmsConversation: vi.fn(),
}));

vi.mock("@/components/providers/app-ui-provider", () => ({ useConfirm: () => async () => true }));
vi.mock("@/lib/communication-inbox-thread-mutations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/communication-inbox-thread-mutations")>()),
  archivePersistedInboxThreads: mocks.archivePersistedInboxThreads,
  restorePersistedInboxThreads: mocks.restorePersistedInboxThreads,
}));
vi.mock("@/lib/manager-sms-archive.client", () => ({
  archiveManagerSmsConversation: mocks.archiveManagerSmsConversation,
  restoreManagerSmsConversation: mocks.restoreManagerSmsConversation,
  loadManagerSmsArchivedIds: () => new Set<string>(),
  persistManagerSmsArchivedIds: () => {},
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const threadA: PersistedInboxThread = {
  id: "thread-a",
  folder: "inbox",
  from: "Person A",
  email: "a@example.test",
  subject: "Hi",
  preview: "Hi",
  body: "Hi",
  time: "Sep 10, 9:00 AM",
  unread: false,
};

const emailRow: UnifiedInboxListItem = {
  key: "email:thread-a",
  channel: "email",
  threadId: "thread-a",
  name: "Person A",
  preview: "",
  time: "",
  unread: false,
  sortMs: 1,
};

const smsRowA: UnifiedInboxListItem = {
  key: "sms:conv-a",
  channel: "sms",
  threadId: "conv-a",
  name: "Text A",
  preview: "",
  time: "",
  unread: false,
  sortMs: 2,
};
const smsRowB: UnifiedInboxListItem = {
  key: "sms:conv-b",
  channel: "sms",
  threadId: "conv-b",
  name: "Text B",
  preview: "",
  time: "",
  unread: false,
  sortMs: 3,
};

describe("useUnifiedCommunicationBulk archive/restore (PLAN B3)", () => {
  beforeEach(() => {
    mocks.archivePersistedInboxThreads.mockReset();
    mocks.restorePersistedInboxThreads.mockReset();
    mocks.archiveManagerSmsConversation.mockReset();
    mocks.restoreManagerSmsConversation.mockReset();
  });
  afterEach(() => vi.clearAllMocks());

  it("moves the row to Archived immediately, before persistence confirms, and rolls back on failure", async () => {
    const gate = deferred<{ ok: boolean; next: PersistedInboxThread[] }>();
    mocks.archivePersistedInboxThreads.mockReturnValue(gate.promise);
    const onEmailThreadsChange = vi.fn();

    const { result } = renderHook(() =>
      useUnifiedCommunicationBulk({
        mergedRows: [emailRow],
        listSegment: "active",
        storageKey: "test-inbox",
        emailThreads: [threadA],
        onEmailThreadsChange,
        smsTargets: [],
      }),
    );

    let archiveDone!: Promise<void>;
    act(() => {
      archiveDone = result.current.handleArchiveKeys(["email:thread-a"]);
    });

    // Optimistic — the row is already "trash" before the mocked persistence
    // call has resolved.
    await waitFor(() => {
      expect(onEmailThreadsChange).toHaveBeenCalledWith([
        expect.objectContaining({ id: "thread-a", folder: "trash" }),
      ]);
    });

    await act(async () => {
      gate.resolve({ ok: false, next: [threadA] });
      await archiveDone;
    });

    // Rolled back to the exact previous render on a persistence failure.
    expect(onEmailThreadsChange).toHaveBeenLastCalledWith([threadA]);
  });

  it("archives every selected SMS row in parallel, not a sequential loop", async () => {
    const gateA = deferred<void>();
    const gateB = deferred<void>();
    mocks.archiveManagerSmsConversation.mockImplementation((id: string) =>
      id === "conv-a" ? gateA.promise : gateB.promise,
    );

    const { result } = renderHook(() =>
      useUnifiedCommunicationBulk({
        mergedRows: [smsRowA, smsRowB],
        listSegment: "active",
        storageKey: "test-inbox",
        emailThreads: [],
        onEmailThreadsChange: () => {},
        smsTargets: [
          { conversationId: "conv-a", phone: "+15550000001", conversationKey: "conv-a" },
          { conversationId: "conv-b", phone: "+15550000002", conversationKey: "conv-b" },
        ],
      }),
    );

    let archiveDone!: Promise<void>;
    act(() => {
      archiveDone = result.current.handleArchiveKeys(["sms:conv-a", "sms:conv-b"]);
    });

    // Both dispatched before EITHER resolves — a sequential loop would only
    // start the second call after awaiting the first.
    await waitFor(() => expect(mocks.archiveManagerSmsConversation).toHaveBeenCalledTimes(2));

    await act(async () => {
      gateA.resolve();
      gateB.resolve();
      await archiveDone;
    });

    expect(mocks.archiveManagerSmsConversation).toHaveBeenCalledWith("conv-a");
    expect(mocks.archiveManagerSmsConversation).toHaveBeenCalledWith("conv-b");
  });
});
