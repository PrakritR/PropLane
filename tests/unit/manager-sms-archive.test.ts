// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  archiveManagerSmsConversation,
  loadManagerSmsArchivedIds,
  MANAGER_SMS_ARCHIVED_STORAGE_KEY,
  MANAGER_SMS_ARCHIVE_CHANGED_EVENT,
  mirrorManagerSmsArchivedFromServer,
  persistManagerSmsArchivedIds,
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

  it("shows the local archive optimistically before the backend confirms (PLAN B3)", async () => {
    let finish!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }));
    const pending = archiveManagerSmsConversation(key);
    // Optimistic: the row is already archived locally while the request is
    // still in flight — Archive must feel instant, not wait on the network.
    expect(loadManagerSmsArchivedIds().has(key)).toBe(true);
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

  it.each([403, 409, 503])("rolls back to the same final local state when the backend refuses archive with HTTP %s (PLAN B3)", async (status) => {
    window.localStorage.setItem(MANAGER_SMS_ARCHIVED_STORAGE_KEY, JSON.stringify(["other-thread"]));
    const before = window.localStorage.getItem(MANAGER_SMS_ARCHIVED_STORAGE_KEY);
    const handler = vi.fn();
    window.addEventListener(MANAGER_SMS_ARCHIVE_CHANGED_EVENT, handler);
    fetchMock.mockResolvedValueOnce(new Response(null, { status }));
    try {
      await expect(archiveManagerSmsConversation(key)).rejects.toThrow("Could not archive");
      // The FINAL state matches exactly (rolled back) — optimistic (PLAN B3)
      // means the local flag is set immediately and then rolled back on
      // failure, so the change event DOES fire (announcing, then undoing),
      // unlike the old wait-first behavior which never touched storage at all.
      expect(window.localStorage.getItem(MANAGER_SMS_ARCHIVED_STORAGE_KEY)).toBe(before);
      expect(handler).toHaveBeenCalled();
    } finally {
      window.removeEventListener(MANAGER_SMS_ARCHIVE_CHANGED_EVENT, handler);
    }
  });

  it("keeps the thread archived if restoring the durable barrier fails", async () => {
    window.localStorage.setItem(MANAGER_SMS_ARCHIVED_STORAGE_KEY, JSON.stringify([key, "other-thread"]));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(restoreManagerSmsConversation(key)).rejects.toThrow("Could not restore");
    expect([...loadManagerSmsArchivedIds()].sort()).toEqual([key, "other-thread"].sort());
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

  /**
   * Regression for the captain resurrection sweep: the 20-second SMS poll's
   * mirror used to REPLACE the entire locally-archived id set with only what
   * the current response explicitly marked `archived: true` — so a
   * conversation merely absent from one response (a partial payload, a
   * different member-key spelling) silently lost its archived flag and
   * resurrected on the next poll. The mirror is additive: absence is never
   * read as "restore it", only an explicit `archived: false` for THAT id is.
   */
  it("never drops a locally-archived id merely because it is absent from the response", () => {
    persistManagerSmsArchivedIds(new Set([key, "other-key"]));
    mirrorManagerSmsArchivedFromServer([
      { conversationKey: "yet-another-key", archived: true },
    ]);
    expect([...loadManagerSmsArchivedIds()].sort()).toEqual(["other-key", "yet-another-key", key].sort());
  });

  it("clears a locally-archived id only when the response explicitly reports it unarchived", () => {
    persistManagerSmsArchivedIds(new Set([key, "other-key"]));
    mirrorManagerSmsArchivedFromServer([{ conversationKey: key, archived: false }]);
    expect([...loadManagerSmsArchivedIds()]).toEqual(["other-key"]);
  });

  it("ignores a poll response already in flight when Archive was clicked, then trusts a later one", async () => {
    let finishArchive!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { finishArchive = resolve; }));
    const pending = archiveManagerSmsConversation(key);

    // A poll response built before this click lands — applying it would
    // visibly bounce the row back to Active for up to the poll interval.
    mirrorManagerSmsArchivedFromServer([{ conversationKey: key, archived: false }]);
    expect(loadManagerSmsArchivedIds().has(key)).toBe(true);

    finishArchive(new Response(null, { status: 204 }));
    await pending;

    // Settled — a genuinely later poll is trusted again.
    mirrorManagerSmsArchivedFromServer([{ conversationKey: key, archived: false }]);
    expect(loadManagerSmsArchivedIds().has(key)).toBe(false);
  });

  it("adds every member key, not just the primary conversationKey, when archived", () => {
    mirrorManagerSmsArchivedFromServer([
      { conversationKey: "primary-key", memberKeys: ["primary-key", "alias-key"], archived: true },
    ]);
    expect([...loadManagerSmsArchivedIds()].sort()).toEqual(["alias-key", "primary-key"]);
  });
});
