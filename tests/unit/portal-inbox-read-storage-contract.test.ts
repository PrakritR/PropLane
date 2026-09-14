// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MANAGER_INBOX_STORAGE_KEY,
  collapseAssistantInboxThreads,
  collapsePersonInboxThreads,
  markPersistedInboxSourcesRead,
  persistInbox,
  reconcileObservedInboxReadRows,
  type PersistedInboxThread,
} from "@/lib/portal-inbox-storage";

const source = (id: string, body: string, extras: Partial<PersistedInboxThread> = {}): PersistedInboxThread => ({
  id,
  folder: "inbox",
  from: "Resident",
  email: "resident@example.com",
  subject: body,
  preview: body,
  body,
  time: "Sep 13, 2026",
  unread: true,
  readSources: [{ id, observation: `obs-${id}` }],
  readSourcesComplete: true,
  ...extras,
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
});

describe("portal inbox observed-read storage contract", () => {
  it("carries observations and preserves body attachments through both collapse passes", () => {
    const rows = [
      source("email-1000", "older", { attachments: [{ url: "/files/older.pdf", name: "older.pdf" }] }),
      source("email-2000", "newer", { attachments: [{ url: "/files/newer.png", name: "newer.png" }] }),
    ];
    const once = collapsePersonInboxThreads(rows, { mergeFolders: true });
    const twice = collapseAssistantInboxThreads(once);
    expect(twice).toHaveLength(1);
    expect(twice[0]?.readSources).toEqual([
      { id: "email-1000", observation: "obs-email-1000" },
      { id: "email-2000", observation: "obs-email-2000" },
    ]);
    expect(twice[0]?.body).toBe("older");
    expect(twice[0]?.attachments).toEqual([{ url: "/files/older.pdf", name: "older.pdf" }]);
  });

  it("rejects conflicting observations for the same source instead of choosing one", () => {
    const rows = [
      source("email-1000", "older", { readSources: [{ id: "same", observation: "observation-a" }] }),
      source("email-2000", "newer", { readSources: [{ id: "same", observation: "observation-b" }] }),
    ];
    const merged = collapsePersonInboxThreads(rows, { mergeFolders: true });
    expect(merged[0]?.readSources).toEqual([]);
  });

  it("strips response-only observations from whole-row writes", async () => {
    window.history.replaceState({}, "", "/portal/communication/active");
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    persistInbox(MANAGER_INBOX_STORAGE_KEY, [source("email-1000", "message")]);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.rows[0].readSources).toBeUndefined();
    expect(body.rows[0].body).toBe("message");
  });

  it.each([
    ["missing", [{ id: "email-a", status: "read", unread: false }]],
    ["duplicate", [
      { id: "email-a", status: "read", unread: false },
      { id: "email-a", status: "read", unread: false },
    ]],
    ["invalid", [
      { id: "email-a", status: "read", unread: false },
      { id: "email-b", status: "read", unread: "false" },
    ]],
  ])("rejects a %s mark-read result array", async (_label, results) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ results }, { status: 500 })));
    await expect(markPersistedInboxSourcesRead(MANAGER_INBOX_STORAGE_KEY, [
      { id: "email-a", observation: "obs-a" },
      { id: "email-b", observation: "obs-b" },
    ])).resolves.toBeNull();
  });

  it("reconciles failure without clobbering a newer arrival or archive", () => {
    const requested = [{ id: "email-1000", observation: "obs-email-1000" }];
    const optimistic = reconcileObservedInboxReadRows(
      [source("email-1000", "message")],
      requested,
      new Map([["email-1000", false]]),
    );
    expect(optimistic[0]?.unread).toBe(false);

    const newer = source("email-1000", "new arrival", {
      readSources: [{ id: "email-1000", observation: "new-observation" }],
    });
    expect(reconcileObservedInboxReadRows([newer], requested, new Map([["email-1000", false]]))[0]).toBe(newer);

    const archived = source("email-1000", "message", { folder: "trash", unread: false });
    expect(reconcileObservedInboxReadRows([archived], requested, new Map([["email-1000", true]]))[0]).toBe(archived);
    expect(reconcileObservedInboxReadRows(optimistic, requested, new Map([["email-1000", true]]))[0]?.unread).toBe(true);
  });

  it("records confirmed per-source unread truth even when the aggregate stays unread", () => {
    const current = source("merged", "A", {
      unread: true,
      readSources: [
        { id: "email-a", observation: "obs-a", unread: true },
        { id: "email-b", observation: "obs-b", unread: true },
      ],
    });

    const reconciled = reconcileObservedInboxReadRows(
      [current],
      [
        { id: "email-a", observation: "obs-a" },
        { id: "email-b", observation: "obs-b" },
      ],
      new Map([
        ["email-a", false],
        ["email-b", true],
      ]),
    );

    expect(reconciled.map((row) => row.unread)).toEqual([true]);
    expect(reconciled[0]?.readSources).toEqual([
      { id: "email-a", observation: "obs-a", unread: false },
      { id: "email-b", observation: "obs-b", unread: true },
    ]);
  });

  it.each([
    ["a new source was not in the old request", [
      source("email-a", "old A", { readSources: [{ id: "email-a", observation: "old-a" }] }),
      source("email-b", "new B", { readSources: [{ id: "email-b", observation: "new-b" }] }),
    ], [{ id: "email-a", observation: "old-a" }]],
    ["a requested source was revised before the old response arrived", [
      source("email-a", "old A", { readSources: [{ id: "email-a", observation: "old-a" }] }),
      source("email-b", "revised B", { readSources: [{ id: "email-b", observation: "revised-b" }] }),
    ], [
      { id: "email-a", observation: "old-a" },
      { id: "email-b", observation: "old-b" },
    ]],
  ])("keeps unread content when %s", (_label, rows, requested) => {
    const current = rows.map((row) => ({ ...row, unread: true }));
    const reconciled = reconcileObservedInboxReadRows(
      current,
      requested,
      new Map([["email-a", false], ["email-b", false]]),
    );
    expect(reconciled.every((row) => row.unread)).toBe(true);
    expect(reconciled.map((row) => row.body)).toEqual(current.map((row) => row.body));
  });

  it("fails closed when a merged row has legacy or conflicting source metadata", () => {
    const legacy = source("legacy", "legacy body", { readSources: undefined, unread: true });
    const conflicting = source("conflict", "conflict body", {
      readSources: [{ id: "conflict", observation: "current-observation" }],
      unread: true,
    });
    const reconciled = reconcileObservedInboxReadRows(
      [legacy, conflicting],
      [{ id: "legacy", observation: "old-observation" }, { id: "conflict", observation: "old-observation" }],
      new Map([["legacy", false], ["conflict", false]]),
    );
    expect(reconciled.map((row) => row.unread)).toEqual([true, true]);
    expect(reconciled.map((row) => row.body)).toEqual(["legacy body", "conflict body"]);
  });

  it("does not acknowledge a partial observation set from a legacy collapse", () => {
    const partial = source("merged", "mixed legacy body", {
      readSources: [{ id: "observed", observation: "obs-observed" }],
      readSourcesComplete: undefined,
      unread: true,
    });
    const reconciled = reconcileObservedInboxReadRows(
      [partial],
      [{ id: "observed", observation: "obs-observed" }],
      new Map([["observed", false]]),
    );
    expect(reconciled[0]).toBe(partial);
    expect(reconciled[0]?.unread).toBe(true);
  });

  it("unions observations through a genuine assistant collapse and a successive pass", () => {
    const resident = "11111111-1111-4111-8111-111111111111";
    const manager = "22222222-2222-4222-8222-222222222222";
    const first = source(`resident-agent-${resident}-${manager}`, "first assistant turn", {
      from: "PropLane Assistant",
      threadType: "resident_agent",
      email: "resident@example.com",
      readSources: [{ id: "assistant-a", observation: "obs-a" }],
      attachments: [{ url: "/files/root.pdf", name: "root.pdf" }],
      messages: [{ id: "assistant-a-reply", from: "PropLane Assistant", body: "first appended", at: "Sep 13, 2026", attachments: [{ url: "/files/appended.png", name: "appended.png" }] }],
    });
    const second = source(`resident-agent-${resident}`, "second assistant turn", {
      from: "PropLane Assistant",
      threadType: "resident_agent",
      email: "resident@example.com",
      readSources: [{ id: "assistant-b", observation: "obs-b" }],
      messages: [{ id: "assistant-b-reply", from: "PropLane Assistant", body: "second appended", at: "Sep 13, 2026" }],
    });
    const once = collapseAssistantInboxThreads([first, second]);
    expect(once).toHaveLength(1);
    expect(once[0]?.readSources).toEqual([
      { id: "assistant-a", observation: "obs-a" },
      { id: "assistant-b", observation: "obs-b" },
    ]);
    expect(once[0]?.attachments).toEqual([{ url: "/files/root.pdf", name: "root.pdf" }]);
    expect(once[0]?.messages?.find((message) => message.id === "assistant-a-reply")?.attachments).toEqual([
      { url: "/files/appended.png", name: "appended.png" },
    ]);

    const third = source(`resident-agent-${resident}-33333333-3333-4333-8333-333333333333`, "third assistant turn", {
      from: "PropLane Assistant",
      threadType: "resident_agent",
      email: "resident@example.com",
      readSources: [{ id: "assistant-c", observation: "obs-c" }],
    });
    const twice = collapseAssistantInboxThreads([...once, third]);
    expect(twice[0]?.readSources).toEqual([
      { id: "assistant-a", observation: "obs-a" },
      { id: "assistant-b", observation: "obs-b" },
      { id: "assistant-c", observation: "obs-c" },
    ]);
  });

  it("drops all observations on an assistant conflict instead of acknowledging either row", () => {
    const resident = "44444444-4444-4444-8444-444444444444";
    const rows = [
      source(`resident-agent-${resident}-55555555-5555-4555-8555-555555555555`, "one", {
        from: "PropLane Assistant", threadType: "resident_agent",
        readSources: [{ id: "same-source", observation: "obs-one" }],
      }),
      source(`resident-agent-${resident}-66666666-6666-4666-8666-666666666666`, "two", {
        from: "PropLane Assistant", threadType: "resident_agent",
        readSources: [{ id: "same-source", observation: "obs-two" }],
      }),
    ];
    expect(collapseAssistantInboxThreads(rows)[0]?.readSources).toEqual([]);
  });

  it("carries every explicit native binding through person collapse", () => {
    const rows = [
      source("email-a", "first email", {
        smsConversationKey: "K1",
        smsBindingKeys: ["K1"],
      }),
      source("email-b", "second email", {
        smsConversationKey: "K2",
        smsBindingKeys: ["K2"],
      }),
    ];

    const [merged] = collapsePersonInboxThreads(rows, { mergeFolders: true });

    expect(merged?.smsConversationKey).toBeUndefined();
    expect(merged?.smsBindingKeys).toEqual(["K1", "K2"]);
  });

  it("fails closed when successive collapse passes disagree about native bindings", () => {
    const resident = "77777777-7777-4777-8777-777777777777";
    const rows = [
      source(`resident-agent-${resident}-11111111-1111-4111-8111-111111111111`, "first assistant turn", {
        from: "PropLane Assistant",
        threadType: "resident_agent",
        smsBindingKeys: ["K1"],
      }),
      source(`resident-agent-${resident}-22222222-2222-4222-8222-222222222222`, "second assistant turn", {
        from: "PropLane Assistant",
        threadType: "resident_agent",
        smsBindingKeys: ["K2"],
      }),
    ];

    const [merged] = collapseAssistantInboxThreads(rows);

    expect(merged?.smsBindingKeys).toEqual(["K1", "K2"]);
    expect(merged?.smsConversationKey).toBeUndefined();
  });
});
