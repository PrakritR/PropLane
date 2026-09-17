// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useUnifiedCommunicationBulk } from "@/hooks/use-unified-communication-bulk";
import type { PersistedInboxThread } from "@/lib/portal-inbox-storage";
import type { UnifiedInboxListItem } from "@/lib/unified-inbox-merge";

const mocks = vi.hoisted(() => ({
  remove: vi.fn(),
  clear: vi.fn(),
  smsDelete: vi.fn(),
  confirm: vi.fn(),
}));
vi.mock("@/components/providers/app-ui-provider", () => ({ useConfirm: () => mocks.confirm }));
vi.mock("@/lib/communication-inbox-thread-mutations", () => ({
  archivePersistedInboxThreads: vi.fn(),
  restorePersistedInboxThreads: vi.fn(),
  deletePersistedInboxThreadsForever: mocks.remove,
  clearPersistedInboxThread: mocks.clear,
}));
vi.mock("@/lib/manager-sms-archive.client", () => ({
  archiveManagerSmsConversation: vi.fn(),
  restoreManagerSmsConversation: vi.fn(),
  loadManagerSmsArchivedIds: () => new Set(),
  persistManagerSmsArchivedIds: vi.fn(),
}));
vi.mock("@/lib/manager-sms-conversations-client", () => ({
  deleteManagerSmsConversationClient: mocks.smsDelete,
}));

const ASSISTANT_ID = "agent_notice_00000000-0000-4000-8000-000000000001";
const threads = [
  { id: "a", folder: "trash", from: "First", email: "a@example.test", subject: "a", body: "a", preview: "a", time: "", unread: false } as PersistedInboxThread,
  { id: ASSISTANT_ID, folder: "inbox", from: "PropLane Assistant", email: "", subject: "PropLane Assistant", body: "Hi", preview: "Hi", time: "", unread: false, threadType: "agent_notice" } as PersistedInboxThread,
];
const rows: UnifiedInboxListItem[] = [
  { key: "email:a", threadId: "a", channel: "email", name: "First", preview: "", time: "", unread: false, sortMs: 1 },
  { key: `email:${ASSISTANT_ID}`, threadId: ASSISTANT_ID, channel: "email", name: "PropLane Assistant", preview: "", time: "", unread: false, sortMs: 2 },
  { key: "sms:sms-1", threadId: "sms-1", channel: "sms", name: "+15551230001", preview: "", time: "", unread: false, sortMs: 3 },
  { key: "sms:sms-2", threadId: "sms-2", channel: "sms", name: "+15551230002", preview: "", time: "", unread: false, sortMs: 4 },
];
const smsTargets = [
  { conversationId: "sms-1", phone: "", conversationKey: "sms-1" },
  { conversationId: "sms-2", phone: "+15551230002", conversationKey: "sms-2" },
];

function Harness({
  segment = "archived" as const,
  listRows = rows,
}: {
  segment?: "active" | "archived";
  listRows?: UnifiedInboxListItem[];
}) {
  const bulk = useUnifiedCommunicationBulk({
    mergedRows: listRows,
    listSegment: segment,
    storageKey: "test-inbox",
    emailThreads: threads,
    onEmailThreadsChange: () => {},
    smsTargets,
    assistantPlaceholder: {
      from: "PropLane Assistant",
      subject: "PropLane Assistant",
      preview: "Ask about this workspace’s portfolio, residents, leases, and maintenance.",
    },
  });
  return (
    <button type="button" onClick={() => void bulk.handleDeleteAllArchived()}>
      Delete all archived
    </button>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.remove.mockResolvedValue({ ok: true, next: threads.filter((t) => t.id === ASSISTANT_ID) });
  mocks.clear.mockResolvedValue({ ok: true, next: threads.filter((t) => t.id === ASSISTANT_ID) });
  mocks.smsDelete.mockResolvedValue({ ok: true });
  mocks.confirm.mockResolvedValue(true);
});
afterEach(cleanup);

it("deletes ordinary archived conversations and clears PropLane Assistant", async () => {
  render(<Harness listRows={rows.slice(0, 2)} />);
  fireEvent.click(screen.getByRole("button", { name: "Delete all archived" }));
  await waitFor(() => expect(mocks.confirm).toHaveBeenCalledOnce());
  expect(mocks.confirm.mock.calls[0]![0]).toMatchObject({
    description: "Delete 1 archived conversation forever?",
  });
  await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith("test-inbox", ["a"]));
  expect(mocks.remove.mock.calls[0]![1]).not.toContain(ASSISTANT_ID);
  await waitFor(() => expect(mocks.clear).toHaveBeenCalledWith(
    "test-inbox",
    ASSISTANT_ID,
    expect.objectContaining({ from: "PropLane Assistant" }),
  ));
});

it("finishes remaining SMS deletes after the first text conversation fails", async () => {
  mocks.smsDelete
    .mockResolvedValueOnce({ ok: false, error: "Could not delete conversation." })
    .mockResolvedValueOnce({ ok: true });
  render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "Delete all archived" }));
  await waitFor(() => expect(mocks.smsDelete).toHaveBeenCalledTimes(2));
  expect(mocks.smsDelete).toHaveBeenNthCalledWith(1, {
    phone: "+15551230001",
    conversationKey: "sms-1",
  });
  expect(mocks.smsDelete).toHaveBeenNthCalledWith(2, {
    phone: "+15551230002",
    conversationKey: "sms-2",
  });
  await waitFor(() => expect(mocks.remove).toHaveBeenCalled());
});

it("does not delete from Active", async () => {
  render(<Harness segment="active" />);
  fireEvent.click(screen.getByRole("button", { name: "Delete all archived" }));
  await waitFor(() => expect(mocks.confirm).not.toHaveBeenCalled());
  expect(mocks.remove).not.toHaveBeenCalled();
  expect(mocks.clear).not.toHaveBeenCalled();
});
