import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ load: vi.fn(), stage: vi.fn(), change: vi.fn(), fetch: vi.fn() }));
vi.mock("@/lib/portal-inbox-storage", () => ({
  MANAGER_INBOX_STORAGE_KEY: "manager", loadPersistedInbox: mocks.load,
  stagePersistedInboxRows: mocks.stage, changePersistedInboxThreadFolders: mocks.change,
  deleteInboxThreadIds: vi.fn(),
}));
import { archivePersistedInboxThreads } from "@/lib/communication-inbox-thread-mutations";
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal("fetch", mocks.fetch);
  mocks.change.mockResolvedValue(true); mocks.fetch.mockResolvedValue({ ok: true });
});
it("archives every stored source id behind a collapsed conversation", async () => {
  mocks.load.mockReturnValue([{ id: "email-new", sourceThreadIds: ["email-new", "email-old"], folder: "inbox",
    from: "Sam", email: "sam@example.test", subject: "Hello", preview: "", body: "", time: "", unread: false }]);
  const result = await archivePersistedInboxThreads("manager", ["email-new", "email-old"]);
  expect(result.ok).toBe(true);
  expect(mocks.change).toHaveBeenCalledWith("manager", ["email-new", "email-old"], "archive");
  expect(mocks.fetch).not.toHaveBeenCalled();
  expect(result.next[0]).toMatchObject({ id: "email-new", folder: "trash" });
});
it("leaves local state unchanged when the atomic folder mutation fails", async () => {
  const row = { id: "email-new", folder: "inbox", from: "Sam", email: "sam@example.test", subject: "Hello", preview: "", body: "", time: "", unread: false };
  mocks.load.mockReturnValue([row]); mocks.change.mockResolvedValue(false);
  expect(await archivePersistedInboxThreads("manager", ["email-new"])).toEqual({ ok: false, next: [row] });
  expect(mocks.stage).not.toHaveBeenCalled();
});
it("delegates an SMS notice to its combined folder and follow-up transaction", async () => {
  mocks.load.mockReturnValue([{ id: "sms_notice_a", ownerUserId: "owner", from: "+12065550100", folder: "inbox",
    email: "", subject: "Text", preview: "", body: "", time: "", unread: false }]);
  expect((await archivePersistedInboxThreads("manager", ["sms_notice_a"])).ok).toBe(true);
  expect(mocks.fetch).toHaveBeenCalledWith("/api/manager/tour-follow-ups", expect.objectContaining({
    body: JSON.stringify({ inboxThreadId: "sms_notice_a", action: "archive" }),
  }));
  expect(mocks.change).not.toHaveBeenCalled();
});
