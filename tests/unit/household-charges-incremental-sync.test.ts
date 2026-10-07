import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HouseholdCharge } from "@/lib/household-charges";

/**
 * Plan load-followups-1007, item 3 — incremental resync of the household charge ledger.
 *
 * MONEY: a delta read can only ADD or REPLACE rows by id. It must never remove a row and must never
 * trigger the "local-only rows -> POST replace" upload, which is only meaningful against a full list.
 */

function makeCharge(overrides: Partial<HouseholdCharge> = {}): HouseholdCharge {
  return {
    id: "chg-1",
    kind: "rent",
    status: "pending",
    amountLabel: "$100.00",
    balanceLabel: "$100.00",
    dueDateLabel: "Mar 1, 2026",
    residentEmail: "r@test.com",
    residentName: "Resident",
    propertyId: "prop-1",
    propertyLabel: "Test Property",
    managerUserId: "mgr-1",
    rentMonth: "2026-03",
    createdAt: "2026-01-01T00:00:00.000Z",
    title: "Rent — March 2026",
    ...overrides,
  } as HouseholdCharge;
}

const A = makeCharge({ id: "chg-a", rentMonth: "2026-03", title: "Rent — March 2026" });
const B = makeCharge({ id: "chg-b", rentMonth: "2026-04", title: "Rent — April 2026", dueDateLabel: "Apr 1, 2026" });
const C = makeCharge({ id: "chg-c", rentMonth: "2026-05", title: "Rent — May 2026", dueDateLabel: "May 1, 2026" });

const T0 = Date.parse("2026-10-07T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

type Reply = { ok?: boolean; charges?: HouseholdCharge[]; incremental?: boolean; syncedAt?: string; viewerRole?: string };

let session: Map<string, string>;
let gets: string[];
let posts: Array<Record<string, unknown>>;
let replies: Reply[];

function stubBrowser() {
  session = new Map();
  gets = [];
  posts = [];
  replies = [];
  vi.stubGlobal("window", {
    sessionStorage: {
      getItem: (key: string) => session.get(key) ?? null,
      setItem: (key: string, value: string) => void session.set(key, value),
      removeItem: (key: string) => void session.delete(key),
    },
    localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    dispatchEvent: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: { method?: string; body?: string }) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method !== "GET") {
        posts.push(JSON.parse(init?.body ?? "{}") as Record<string, unknown>);
        return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
      }
      gets.push(url);
      const reply = replies.shift() ?? {};
      return Promise.resolve({
        ok: reply.ok ?? true,
        status: reply.ok === false ? 500 : 200,
        json: async () => ({
          charges: reply.charges ?? [],
          rentProfiles: [],
          viewerRole: reply.viewerRole ?? "manager",
          syncedAt: reply.syncedAt,
          ...(reply.incremental ? { incremental: true } : {}),
        }),
      });
    }),
  );
}

async function loadStore(enabled = true) {
  vi.resetModules();
  stubBrowser();
  const store = await import("@/lib/household-charges");
  store.setHouseholdIncrementalSyncEnabledForTests(enabled);
  return store;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const replacePosts = () => posts.filter((body) => body.action === "replace");
const ids = (rows: HouseholdCharge[]) => rows.map((row) => row.id).sort();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("household charges incremental resync (client)", () => {
  it("a TTL resync asks for updatedSince=<last syncedAt> and merges the delta without dropping old rows", async () => {
    const store = await loadStore();
    replies.push({ charges: [A, B], syncedAt: iso(T0) });
    await store.syncHouseholdChargesFromServer(true);
    expect(gets).toEqual(["/api/portal-household-charges"]);

    vi.setSystemTime(T0 + 20_000);
    const changedA = { ...A, amountLabel: "$150.00", balanceLabel: "$150.00" };
    replies.push({ charges: [changedA], incremental: true, syncedAt: iso(T0 + 20_000) });
    const result = await store.syncHouseholdChargesFromServer();

    expect(gets[1]).toBe(`/api/portal-household-charges?updatedSince=${encodeURIComponent(iso(T0))}`);
    expect(ids(result.charges)).toEqual(["chg-a", "chg-b"]);
    expect(result.charges.find((row) => row.id === "chg-a")?.amountLabel).toBe("$150.00");
    expect(store.readHouseholdCharges().find((row) => row.id === "chg-b")).toBeTruthy();
  });

  it("an incremental response never POSTs replace, even with a local-only charge in memory", async () => {
    const store = await loadStore();
    replies.push({ charges: [A, B], syncedAt: iso(T0) });
    await store.syncHouseholdChargesFromServer(true);
    await settle();
    posts.length = 0;
    store.seedDemoHouseholdCharges([A, B, C]);

    vi.setSystemTime(T0 + 20_000);
    replies.push({ charges: [], incremental: true, syncedAt: iso(T0 + 20_000) });
    const result = await store.syncHouseholdChargesFromServer();
    await settle();

    expect(gets[1]).toContain("updatedSince=");
    expect(replacePosts()).toEqual([]);
    expect(ids(result.charges)).toEqual(["chg-a", "chg-b", "chg-c"]);
  });

  it("a full sync still uploads a local-only charge", async () => {
    const store = await loadStore();
    replies.push({ charges: [A, B], syncedAt: iso(T0) });
    await store.syncHouseholdChargesFromServer(true);
    await settle();
    posts.length = 0;
    store.seedDemoHouseholdCharges([A, B, C]);

    vi.setSystemTime(T0 + 20_000);
    replies.push({ charges: [A, B], syncedAt: iso(T0 + 20_000) });
    await store.syncHouseholdChargesFromServer(true);
    await settle();

    expect(gets[1]).toBe("/api/portal-household-charges");
    const replace = replacePosts();
    expect(replace).toHaveLength(1);
    expect(ids(replace[0]!.charges as HouseholdCharge[])).toEqual(["chg-a", "chg-b", "chg-c"]);
  });

  it("a server that answers a delta request with a full read is treated as a full read", async () => {
    const store = await loadStore();
    replies.push({ charges: [A, B], syncedAt: iso(T0) });
    await store.syncHouseholdChargesFromServer(true);
    await settle();
    posts.length = 0;
    store.seedDemoHouseholdCharges([A, B, C]);

    vi.setSystemTime(T0 + 20_000);
    // Invalid watermark / truncated window: no `incremental: true`, so this is the whole list.
    replies.push({ charges: [A, B], syncedAt: iso(T0 + 20_000) });
    await store.syncHouseholdChargesFromServer();
    await settle();

    expect(gets[1]).toContain("updatedSince=");
    expect(replacePosts()).toHaveLength(1);
  });

  it("force always takes the full path", async () => {
    const store = await loadStore();
    replies.push({ charges: [A], syncedAt: iso(T0) });
    await store.syncHouseholdChargesFromServer(true);
    vi.setSystemTime(T0 + 20_000);
    replies.push({ charges: [A], syncedAt: iso(T0 + 20_000) });
    await store.syncHouseholdChargesFromServer(true);
    expect(gets).toEqual(["/api/portal-household-charges", "/api/portal-household-charges"]);
  });

  it("forces a full sync once the last one is ten minutes old", async () => {
    const store = await loadStore();
    replies.push({ charges: [A], syncedAt: iso(T0) });
    await store.syncHouseholdChargesFromServer(true);

    vi.setSystemTime(T0 + 5 * 60_000);
    replies.push({ charges: [], incremental: true, syncedAt: iso(T0 + 5 * 60_000) });
    await store.syncHouseholdChargesFromServer();
    expect(gets[1]).toContain("updatedSince=");

    // Incremental reads advance the watermark but not the full-sync clock.
    vi.setSystemTime(T0 + 10 * 60_000 + 1_000);
    replies.push({ charges: [A], syncedAt: iso(T0 + 10 * 60_000 + 1_000) });
    await store.syncHouseholdChargesFromServer();
    expect(gets[2]).toBe("/api/portal-household-charges");
  });

  it("is on by default", async () => {
    vi.resetModules();
    stubBrowser();
    const store = await import("@/lib/household-charges");
    replies.push({ charges: [A], syncedAt: iso(T0) });
    await store.syncHouseholdChargesFromServer(true);
    vi.setSystemTime(T0 + 20_000);
    replies.push({ charges: [], incremental: true, syncedAt: iso(T0 + 20_000) });
    await store.syncHouseholdChargesFromServer();
    expect(gets[1]).toContain("updatedSince=");
  });

  it("a workspace switch forces the next sync to be full, then incremental resumes", async () => {
    const store = await loadStore();
    const selection = await import("@/lib/workspaces/selection");
    const payload = (id: string) =>
      ({ workspaces: [{ id }], activeWorkspaceId: id }) as unknown as Parameters<typeof selection.setWorkspaceSelection>[0];
    selection.setWorkspaceSelection(payload("ws-1"));
    replies.push({ charges: [A, B], syncedAt: iso(T0) });
    await store.syncHouseholdChargesFromServer(true);

    vi.setSystemTime(T0 + 20_000);
    replies.push({ charges: [], incremental: true, syncedAt: iso(T0 + 20_000) });
    await store.syncHouseholdChargesFromServer();
    expect(gets[1]).toContain("updatedSince=");

    selection.setWorkspaceSelection(payload("ws-2"));
    vi.setSystemTime(T0 + 40_000);
    replies.push({ charges: [A], syncedAt: iso(T0 + 40_000) });
    await store.syncHouseholdChargesFromServer();
    expect(gets[2]).toBe("/api/portal-household-charges");

    vi.setSystemTime(T0 + 60_000);
    replies.push({ charges: [], incremental: true, syncedAt: iso(T0 + 60_000) });
    await store.syncHouseholdChargesFromServer();
    expect(gets[3]).toContain("updatedSince=");
  });

  it("stays on full reads while the flag is off", async () => {
    const store = await loadStore(false);
    replies.push({ charges: [A], syncedAt: iso(T0) });
    await store.syncHouseholdChargesFromServer(true);
    vi.setSystemTime(T0 + 20_000);
    replies.push({ charges: [A], syncedAt: iso(T0 + 20_000) });
    await store.syncHouseholdChargesFromServer();
    expect(gets[1]).toBe("/api/portal-household-charges");
  });

  it("a failed delta read changes nothing and uploads nothing", async () => {
    const store = await loadStore();
    replies.push({ charges: [A, B], syncedAt: iso(T0) });
    await store.syncHouseholdChargesFromServer(true);
    await settle();
    posts.length = 0;

    vi.setSystemTime(T0 + 20_000);
    replies.push({ ok: false });
    const result = await store.syncHouseholdChargesFromServer();
    await settle();

    expect(ids(result.charges)).toEqual(["chg-a", "chg-b"]);
    expect(posts).toEqual([]);
  });

  it("drops the watermark when sessionStorage is cleared (sign-out), so the next read is full", async () => {
    const store = await loadStore();
    replies.push({ charges: [A], syncedAt: iso(T0) });
    await store.syncHouseholdChargesFromServer(true);
    session.clear();
    store.seedDemoHouseholdCharges([A]);

    vi.setSystemTime(T0 + 20_000);
    replies.push({ charges: [A], syncedAt: iso(T0 + 20_000) });
    await store.syncHouseholdChargesFromServer();
    expect(gets[1]).toBe("/api/portal-household-charges");
  });
});
