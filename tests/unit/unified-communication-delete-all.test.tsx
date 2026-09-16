// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useUnifiedCommunicationBulk } from "@/hooks/use-unified-communication-bulk";
import type { PersistedInboxThread } from "@/lib/portal-inbox-storage";
import type { UnifiedInboxListItem } from "@/lib/unified-inbox-merge";

const mocks = vi.hoisted(() => ({
  remove: vi.fn(),
  smsDelete: vi.fn(),
  confirm: vi.fn(),
}));
vi.mock("@/components/providers/app-ui-provider", () => ({ useConfirm: () => mocks.confirm }));
vi.mock("@/lib/communication-inbox-thread-mutations", () => ({
  archivePersistedInboxThreads: vi.fn(),
  restorePersistedInboxThreads: vi.fn(),
  deletePersistedInboxThreadsForever: mocks.remove,
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
  { id: ASSISTANT_ID, folder: "inbox", from: "PropLane Assistant", email: "", subject: "PropLane Assistant", body: "Hi", preview: "", time: "", unread: false, threadType: "agent_notice" } as PersistedInboxThread,
];
const rows: UnifiedInboxListItem[] = [
  { key: "email:a", threadId: "a", channel: "email", name: "First", preview: "", time: "", unread: false, sortMs: 1 },
  { key: `email:${ASSISTANT_ID}`, threadId: ASSISTANT_ID, channel: "email", name: "PropLane Assistant", preview: "", time: "", unread: false, sortMs: 2 },
];

function Harness({ segment = "archived" as const }: { segment?: "active" | "archived" }) {
  const bulk = useUnifiedCommunicationBulk({
    mergedRows: rows,
    listSegment: segment,
    storageKey: "test-inbox",
    emailThreads: threads,
    onEmailThreadsChange: () => {},
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
  mocks.smsDelete.mockResolvedValue({ ok: true });
  mocks.confirm.mockResolvedValue(true);
});
afterEach(cleanup);

it("deletes ordinary archived conversations and skips PropLane Assistant", async () => {
  render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "Delete all archived" }));
  await waitFor(() => expect(mocks.confirm).toHaveBeenCalledOnce());
  expect(mocks.confirm.mock.calls[0]![0]).toMatchObject({
    description: "Delete 1 archived conversation forever?",
  });
  await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith("test-inbox", ["a"]));
  expect(mocks.remove.mock.calls[0]![1]).not.toContain(ASSISTANT_ID);
});

it("does not delete from Active", async () => {
  render(<Harness segment="active" />);
  fireEvent.click(screen.getByRole("button", { name: "Delete all archived" }));
  await waitFor(() => expect(mocks.confirm).not.toHaveBeenCalled());
  expect(mocks.remove).not.toHaveBeenCalled();
});
