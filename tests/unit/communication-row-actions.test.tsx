// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CommunicationRowActions } from "@/components/portal/communication-row-actions";
import { useUnifiedCommunicationBulk } from "@/hooks/use-unified-communication-bulk";
import type { PersistedInboxThread } from "@/lib/portal-inbox-storage";
import type { UnifiedInboxListItem } from "@/lib/unified-inbox-merge";

const mocks = vi.hoisted(() => ({ archive: vi.fn(), restore: vi.fn(), remove: vi.fn(), sms: vi.fn(), confirm: vi.fn() }));
vi.mock("@/components/providers/app-ui-provider", () => ({ useConfirm: () => mocks.confirm }));
vi.mock("@/lib/communication-inbox-thread-mutations", () => ({ archivePersistedInboxThreads: mocks.archive, restorePersistedInboxThreads: mocks.restore, deletePersistedInboxThreadsForever: mocks.remove }));
vi.mock("@/lib/manager-sms-archive.client", () => ({ archiveManagerSmsConversation: mocks.sms, restoreManagerSmsConversation: vi.fn() }));
const threads = ["a", "b", "c"].map((id) => ({ id, folder: "inbox", from: id, email: `${id}@example.test`, subject: id, body: id, preview: id, time: "", unread: false } as PersistedInboxThread));
const rows: UnifiedInboxListItem[] = [
  { key: "email:a", threadId: "a", channel: "email", name: "First", preview: "", time: "", unread: false, sortMs: 1, memberKeys: ["email:a", "email:c", "sms:exact:owner:phone"] },
  { key: "email:c", threadId: "c", channel: "email", name: "Ordinary", preview: "", time: "", unread: false, sortMs: 3, memberKeys: ["email:a", "email:c"] },
  { key: "email:b", threadId: "b", channel: "email", name: "Second", preview: "", time: "", unread: false, sortMs: 2 },
];
function Harness({ archived = false, manager = true }: { archived?: boolean; manager?: boolean }) {
  const bulk = useUnifiedCommunicationBulk({ mergedRows: rows, listSegment: archived ? "archived" : "active", storageKey: "test-inbox", emailThreads: threads, onEmailThreadsChange: () => {} });
  return <>{rows.map((row) => <CommunicationRowActions key={row.key} row={row} bulk={bulk} archived={archived} manager={manager} emailThreads={threads} />)}</>;
}
function open(name: string) { fireEvent.keyDown(screen.getByRole("button", { name: `Actions for ${name}` }), { key: "ArrowDown" }); }
beforeEach(() => {
  vi.clearAllMocks();
  for (const fn of [mocks.archive, mocks.restore, mocks.remove]) fn.mockResolvedValue({ ok: true, next: threads });
  mocks.confirm.mockResolvedValue(true);
});
afterEach(cleanup);
it("targets all exact merged members, then only the next conversation", async () => {
  render(<Harness />);
  open("First"); fireEvent.click(await screen.findByRole("menuitem", { name: "Archive" }));
  await waitFor(() => expect(mocks.sms).toHaveBeenCalledWith("exact:owner:phone"));
  expect(mocks.archive).toHaveBeenLastCalledWith("test-inbox", ["a", "c"]);
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  open("Second"); fireEvent.click(await screen.findByRole("menuitem", { name: "Archive" }));
  await waitFor(() => expect(mocks.archive).toHaveBeenLastCalledWith("test-inbox", ["b"]));
  expect(mocks.sms).toHaveBeenCalledTimes(1);
});
it("closes before confirmation and preserves cancellation of permanent deletion", async () => {
  mocks.confirm.mockImplementation(async () => { expect(screen.queryByRole("menu")).toBeNull(); return false; });
  render(<Harness archived />);
  open("Second"); fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
  await waitFor(() => expect(mocks.confirm).toHaveBeenCalledOnce());
  expect(mocks.remove).not.toHaveBeenCalled();
});
it("restores only the chosen archived conversation", async () => {
  render(<Harness archived />); open("Second");
  fireEvent.click(await screen.findByRole("menuitem", { name: "Restore" }));
  await waitFor(() => expect(mocks.restore).toHaveBeenCalledWith("test-inbox", ["b"]));
});
it("does not offer manager SMS mutations in a role portal", async () => {
  render(<Harness manager={false} />); open("First");
  await screen.findByText("No actions available.");
  expect(screen.queryByRole("menuitem", { name: "Archive" })).toBeNull();
});

it("deletes all ordinary email members after confirmation", async () => {
  render(<Harness archived />);
  open("Ordinary");
  fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
  await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith("test-inbox", ["c", "a"]));
  expect(mocks.confirm).toHaveBeenCalledOnce();
});
