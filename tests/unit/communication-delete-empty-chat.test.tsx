// @vitest-environment jsdom
//
// Deleting an empty chat is permanent: a "No messages yet" placeholder has no stored thread, so
// Delete (and Delete all archived on the thread an archived placeholder became) dismisses the
// person for this workspace instead of calling the stored-thread delete that rebuilt it on reload.
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UnifiedInboxListItem } from "@/lib/unified-inbox-merge";
import type { PersistedInboxThread } from "@/lib/portal-inbox-storage";

const deleteForever = vi.hoisted(() => vi.fn(async () => ({ ok: true, next: [] as unknown[] })));

vi.mock("@/lib/communication-inbox-thread-mutations", () => ({
  archivePersistedInboxThreads: vi.fn(),
  clearPersistedInboxThread: vi.fn(),
  deletePersistedInboxThreadsForever: deleteForever,
  previewArchivedInboxThreads: vi.fn(),
  previewRestoredInboxThreads: vi.fn(),
  restorePersistedInboxThreads: vi.fn(),
}));
vi.mock("@/lib/manager-sms-conversations-client", () => ({
  deleteManagerSmsConversationClient: vi.fn(),
  updateManagerSmsConversationStateClient: vi.fn(),
}));
vi.mock("@/lib/manager-sms-archive.client", () => ({
  archiveManagerSmsConversation: vi.fn(),
  loadManagerSmsArchivedIds: vi.fn(() => new Set()),
  persistManagerSmsArchivedIds: vi.fn(),
  restoreManagerSmsConversation: vi.fn(),
}));
vi.mock("@/components/providers/app-ui-provider", () => ({ useConfirm: () => async () => true }));

import { useUnifiedCommunicationBulk } from "@/hooks/use-unified-communication-bulk";

function item(threadId: string, email: string): UnifiedInboxListItem {
  return {
    key: `email:${threadId}`,
    channel: "email",
    threadId,
    personKey: email,
    personEmail: email,
    name: email,
    preview: "No messages yet.",
    time: "",
    unread: false,
    sortMs: 0,
  } as UnifiedInboxListItem;
}

function setup(rows: UnifiedInboxListItem[], emailThreads: PersistedInboxThread[], segment: "active" | "archived", dismiss = vi.fn(async () => true)) {
  const hook = renderHook(() =>
    useUnifiedCommunicationBulk({
      mergedRows: rows,
      listSegment: segment,
      storageKey: "k",
      emailThreads,
      onEmailThreadsChange: vi.fn(),
      onDismissContacts: dismiss,
    }),
  );
  return { hook, dismiss };
}

beforeEach(() => deleteForever.mockClear());
afterEach(cleanup);

describe("deleting an empty chat", () => {
  it("Delete on a placeholder dismisses the person and never calls the stored-thread delete", async () => {
    const { hook, dismiss } = setup([item("contact-res-1", "Khue@Example.test")], [], "active");
    await act(async () => {
      await hook.result.current.handleDelete(["email:contact-res-1"]);
    });
    expect(dismiss).toHaveBeenCalledWith(["khue@example.test"]);
    expect(deleteForever).not.toHaveBeenCalled();
  });

  it("Delete all archived dismisses the person behind the archived placeholder thread and deletes the thread", async () => {
    const stored = [{ id: "contact_thread_res-1", email: "khue@example.test" }] as unknown as PersistedInboxThread[];
    const { hook, dismiss } = setup([item("contact_thread_res-1", "khue@example.test")], stored, "archived");
    await act(async () => {
      await hook.result.current.handleDeleteAllArchived();
    });
    expect(dismiss).toHaveBeenCalledWith(["khue@example.test"]);
    expect(deleteForever).toHaveBeenCalledWith("k", ["contact_thread_res-1"]);
  });

  it("an ordinary conversation is deleted without a dismissal", async () => {
    const stored = [{ id: "thread-9", email: "x@example.test" }] as unknown as PersistedInboxThread[];
    const { hook, dismiss } = setup([item("thread-9", "x@example.test")], stored, "archived");
    await act(async () => {
      await hook.result.current.handleDelete(["email:thread-9"]);
    });
    expect(dismiss).not.toHaveBeenCalled();
    expect(deleteForever).toHaveBeenCalledWith("k", ["thread-9"]);
  });

  it("a dismissal that cannot be saved keeps the row and deletes nothing", async () => {
    const stored = [{ id: "contact_thread_res-1", email: "khue@example.test" }] as unknown as PersistedInboxThread[];
    const { hook } = setup([item("contact_thread_res-1", "khue@example.test")], stored, "archived", vi.fn(async () => false));
    await act(async () => {
      await hook.result.current.handleDelete(["email:contact_thread_res-1"]);
    });
    expect(deleteForever).not.toHaveBeenCalled();
  });
});
