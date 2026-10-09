// @vitest-environment jsdom
/**
 * The unified Communication inbox takes its data from an adapter
 * (`CommunicationInboxAdapter`). The manager adapter must keep doing exactly what
 * the inbox always did against the manager's sources; the admin adapter serves
 * the same contract from admin's endpoints. Both are held to one contract here,
 * then each to its own guarantees.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement } from "react";
import type { CommunicationInboxAdapter } from "@/lib/communication/inbox-adapter";
import type { PersistedInboxThread } from "@/lib/portal-inbox-storage";
import type { InboxMessage } from "@/lib/demo-admin-partner-inbox";

const syncPersistedMock = vi.fn(async (..._args: unknown[]) => ({ rows: [] as PersistedInboxThread[], ok: true }));

vi.mock("@/lib/portal-inbox-storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/portal-inbox-storage")>()),
  syncPersistedInboxFromServerWithStatus: (...args: unknown[]) => syncPersistedMock(...args),
}));
vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
}));
vi.mock("@/components/portal/pro-work-number-card", () => ({ ManagerWorkNumberCard: () => null }));
vi.mock("@/components/portal/pro-sms-panel", () => ({
  ManagerSmsPanel: () => null,
  smsOutboundPreviewPrefix: () => "",
}));

import { managerInboxAdapter } from "@/components/portal/communication-adapters/manager-inbox-adapter";
import { createAdminInboxAdapter } from "@/components/portal/communication-adapters/admin-inbox-adapter";
import { resetAdminScheduledForTests } from "@/lib/admin-inbox-source";
import { seedDemoAdminInbox } from "@/lib/demo-admin-partner-inbox";
import { resetManagerSmsConversationsClientCacheForTests } from "@/lib/manager-sms-conversations-client";

function adminMessage(overrides: Partial<InboxMessage> & Pick<InboxMessage, "id" | "folder">): InboxMessage {
  return {
    name: "Jamie Rivera",
    email: "jamie@example.test",
    topic: "Question",
    body: "Hello",
    createdAt: "2026-10-01T17:00:00.000Z",
    read: false,
    senderRole: "manager",
    thread: [],
    ...overrides,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  syncPersistedMock.mockClear();
  resetAdminScheduledForTests();
  resetManagerSmsConversationsClientCacheForTests();
  fetchMock = vi.fn(async (url: string) => {
    if (String(url).includes("sms-conversations")) return Response.json({ residents: [], workNumber: null });
    if (String(url).includes("scheduled-inbox-messages")) return Response.json({ messages: [] });
    return Response.json({ ok: true, rows: [] });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const ADAPTERS: [string, () => CommunicationInboxAdapter, string][] = [
  ["manager", () => managerInboxAdapter, "/api/manager/sms-conversations"],
  ["admin", () => createAdminInboxAdapter({ smsUiEnabled: true }), "/api/admin/sms-conversations"],
];

describe.each(ADAPTERS)("the %s adapter satisfies the inbox contract", (kind, make, smsEndpoint) => {
  it("names itself and its thread store", () => {
    const adapter = make();
    expect(adapter.kind).toBe(kind);
    expect(adapter.storageKey).toMatch(/\S/);
    expect(adapter.threadsChangedEvent).toMatch(/\S/);
  });

  it("reads cached threads as rows and builds the list from them without mutating them", () => {
    const adapter = make();
    const cached = adapter.loadCachedThreads();
    expect(Array.isArray(cached)).toBe(true);
    const rows: PersistedInboxThread[] = [
      {
        id: "t1",
        folder: "inbox",
        from: "Sam",
        email: "sam@example.test",
        subject: "Hi",
        preview: "Hi",
        body: "Hi",
        time: "Oct 1, 9:00 AM",
        unread: true,
      },
    ];
    const frozen = JSON.stringify(rows);
    const built = adapter.buildListThreads(rows, { viewerId: "viewer-1", workspace: null, smsUiEnabled: true });
    expect(Array.isArray(built)).toBe(true);
    expect(built.some((thread) => thread.id === "t1")).toBe(true);
    expect(JSON.stringify(rows)).toBe(frozen);
  });

  it("loads the text stream from its own endpoint and answers a Response", async () => {
    const adapter = make();
    const res = await adapter.loadSmsConversations({ viewerId: "viewer-1", force: true, workspaceId: null, cursor: null });
    expect(res.ok).toBe(true);
    expect(Array.isArray(((await res.json()) as { residents: unknown[] }).residents)).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith(smsEndpoint))).toBe(true);
  });

  it("drops its text cache for one id or two without throwing", () => {
    const adapter = make();
    expect(() => adapter.invalidateSmsConversations()).not.toThrow();
    expect(() => adapter.invalidateSmsConversations("viewer-1")).not.toThrow();
    expect(() => adapter.invalidateSmsConversations("viewer-1", "workspace-1")).not.toThrow();
  });

  it("syncs its threads to an ok/rows result", async () => {
    const adapter = make();
    const result = await adapter.syncThreads();
    expect(typeof result.ok).toBe("boolean");
    expect(Array.isArray(result.rows)).toBe(true);
  });

  it("draws identity boxes", () => {
    expect(isValidElement(make().identityBoxes)).toBe(true);
  });
});

describe("the manager adapter keeps today's behaviour", () => {
  it("reads and writes the manager inbox cache, with one-argument sync when there are no options", async () => {
    await managerInboxAdapter.syncThreads();
    expect(syncPersistedMock).toHaveBeenLastCalledWith("axis_portal_inbox_manager_v1");
    await managerInboxAdapter.syncThreads({ force: true });
    expect(syncPersistedMock).toHaveBeenLastCalledWith("axis_portal_inbox_manager_v1", { force: true });
    expect(managerInboxAdapter.storageKey).toBe("axis_portal_inbox_manager_v1");
  });

  it("pins the PropLane Assistant, folds email and text through the direct chat, and archives text", () => {
    expect(managerInboxAdapter.pinsAssistant).toBe(true);
    expect(managerInboxAdapter.directChat).toBe(true);
    expect(managerInboxAdapter.smsArchivable).toBe(true);
    expect(managerInboxAdapter.ThreadPane).toBeUndefined();
    // Mutations stay the storage-key based ones (the bulk hook's default).
    expect(managerInboxAdapter.emailMutations).toBeUndefined();
  });

  it("reads one text conversation at the manager route", () => {
    expect(managerInboxAdapter.smsDetailPath?.("a b")).toBe("/api/manager/sms-conversations/a%20b");
  });

  it("adds the Assistant thread to the Active list", () => {
    const built = managerInboxAdapter.buildListThreads([], {
      viewerId: "viewer-1",
      workspace: null,
      smsUiEnabled: true,
    });
    expect(built.some((thread) => /assistant/i.test(`${thread.id} ${thread.from}`))).toBe(true);
  });
});

describe("the admin adapter serves admin's own sources", () => {
  const adapter = () => createAdminInboxAdapter({ smsUiEnabled: true });

  it("never pins the Assistant, never folds through the manager's direct chat, and archives no texts", () => {
    const a = adapter();
    expect(a.pinsAssistant).toBe(false);
    expect(a.directChat).toBe(false);
    expect(a.smsArchivable).toBe(false);
    expect(a.syncDirectory).toBeUndefined();
    expect(a.ThreadPane).toBeTypeOf("function");
    // Admin has no per-conversation text read; the manager route must never be asked.
    expect(a.smsDetailPath).toBeUndefined();
  });

  it("syncs the admin-scope rows and reports a failed read as not ok", async () => {
    seedDemoAdminInbox([adminMessage({ id: "m1", folder: "inbox" })]);
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes("scope=admin") ? new Response(null, { status: 500 }) : Response.json({ messages: [] }),
    );
    const failed = await adapter().syncThreads({ force: true });
    expect(failed.ok).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url) === "/api/portal-inbox-threads?scope=admin")).toBe(true);
    // The rows already held stay on screen.
    expect(failed.rows.map((row) => row.id)).toEqual(["m1"]);

    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes("scope=admin")
        ? Response.json({ rows: [{ ...adminMessage({ id: "m2", folder: "inbox" }), scope: "admin" }] })
        : Response.json({ messages: [] }),
    );
    const ok = await adapter().syncThreads({ force: true });
    expect(ok.ok).toBe(true);
    expect(ok.rows.map((row) => row.id)).toContain("m2");
  });

  it("does not read the text stream at all when it is switched off", async () => {
    const off = createAdminInboxAdapter({ smsUiEnabled: false });
    const res = await off.loadSmsConversations({ viewerId: "v", force: true });
    expect(res.ok).toBe(true);
    expect(((await res.json()) as { residents: unknown[] }).residents).toEqual([]);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("sms-conversations"))).toBe(false);
  });

  it("archives, restores and deletes admin messages through its own store, and archive survives a restore", async () => {
    seedDemoAdminInbox([
      adminMessage({ id: "inbox-1", folder: "inbox" }),
      adminMessage({ id: "sent-1", folder: "sent", email: "sam@example.test", read: true }),
    ]);
    const mutations = adapter().emailMutations!;

    const archived = await mutations.archive(["inbox-1", "sent-1"]);
    expect(archived.ok).toBe(true);
    expect(archived.next.map((t) => [t.id, t.folder, t.previousFolder])).toEqual([
      ["inbox-1", "trash", "inbox"],
      ["sent-1", "trash", "sent"],
    ]);

    const restored = await mutations.restore(["inbox-1", "sent-1"]);
    expect(restored.ok).toBe(true);
    expect(restored.next.map((t) => [t.id, t.folder])).toEqual([
      ["inbox-1", "inbox"],
      ["sent-1", "sent"],
    ]);

    await mutations.archive(["inbox-1"]);
    const deleted = await mutations.deleteForever(["inbox-1"]);
    expect(deleted.ok).toBe(true);
    expect(deleted.next.map((t) => t.id)).toEqual(["sent-1"]);
  });

  it("refuses to archive a conversation drawn only for a scheduled send", async () => {
    seedDemoAdminInbox([]);
    const result = await adapter().emailMutations!.archive(["scheduled-someone@example.test"]);
    expect(result.ok).toBe(false);
  });
});
