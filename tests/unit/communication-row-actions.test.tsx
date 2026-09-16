// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CommunicationRowActions } from "@/components/portal/communication-row-actions";
import { RECORD_ACTION_DESTRUCTIVE_SETTLE_MS } from "@/components/ui/record-action-menu";
import { useUnifiedCommunicationBulk } from "@/hooks/use-unified-communication-bulk";
import type { PersistedInboxThread } from "@/lib/portal-inbox-storage";
import type { UnifiedInboxListItem } from "@/lib/unified-inbox-merge";

const mocks = vi.hoisted(() => ({ archive: vi.fn(), restore: vi.fn(), remove: vi.fn(), sms: vi.fn(), confirm: vi.fn() }));
vi.mock("@/components/providers/app-ui-provider", () => ({ useConfirm: () => mocks.confirm }));
vi.mock("@/lib/communication-inbox-thread-mutations", () => ({ archivePersistedInboxThreads: mocks.archive, restorePersistedInboxThreads: mocks.restore, deletePersistedInboxThreadsForever: mocks.remove }));
vi.mock("@/lib/manager-sms-archive.client", () => ({ archiveManagerSmsConversation: mocks.sms, restoreManagerSmsConversation: vi.fn() }));
const ASSISTANT_ID = "agent_notice_00000000-0000-4000-8000-000000000001";
const threads = [
  ...["a", "b", "c"].map((id) => ({ id, folder: "inbox", from: id, email: `${id}@example.test`, subject: id, body: id, preview: id, time: "", unread: false } as PersistedInboxThread)),
  // The manager's PropLane Assistant thread (agent notices).
  { id: ASSISTANT_ID, folder: "inbox", from: "PropLane Assistant", email: "", subject: "PropLane Assistant", body: "A prospect texted your work number.", preview: "", time: "", unread: false, threadType: "agent_notice" } as PersistedInboxThread,
  // The assistant-email mirror, titled "PropLane admin" in the list: an ordinary
  // person thread whose first turn happens to be authored by the assistant.
  { id: "assistant-email-proof-1", folder: "inbox", from: "PropLane Assistant", email: "admin@example.test", subject: "Re: Propert", body: "Can I help you find a rental home?", preview: "", time: "", unread: false } as PersistedInboxThread,
];
const rows: UnifiedInboxListItem[] = [
  { key: "email:a", threadId: "a", channel: "email", name: "First", preview: "", time: "", unread: false, sortMs: 1, memberKeys: ["email:a", "email:c", "sms:exact:owner:phone"] },
  { key: "email:c", threadId: "c", channel: "email", name: "Ordinary", preview: "", time: "", unread: false, sortMs: 3, memberKeys: ["email:a", "email:c"] },
  { key: "email:b", threadId: "b", channel: "email", name: "Second", preview: "", time: "", unread: false, sortMs: 2 },
  { key: `email:${ASSISTANT_ID}`, threadId: ASSISTANT_ID, channel: "email", name: "PropLane Assistant", preview: "", time: "", unread: false, sortMs: 4 },
  // Merged person-row whose stored sourceThreadIds still name a thread the
  // list no longer returns — the shape behind "No actions available." on the
  // PropLane admin row.
  { key: "email:assistant-email-proof-1", threadId: "assistant-email-proof-1", channel: "email", name: "PropLane admin", preview: "", time: "", unread: false, sortMs: 5, memberKeys: ["email:assistant-email-proof-1", "email:gone-from-list"] },
];
function Harness({ archived = false, manager = true }: { archived?: boolean; manager?: boolean }) {
  const bulk = useUnifiedCommunicationBulk({ mergedRows: rows, listSegment: archived ? "archived" : "active", storageKey: "test-inbox", emailThreads: threads, onEmailThreadsChange: () => {} });
  return <>{rows.map((row) => <CommunicationRowActions key={row.key} row={row} bulk={bulk} archived={archived} manager={manager} emailThreads={threads} />)}</>;
}
function open(name: string) { fireEvent.keyDown(screen.getByRole("button", { name: `Actions for ${name}` }), { key: "ArrowDown" }); }
/**
 * Opening a menu and immediately activating a destructive item (`variant="danger"`,
 * here `Delete`) races `RECORD_ACTION_DESTRUCTIVE_SETTLE_MS` (record-action-menu.tsx):
 * a click within that window of open is deliberately swallowed. Pin `Date.now` past
 * the window between open and click so this test exercises the deliberate click
 * path rather than racing real wall-clock time.
 */
function openPastDestructiveSettle(name: string) {
  const dateSpy = vi.spyOn(Date, "now").mockReturnValue(0);
  open(name);
  dateSpy.mockReturnValue(RECORD_ACTION_DESTRUCTIVE_SETTLE_MS + 1);
  return () => dateSpy.mockRestore();
}
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
  const restoreClock = openPastDestructiveSettle("Second");
  fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
  restoreClock();
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
  const restoreClock = openPastDestructiveSettle("Ordinary");
  fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
  restoreClock();
  await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith("test-inbox", ["c", "a"]));
  expect(mocks.confirm).toHaveBeenCalledOnce();
});

it("archives the PropLane Assistant and PropLane admin conversations like any other row", async () => {
  render(<Harness />);
  open("PropLane Assistant"); fireEvent.click(await screen.findByRole("menuitem", { name: "Archive" }));
  await waitFor(() => expect(mocks.archive).toHaveBeenLastCalledWith("test-inbox", [ASSISTANT_ID]));
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  open("PropLane admin"); fireEvent.click(await screen.findByRole("menuitem", { name: "Archive" }));
  await waitFor(() => expect(mocks.archive).toHaveBeenLastCalledWith("test-inbox", ["assistant-email-proof-1", "gone-from-list"]));
  expect(mocks.sms).not.toHaveBeenCalled();
});

it("offers the assistant and admin rows Archive in a role portal too", async () => {
  render(<Harness manager={false} />);
  open("PropLane Assistant");
  await screen.findByRole("menuitem", { name: "Archive" });
  expect(screen.queryByRole("menuitem", { name: "Edit" })).toBeNull();
});

it("restores an archived PropLane Assistant but never deletes it forever", async () => {
  render(<Harness archived />);
  open("PropLane Assistant");
  await screen.findByRole("menuitem", { name: "Restore" });
  expect(screen.queryByRole("menuitem", { name: "Delete" })).toBeNull();
  fireEvent.click(screen.getByRole("menuitem", { name: "Restore" }));
  await waitFor(() => expect(mocks.restore).toHaveBeenCalledWith("test-inbox", [ASSISTANT_ID]));
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  // The admin mirror is an ordinary person thread: Restore and Delete both stay.
  open("PropLane admin");
  await screen.findByRole("menuitem", { name: "Restore" });
  expect(screen.getByRole("menuitem", { name: "Delete" })).toBeTruthy();
});
