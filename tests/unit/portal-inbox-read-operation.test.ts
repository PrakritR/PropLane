import { describe, expect, it, vi } from "vitest";
import {
  startObservedInboxReadOperation,
  type ObservedInboxReadResult,
  type ObservedInboxReadSource,
} from "@/lib/portal-inbox-read-operation.client";
import { reconcileObservedInboxReadRows, type PersistedInboxThread } from "@/lib/portal-inbox-storage";

const source = (id: string, unread = true): ObservedInboxReadSource => ({ id, observation: `obs-${id}`, unread });
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

type ReadSource = NonNullable<PersistedInboxThread["readSources"]>[number];

const aliasThread = (
  email: string,
  id: string,
  observation: string,
  unread = true,
): PersistedInboxThread => ({
  id: `thread-${email}`,
  folder: "inbox",
  from: "Resident",
  email,
  subject: "Alias thread",
  preview: "Alias thread",
  body: "Alias thread",
  time: "Sep 13, 2026",
  unread,
  // Both aliases were resolved to the same native conversation. The explicit
  // binding is retained here so this regression models the selected sources,
  // rather than two unrelated email rows.
  smsBindingKeys: ["manager-1:resident:native-1"],
  readSources: [{ id, observation, unread }],
  readSourcesComplete: true,
});

function sourceState(
  rows: PersistedInboxThread[],
  id: string,
): ReadSource | undefined {
  return rows.flatMap((row) => row.readSources ?? []).find((source) => source.id === id);
}

function aggregateUnread(rows: PersistedInboxThread[]): boolean {
  return rows.some((row) => row.unread);
}

function runActualReconciliationHarness() {
  const aliases = {
    a: "resident+alias-a@example.com",
    b: "resident+alias-b@example.com",
  };
  let rows: PersistedInboxThread[] = [
    aliasThread(aliases.a, "A1", "obs-A1"),
    aliasThread(aliases.b, "B1", "obs-B1"),
  ];
  const oldRequest = deferred<ObservedInboxReadResult[] | null>();
  const newerRequest = deferred<ObservedInboxReadResult[] | null>();
  const requests = [oldRequest, newerRequest];
  const post = vi.fn((sources: ObservedInboxReadSource[]) => {
    expect(sources.map((source) => source.id)).toEqual(
      sources.map((source) => source.id).sort(),
    );
    return requests.shift()!.promise;
  });
  const pending = new Map<string, symbol>();
  const sourcesByToken = new Map<string, ObservedInboxReadSource[]>();
  const notifications = vi.fn();
  const applyUnread = (
    unreadById: Map<string, boolean>,
    operation?: { token: string; phase: "optimistic" | "settled" },
  ) => {
    const sources = sourcesByToken.get(operation?.token ?? "");
    expect(sources).toBeDefined();
    rows = reconcileObservedInboxReadRows(rows, sources!, unreadById, operation);
  };
  const begin = (sources: ObservedInboxReadSource[]) => {
    const token = `viewer:1:${sources.map((source) => `${source.id}:${source.observation}`).sort().join("|")}`;
    sourcesByToken.set(token, sources);
    return startObservedInboxReadOperation({
      viewerKey: "viewer",
      epoch: 1,
      sources,
      nativeMessageIds: [],
      pending,
      isCurrent: () => true,
      markNativeRead: vi.fn(),
      applyUnread,
      post,
      notifyFailure: notifications,
    });
  };
  return {
    aliases,
    oldRequest,
    newerRequest,
    post,
    pending,
    notifications,
    get rows() { return rows; },
    set rows(next: PersistedInboxThread[]) { rows = next; },
    begin,
  };
}

describe("observed inbox read operation", () => {
  it("opens new native messages while an email post is pending without duplicating the post", async () => {
    const pending = new Map<string, symbol>();
    const request = deferred<ReturnType<typeof source> extends never ? never : { id: string; status: "read"; unread: boolean }[]>();
    const post = vi.fn(() => request.promise);
    const native = vi.fn();
    const apply = vi.fn();
    const notify = vi.fn();
    const sources = [source("email-a")];

    expect(startObservedInboxReadOperation({ viewerKey: "viewer", epoch: 1, sources, nativeMessageIds: ["sms-1"], pending, isCurrent: () => true, markNativeRead: native, applyUnread: apply, post, notifyFailure: notify })).toMatchObject({ kind: "attempted", nativeReceiptStored: true });
    expect(startObservedInboxReadOperation({ viewerKey: "viewer", epoch: 1, sources, nativeMessageIds: ["sms-2"], pending, isCurrent: () => true, markNativeRead: native, applyUnread: apply, post, notifyFailure: notify })).toMatchObject({ kind: "attempted", nativeReceiptStored: true });
    expect(native).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenCalledTimes(1);
    request.resolve([{ id: "email-a", status: "read", unread: false }]);
    await settle();
    expect(notify).not.toHaveBeenCalled();
    expect(pending.size).toBe(0);
  });

  it("allows A-B-A retries and prevents stale settlements from applying or notifying", async () => {
    const pending = new Map<string, symbol>();
    const a1 = deferred<{ id: string; status: "read"; unread: boolean }[]>();
    const b = deferred<{ id: string; status: "read"; unread: boolean }[]>();
    const a3 = deferred<{ id: string; status: "read"; unread: boolean }[]>();
    const requests = [a1, b, a3];
    const post = vi.fn(() => requests.shift()!.promise);
    let currentEpoch = 1;
    const applied: Array<[number, Map<string, boolean>]> = [];
    const notices: number[] = [];
    const begin = (epoch: number, rows: ObservedInboxReadSource[]) => startObservedInboxReadOperation({
      viewerKey: "viewer", epoch, sources: rows, nativeMessageIds: [], pending, isCurrent: () => epoch === currentEpoch,
      markNativeRead: vi.fn(),
      applyUnread: (value) => { if (epoch === currentEpoch) applied.push([epoch, value]); },
      post,
      notifyFailure: () => { if (epoch === currentEpoch) notices.push(epoch); },
    });
    begin(1, [source("email-a")]);
    currentEpoch = 2;
    begin(2, [source("email-b")]);
    currentEpoch = 3;
    begin(3, [source("email-a")]);
    expect(post).toHaveBeenCalledTimes(3);
    applied.length = 0;

    a1.reject(new Error("stale A"));
    b.resolve([{ id: "email-b", status: "read", unread: false }]);
    await settle();
    expect(notices).toEqual([]);
    expect(applied.every(([epoch]) => epoch === 3)).toBe(true);

    a3.resolve([{ id: "email-a", status: "read", unread: false }]);
    await settle();
    expect(notices).toEqual([]);
    expect(pending.size).toBe(0);
  });

  it("cleans only its own pending token when duplicate operations settle out of order", async () => {
    const pending = new Map<string, symbol>();
    const first = deferred<{ id: string; status: "read"; unread: boolean }[]>();
    const second = deferred<{ id: string; status: "read"; unread: boolean }[]>();
    const post = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const rows = [source("email-a")];
    startObservedInboxReadOperation({ viewerKey: "viewer", epoch: 1, sources: rows, nativeMessageIds: [], pending, isCurrent: () => true, markNativeRead: vi.fn(), applyUnread: vi.fn(), post, notifyFailure: vi.fn() });
    expect(startObservedInboxReadOperation({ viewerKey: "viewer", epoch: 1, sources: rows, nativeMessageIds: [], pending, isCurrent: () => true, markNativeRead: vi.fn(), applyUnread: vi.fn(), post, notifyFailure: vi.fn() })).toMatchObject({ kind: "attempted", nativeReceiptStored: true });
    expect(post).toHaveBeenCalledTimes(1);
    first.resolve([{ id: "email-a", status: "read", unread: false }]);
    await settle();
    expect(pending.size).toBe(0);
    startObservedInboxReadOperation({ viewerKey: "viewer", epoch: 1, sources: rows, nativeMessageIds: [], pending, isCurrent: () => true, markNativeRead: vi.fn(), applyUnread: vi.fn(), post, notifyFailure: vi.fn() });
    expect(post).toHaveBeenCalledTimes(2);
    second.resolve([{ id: "email-a", status: "read", unread: false }]);
    await settle();
  });

  it.each([
    ["partial", [{ id: "email-a", status: "read", unread: false }]],
    ["malformed", null],
  ])("preserves prior truth for %s results", async (_label, result) => {
    const applied: Map<string, boolean>[] = [];
    const post = vi.fn(async () => result as never);
    startObservedInboxReadOperation({ viewerKey: "viewer", epoch: 1, sources: [source("email-a", false), source("email-b", true)], nativeMessageIds: [], pending: new Map(), isCurrent: () => true, markNativeRead: vi.fn(), applyUnread: (value) => applied.push(value), post, notifyFailure: vi.fn() });
    await settle();
    expect(applied.at(-1)?.get("email-a")).toBe(false);
    expect(applied.at(-1)?.get("email-b")).toBe(true);
  });

  it("uses confirmed source truth as the baseline for a failed reopen", async () => {
    const pending = new Map<string, symbol>();
    const post = vi.fn()
      .mockResolvedValueOnce([{ id: "email-a", status: "read" as const, unread: false }])
      .mockRejectedValueOnce(new Error("reopen failed"));
    const applied: Map<string, boolean>[] = [];
    const begin = (unread: boolean) => startObservedInboxReadOperation({
      viewerKey: "viewer",
      epoch: 1,
      sources: [source("email-a", unread)],
      nativeMessageIds: [],
      pending,
      isCurrent: () => true,
      markNativeRead: vi.fn(),
      applyUnread: (value) => applied.push(value),
      post,
      notifyFailure: vi.fn(),
    });

    begin(true);
    await settle();
    begin(false);
    await settle();

    expect(post).toHaveBeenCalledTimes(2);
    expect(applied.at(-1)?.get("email-a")).toBe(false);
  });

  it("keeps a confirmed partial success through a later failed reopen", async () => {
    const pending = new Map<string, symbol>();
    const post = vi.fn()
      .mockResolvedValueOnce([
        { id: "email-a", status: "read" as const, unread: false },
        { id: "email-b", status: "failed" as const, unread: true },
      ])
      .mockRejectedValueOnce(new Error("retry failed"));
    const applied: Map<string, boolean>[] = [];
    const begin = (aUnread: boolean, bUnread: boolean) => startObservedInboxReadOperation({
      viewerKey: "viewer",
      epoch: 1,
      sources: [source("email-a", aUnread), source("email-b", bUnread)],
      nativeMessageIds: [],
      pending,
      isCurrent: () => true,
      markNativeRead: vi.fn(),
      applyUnread: (value) => applied.push(value),
      post,
      notifyFailure: vi.fn(),
    });

    begin(true, true);
    await settle();
    begin(false, true);
    await settle();

    expect(post).toHaveBeenCalledTimes(2);
    expect(applied.at(-1)).toEqual(new Map([
      ["email-a", false],
      ["email-b", true],
    ]));
  });

  it.each([
    ["newer success then older rejection", false],
    ["older rejection then newer success", true],
  ] as const)(
    "preserves confirmed source truth across overlapping alias acknowledgements (%s)",
    async (_label, settleOlderFirst) => {
      const harness = runActualReconciliationHarness();
      const oldSources = [
        { id: "A1", observation: "obs-A1", unread: true },
        { id: "B1", observation: "obs-B1", unread: true },
      ];
      harness.begin(oldSources);

      // A refresh revises only B. A1 is still the exact observed source, while
      // B1 is replaced by B2. The shared native binding remains explicit.
      harness.rows = [
        aliasThread(harness.aliases.a, "A1", "obs-A1"),
        aliasThread(harness.aliases.b, "B2", "obs-B2"),
      ];
      const newerSources = [
        { id: "A1", observation: "obs-A1", unread: true },
        { id: "B2", observation: "obs-B2", unread: true },
      ];
      harness.begin(newerSources);
      expect(harness.rows.every((row) => row.readSources?.every((source) => source.optimistic?.unread === false))).toBe(true);

      const newerResult = [
        { id: "A1", status: "read" as const, unread: false },
        { id: "B2", status: "read" as const, unread: false },
      ];
      const settleOlder = () => harness.oldRequest.reject(new Error("older network failure"));
      const settleNewer = () => harness.newerRequest.resolve(newerResult);
      if (settleOlderFirst) {
        settleOlder();
        await settle();
        expect(sourceState(harness.rows, "A1")?.unread).toBe(true);
        expect(sourceState(harness.rows, "B2")?.unread).toBe(true);
        settleNewer();
      } else {
        settleNewer();
        await settle();
        expect(sourceState(harness.rows, "A1")?.unread).toBe(false);
        expect(sourceState(harness.rows, "B2")?.unread).toBe(false);
        settleOlder();
      }
      await settle();
      expect(sourceState(harness.rows, "A1")?.unread).toBe(false);
      expect(sourceState(harness.rows, "B2")?.unread).toBe(false);
      expect(harness.rows.every((row) => row.unread === false)).toBe(true);
      expect(aggregateUnread(harness.rows)).toBe(false);
      expect(harness.rows.flatMap((row) => row.readSources ?? [])
        .every((source) => source.optimistic === undefined)).toBe(true);
      expect(harness.pending.size).toBe(0);
      expect(harness.notifications).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ["missing", null],
    ["malformed", [{ id: "unexpected", status: "read", unread: "false" }]],
  ] as const)(
    "withdraws only the failed operation overlay for a %s overlapping response",
    async (_label, oldOutcome) => {
      const harness = runActualReconciliationHarness();
      harness.begin([
        { id: "A1", observation: "obs-A1", unread: true },
        { id: "B1", observation: "obs-B1", unread: true },
      ]);
      harness.rows = [
        aliasThread(harness.aliases.a, "A1", "obs-A1"),
        aliasThread(harness.aliases.b, "B2", "obs-B2"),
      ];
      harness.begin([
        { id: "A1", observation: "obs-A1", unread: true },
        { id: "B2", observation: "obs-B2", unread: true },
      ]);

      harness.newerRequest.resolve([
        { id: "A1", status: "read", unread: false },
        { id: "B2", status: "read", unread: false },
      ]);
      await settle();
      harness.oldRequest.resolve(oldOutcome as never);
      await settle();

      expect(sourceState(harness.rows, "A1")?.unread).toBe(false);
      expect(sourceState(harness.rows, "B2")?.unread).toBe(false);
      expect(aggregateUnread(harness.rows)).toBe(false);
      expect(harness.rows.flatMap((row) => row.readSources ?? [])
        .every((source) => source.optimistic === undefined)).toBe(true);
      expect(harness.pending.size).toBe(0);
      expect(harness.notifications).toHaveBeenCalledTimes(1);
    },
  );

  it("retains an earlier partial server success through a real failed reopen reconciliation", async () => {
    const harness = runActualReconciliationHarness();
    harness.begin([
      { id: "A1", observation: "obs-A1", unread: true },
      { id: "B1", observation: "obs-B1", unread: true },
    ]);
    harness.oldRequest.resolve([
      { id: "A1", status: "read", unread: false },
      { id: "B1", status: "failed", unread: true },
    ]);
    await settle();
    expect(sourceState(harness.rows, "A1")?.unread).toBe(false);
    expect(sourceState(harness.rows, "B1")?.unread).toBe(true);
    expect(aggregateUnread(harness.rows)).toBe(true);

    harness.begin([
      { id: "A1", observation: "obs-A1", unread: false },
      { id: "B1", observation: "obs-B1", unread: true },
    ]);
    harness.newerRequest.reject(new Error("reopen failed"));
    await settle();
    expect(sourceState(harness.rows, "A1")?.unread).toBe(false);
    expect(sourceState(harness.rows, "B1")?.unread).toBe(true);
    expect(aggregateUnread(harness.rows)).toBe(true);
    expect(harness.pending.size).toBe(0);
  });

  it("continues the email post when native local storage fails and permits retry", async () => {
    const pending = new Map<string, symbol>();
    const post = vi.fn(async () => [{ id: "email-a", status: "read" as const, unread: false }]);
    const notify = vi.fn();
    const markNativeRead = vi.fn(() => { throw new Error("localStorage denied"); });
    expect(startObservedInboxReadOperation({ viewerKey: "viewer", epoch: 1, sources: [source("email-a")], nativeMessageIds: ["sms-1"], pending, isCurrent: () => true, markNativeRead, applyUnread: vi.fn(), post, notifyFailure: notify })).toMatchObject({ kind: "attempted", nativeReceiptStored: false });
    await settle();
    expect(post).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(pending.size).toBe(0);
    expect(startObservedInboxReadOperation({ viewerKey: "viewer", epoch: 1, sources: [source("email-a")], nativeMessageIds: [], pending, isCurrent: () => true, markNativeRead: vi.fn(), applyUnread: vi.fn(), post, notifyFailure: notify })).toMatchObject({ kind: "attempted", nativeReceiptStored: true });
    expect(post).toHaveBeenCalledTimes(2);
  });
});
