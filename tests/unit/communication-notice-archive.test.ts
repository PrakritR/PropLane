import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ load: vi.fn(), stage: vi.fn(), upsert: vi.fn(), fetch: vi.fn() }));
vi.mock("@/lib/portal-inbox-storage", () => ({ MANAGER_INBOX_STORAGE_KEY: "manager", loadPersistedInbox: mocks.load, stagePersistedInboxRows: mocks.stage, upsertPersistedInboxRows: mocks.upsert, deleteInboxThreadIds: vi.fn() }));
import { archivePersistedInboxThreads } from "@/lib/communication-inbox-thread-mutations";
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.load.mockReturnValue([{ id: "sms_notice_a", ownerUserId: "owner", from: "+12065550100", folder: "inbox" }]);
  mocks.fetch.mockResolvedValue({ ok: true });
  mocks.upsert.mockResolvedValue(true);
});
it("creates the authorized barrier before persisting an SMS notice archive", async () => {
  expect((await archivePersistedInboxThreads("manager", ["sms_notice_a"])).ok).toBe(true);
  expect(mocks.fetch).toHaveBeenCalledWith("/api/manager/tour-follow-ups", expect.objectContaining({ body: JSON.stringify({ inboxThreadId: "sms_notice_a", action: "archive" }) }));
  expect(mocks.fetch.mock.invocationCallOrder[0]).toBeLessThan(mocks.upsert.mock.invocationCallOrder[0]);
});
it("does not archive locally when cancellation is denied", async () => {
  mocks.fetch.mockResolvedValue({ ok: false });
  expect((await archivePersistedInboxThreads("manager", ["sms_notice_a"])).ok).toBe(false);
  expect(mocks.stage).not.toHaveBeenCalled();
  expect(mocks.upsert).not.toHaveBeenCalled();
});
