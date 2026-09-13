// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mode = vi.hoisted(() => ({ demo: false }));
vi.mock("@/lib/demo/demo-session", () => ({ isDemoModeActive: () => mode.demo }));
import { archivePersistedInboxThreads, restorePersistedInboxThreads } from "@/lib/communication-inbox-thread-mutations";
import {
  changePersistedInboxThreadFolders, loadPersistedInbox, stagePersistedInboxRows,
  MANAGER_INBOX_STORAGE_KEY as key, type PersistedInboxThread,
} from "@/lib/portal-inbox-storage";
const fetchMock = vi.fn();
const actions = ["archive", "restore"] as const;
function storedRow(sms: boolean, action: typeof actions[number]): PersistedInboxThread {
  return {
    id: sms ? "sms_notice_new" : "email-new",
    sourceThreadIds: sms ? ["sms_notice_new", "sms_notice_old"] : ["email-new", "email-old"],
    ownerUserId: "owner", from: sms ? "+12065550100" : "Sam", email: sms ? "" : "sam@example.test",
    folder: action === "archive" ? "sent" : "trash", previousFolder: action === "restore" ? "sent" : undefined,
    subject: "Hello", preview: "Latest", body: "Original", time: "Sep 12, 10:00 AM", unread: false,
  };
}
function mutate(action: typeof actions[number], ids: string[]) {
  return action === "archive" ? archivePersistedInboxThreads(key, ids) : restorePersistedInboxThreads(key, ids);
}
beforeEach(() => {
  mode.demo = false;
  fetchMock.mockReset().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());
it.each(actions)("%s excludes every collapsed SMS source from ordinary writes", async (action) => {
  const row = storedRow(true, action);
  stagePersistedInboxRows(key, [row]);
  const result = await mutate(action, row.sourceThreadIds!);
  expect(result.ok).toBe(true);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledWith("/api/manager/tour-follow-ups", expect.objectContaining({
    body: JSON.stringify({ inboxThreadId: row.id, action }),
  }));
  expect(loadPersistedInbox(key, [])[0].folder).toBe(action === "archive" ? "trash" : "sent");
});
it.each(actions)("%s preserves local state when the SMS transaction fails", async (action) => {
  const row = storedRow(true, action);
  stagePersistedInboxRows(key, [row]);
  fetchMock.mockResolvedValue({ ok: false });
  expect(await mutate(action, row.sourceThreadIds!)).toEqual({ ok: false, next: [row] });
  expect(loadPersistedInbox(key, [])).toEqual([row]);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
it.each(actions.flatMap(action => [false, true].map(sms => ({ action, sms }))))(
  "demo $action remains local for SMS=$sms", async ({ action, sms }) => {
    mode.demo = true;
    const row = storedRow(sms, action);
    stagePersistedInboxRows(key, [row]);
    const result = await mutate(action, row.sourceThreadIds!);
    expect(result.ok).toBe(true);
    expect(loadPersistedInbox(key, [])[0].folder).toBe(action === "archive" ? "trash" : "sent");
    expect(result.next[0].body).toBe("Original");
    expect(fetchMock).not.toHaveBeenCalled();
  },
);
it.each(actions)("demo direct folder helper %s never fetches", async (action) => {
  mode.demo = true;
  expect(await changePersistedInboxThreadFolders(key, ["email-new"], action)).toBe(true);
  expect(fetchMock).not.toHaveBeenCalled();
});
