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
  updateManagerSmsConversationStateClient: vi.fn(),
  deleteManagerSmsConversationClient: vi.fn(),
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
vi.mock("@/lib/manager-sms-conversations-client", () => ({
  updateManagerSmsConversationStateClient: mocks.updateManagerSmsConversationStateClient,
  deleteManagerSmsConversationClient: mocks.deleteManagerSmsConversationClient,
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
    mocks.updateManagerSmsConversationStateClient.mockReset();
    mocks.deleteManagerSmsConversationClient.mockReset();
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

  it("archives projection rows with their current version and reports partial SMS failure", async () => {
    mocks.updateManagerSmsConversationStateClient
      .mockResolvedValueOnce(Response.json({ version: 5 }, { status: 200 }))
      .mockResolvedValueOnce(Response.json({}, { status: 409 }));
    const showToast = vi.fn();
    const onSmsArchiveChange = vi.fn();
    const onSmsMutation = vi.fn();
    const { result } = renderHook(() => useUnifiedCommunicationBulk({
      mergedRows: [smsRowA, smsRowB], listSegment: "active", storageKey: "test-inbox",
      emailThreads: [], onEmailThreadsChange: () => {}, showToast, onSmsArchiveChange, onSmsMutationStart: () => onSmsMutation,
      smsTargets: [
        { conversationId: "conv-a", phone: "+15550000001", conversationKey: "conv-a", projectionId: "proj-a", stateVersion: 4 },
        { conversationId: "conv-b", phone: "+15550000002", conversationKey: "conv-b", projectionId: "proj-b", stateVersion: 7 },
      ],
    }));

    await act(async () => result.current.handleArchiveKeys(["sms:conv-a", "sms:conv-b"]));

    expect(mocks.updateManagerSmsConversationStateClient).toHaveBeenCalledWith({ projectionId: "proj-a", action: "archive", expectedVersion: 4 });
    expect(mocks.updateManagerSmsConversationStateClient).toHaveBeenCalledWith({ projectionId: "proj-b", action: "archive", expectedVersion: 7 });
    expect(mocks.archiveManagerSmsConversation).not.toHaveBeenCalled();
    expect(onSmsArchiveChange).toHaveBeenCalledTimes(1);
    expect(onSmsMutation).toHaveBeenCalledWith({
      updated: [{ projectionId: "proj-a", archived: true, version: 5 }],
      deleted: [], reconcile: ["proj-b"],
    });
    expect(showToast).toHaveBeenCalledWith("Archived 1 text conversation. Couldn't archive 1.");
  });

  it("restores a selected projection row with its current version", async () => {
    mocks.updateManagerSmsConversationStateClient.mockResolvedValue(Response.json({ version: 5 }, { status: 200 }));
    const showToast = vi.fn();
    const { result } = renderHook(() => useUnifiedCommunicationBulk({
      mergedRows: [smsRowA], listSegment: "archived", storageKey: "test-inbox",
      emailThreads: [], onEmailThreadsChange: () => {}, showToast,
      smsTargets: [{ conversationId: "conv-a", phone: "+15550000001", conversationKey: "conv-a", projectionId: "proj-a", stateVersion: 9 }],
    }));

    act(() => result.current.selection.toggleSelected("sms:conv-a"));
    await act(async () => result.current.handleRestore());

    expect(mocks.updateManagerSmsConversationStateClient).toHaveBeenCalledWith({ projectionId: "proj-a", action: "restore", expectedVersion: 9 });
    expect(mocks.restoreManagerSmsConversation).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith("Restored.");
  });

  it("reports only successfully deleted projection IDs for loaded-page removal", async () => {
    mocks.deleteManagerSmsConversationClient
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, error: "Conflict" });
    const onSmsMutation = vi.fn();
    const { result } = renderHook(() => useUnifiedCommunicationBulk({
      mergedRows: [smsRowA, smsRowB], listSegment: "archived", storageKey: "test-inbox",
      emailThreads: [], onEmailThreadsChange: () => {}, onSmsMutationStart: () => onSmsMutation,
      smsTargets: [
        { conversationId: "conv-a", phone: "+15550000001", conversationKey: "conv-a", projectionId: "proj-a", stateVersion: 4 },
        { conversationId: "conv-b", phone: "+15550000002", conversationKey: "conv-b", projectionId: "proj-b", stateVersion: 7 },
      ],
    }));
    act(() => {
      result.current.selection.toggleSelected("sms:conv-a");
      result.current.selection.toggleSelected("sms:conv-b");
    });
    await act(async () => result.current.handleDelete());
    expect(onSmsMutation).toHaveBeenCalledWith({ updated: [], deleted: ["proj-a"], reconcile: ["proj-b"] });
  });

  it("deletes a null-phone projection by ID without inventing a phone from its UUID", async () => {
    const projectionId = "22222222-2222-4222-8222-222222222222";
    mocks.deleteManagerSmsConversationClient.mockResolvedValue({ ok: true });
    let loadedIds = [projectionId, "proj-b"];
    const onSmsMutation = vi.fn((mutation: { deleted: string[] }) => {
      loadedIds = loadedIds.filter((id) => !mutation.deleted.includes(id));
    });
    const { result } = renderHook(() => useUnifiedCommunicationBulk({
      mergedRows: [
        { ...smsRowA, key: `sms:${projectionId}`, threadId: projectionId },
        smsRowB,
      ],
      listSegment: "archived", storageKey: "test-inbox", emailThreads: [],
      onEmailThreadsChange: () => {}, onSmsMutationStart: () => onSmsMutation,
      smsTargets: [
        { conversationId: projectionId, phone: "", conversationKey: null, projectionId, stateVersion: 1 },
        { conversationId: "conv-b", phone: "+15550000002", conversationKey: "conv-b", projectionId: "proj-b", stateVersion: 1 },
      ],
    }));
    act(() => result.current.selection.toggleSelected(`sms:${projectionId}`));
    await act(async () => result.current.handleDelete());
    expect(mocks.deleteManagerSmsConversationClient).toHaveBeenCalledExactlyOnceWith({ phone: "", conversationKey: projectionId, projectionId });
    expect(onSmsMutation).toHaveBeenCalledWith({ updated: [], deleted: [projectionId], reconcile: [] });
    expect(mocks.deleteManagerSmsConversationClient).toHaveBeenCalledTimes(1);
    expect(loadedIds).toEqual(["proj-b"]);
  });
});
