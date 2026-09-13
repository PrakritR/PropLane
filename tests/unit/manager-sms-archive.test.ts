// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  archiveManagerSmsConversation,
  loadManagerSmsArchivedIds,
  MANAGER_SMS_ARCHIVED_STORAGE_KEY,
  MANAGER_SMS_ARCHIVE_CHANGED_EVENT,
  restoreManagerSmsConversation,
} from "@/lib/manager-sms-archive.client";

const key = "owner:resident:abc";
const fetchMock = vi.fn<typeof fetch>();

describe("manager SMS archive storage", () => {
  beforeEach(() => {
    window.localStorage.removeItem(MANAGER_SMS_ARCHIVED_STORAGE_KEY);
    fetchMock.mockReset().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    window.localStorage.removeItem(MANAGER_SMS_ARCHIVED_STORAGE_KEY);
    vi.unstubAllGlobals();
  });

  it("archives and restores only after the authenticated backend action succeeds", async () => {
    expect(loadManagerSmsArchivedIds().size).toBe(0);
    await archiveManagerSmsConversation(` ${key} `);
    expect(loadManagerSmsArchivedIds().has(key)).toBe(true);
    await restoreManagerSmsConversation(key);
    expect(loadManagerSmsArchivedIds().has(key)).toBe(false);
    expect(fetchMock.mock.calls).toEqual([
      ["/api/manager/tour-follow-ups", {
        method: "PATCH", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationKey: key, action: "archive" }),
      }],
      ["/api/manager/tour-follow-ups", {
        method: "PATCH", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationKey: key, action: "restore" }),
      }],
    ]);
  });

  it("does not show local archive success while the cancellation barrier is still pending", async () => {
    let finish!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }));
    const pending = archiveManagerSmsConversation(key);
    expect(loadManagerSmsArchivedIds().has(key)).toBe(false);
    finish(new Response(null, { status: 204 }));
    await pending;
    expect(loadManagerSmsArchivedIds().has(key)).toBe(true);
  });

  it("dispatches a change event once per successful state update", async () => {
    const handler = vi.fn();
    window.addEventListener(MANAGER_SMS_ARCHIVE_CHANGED_EVENT, handler);
    try {
      await archiveManagerSmsConversation(key);
      await restoreManagerSmsConversation(key);
      expect(handler).toHaveBeenCalledTimes(2);
    } finally {
      window.removeEventListener(MANAGER_SMS_ARCHIVE_CHANGED_EVENT, handler);
    }
  });

  it.each([403, 409, 503])("preserves local state when the backend refuses archive with HTTP %s", async (status) => {
    window.localStorage.setItem(MANAGER_SMS_ARCHIVED_STORAGE_KEY, JSON.stringify(["other-thread"]));
    const before = window.localStorage.getItem(MANAGER_SMS_ARCHIVED_STORAGE_KEY);
    const handler = vi.fn();
    window.addEventListener(MANAGER_SMS_ARCHIVE_CHANGED_EVENT, handler);
    fetchMock.mockResolvedValueOnce(new Response(null, { status }));
    try {
      await expect(archiveManagerSmsConversation(key)).rejects.toThrow("Could not archive");
      expect(window.localStorage.getItem(MANAGER_SMS_ARCHIVED_STORAGE_KEY)).toBe(before);
      expect(handler).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(MANAGER_SMS_ARCHIVE_CHANGED_EVENT, handler);
    }
  });

  it("keeps the thread archived if restoring the durable barrier fails", async () => {
    window.localStorage.setItem(MANAGER_SMS_ARCHIVED_STORAGE_KEY, JSON.stringify([key, "other-thread"]));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(restoreManagerSmsConversation(key)).rejects.toThrow("Could not restore");
    expect([...loadManagerSmsArchivedIds()]).toEqual([key, "other-thread"]);
  });

  it("surfaces network failure and leaves local state untouched", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    await expect(archiveManagerSmsConversation(key)).rejects.toThrow("offline");
    expect(loadManagerSmsArchivedIds().size).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ignores blank ids without issuing a backend action", async () => {
    await archiveManagerSmsConversation(" ");
    await restoreManagerSmsConversation(" ");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(MANAGER_SMS_ARCHIVED_STORAGE_KEY)).toBeNull();
  });
});
