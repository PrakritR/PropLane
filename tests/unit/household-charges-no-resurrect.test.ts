import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HouseholdCharge, RecurringRentProfile } from "@/lib/household-charges";

/**
 * Production, 2026-10-08: 93 charges and 10 rent profiles were deleted server-side; a manager's stale
 * tab then uploaded them again with the SAME ids through its `action:"replace"` mirror (and the
 * profiles regenerated charges). A row missing from a FULL read that the server had confirmed
 * earlier was deleted there: it is dropped locally and never uploaded. Only a row the server never
 * confirmed is a local creation that may be uploaded.
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

function makeProfile(overrides: Partial<RecurringRentProfile> = {}): RecurringRentProfile {
  return {
    id: "rrp-1",
    managerUserId: "mgr-1",
    residentEmail: "r@test.com",
    residentName: "Resident",
    propertyId: "prop-1",
    propertyLabel: "Test Property",
    monthlyRent: 1000,
    dueDay: 1,
    startMonth: "2026-01",
    active: true,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as RecurringRentProfile;
}

const A = makeCharge({ id: "chg-a", rentMonth: "2026-03", title: "Rent — March 2026" });
const B = makeCharge({ id: "chg-b", rentMonth: "2026-04", title: "Rent — April 2026", dueDateLabel: "Apr 1, 2026" });
const C = makeCharge({ id: "chg-c", rentMonth: "2026-05", title: "Rent — May 2026", dueDateLabel: "May 1, 2026" });
const P1 = makeProfile({ id: "rrp-1" });

const T0 = Date.parse("2026-10-08T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

type Reply = { ok?: boolean; charges?: HouseholdCharge[]; rentProfiles?: RecurringRentProfile[]; syncedAt?: string };

let session: Map<string, string>;
let posts: Array<Record<string, unknown>>;
let replies: Reply[];

function stubBrowser(initialSession?: Map<string, string>) {
  session = initialSession ?? new Map();
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
    vi.fn((_url: string, init?: { method?: string; body?: string }) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method !== "GET") {
        posts.push(JSON.parse(init?.body ?? "{}") as Record<string, unknown>);
        return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
      }
      const reply = replies.shift() ?? {};
      return Promise.resolve({
        ok: reply.ok ?? true,
        status: reply.ok === false ? 500 : 200,
        json: async () => ({
          charges: reply.charges ?? [],
          rentProfiles: reply.rentProfiles ?? [],
          viewerRole: "manager",
          syncedAt: reply.syncedAt,
        }),
      });
    }),
  );
}

async function loadStore(initialSession?: Map<string, string>) {
  vi.resetModules();
  stubBrowser(initialSession);
  const store = await import("@/lib/household-charges");
  store.setHouseholdIncrementalSyncEnabledForTests(false);
  return store;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const replacePosts = () => posts.filter((body) => body.action === "replace");
const ids = (rows: Array<{ id: string }>) => rows.map((row) => row.id).sort();
const rentChargesFor = (rows: HouseholdCharge[], profileId: string) =>
  rows.filter((row) => (row as { recurringRentProfileId?: string }).recurringRentProfileId === profileId);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("household charges never resurrect a server-side delete", () => {
  it("drops confirmed charges and profiles a full read omits, and posts no replace", async () => {
    const store = await loadStore();
    replies.push({ charges: [A, B], rentProfiles: [P1], syncedAt: iso(T0) });
    await store.syncHouseholdChargesFromServer(true);
    await settle();
    posts.length = 0;
    expect(ids(store.readHouseholdCharges())).toEqual(expect.arrayContaining(["chg-a", "chg-b"]));

    // Someone deletes B and the profile server-side; this tab still holds them.
    vi.setSystemTime(T0 + 60_000);
    replies.push({ charges: [A], rentProfiles: [], syncedAt: iso(T0 + 60_000) });
    const result = await store.syncHouseholdChargesFromServer(true);
    await settle();

    expect(replacePosts()).toEqual([]);
    expect(ids(result.charges)).toEqual(["chg-a"]);
    expect(result.rentProfiles).toEqual([]);
    // The profile is gone, so nothing regenerates rent charges from it.
    expect(rentChargesFor(result.charges, "rrp-1")).toEqual([]);
    const cached = JSON.parse(session.get("axis:household-charges:v1") ?? "[]") as Array<{ id: string }>;
    expect(ids(cached)).toEqual(["chg-a"]);
    expect(JSON.parse(session.get("axis:household-rent-profiles:v1") ?? "[]")).toEqual([]);
  });

  it("deleting everything server-side leaves the tab empty and uploads nothing", async () => {
    const store = await loadStore();
    replies.push({ charges: [A, B, C], rentProfiles: [P1], syncedAt: iso(T0) });
    await store.syncHouseholdChargesFromServer(true);
    await settle();
    posts.length = 0;

    replies.push({ charges: [], rentProfiles: [], syncedAt: iso(T0 + 60_000) });
    const result = await store.syncHouseholdChargesFromServer(true);
    await settle();

    expect(replacePosts()).toEqual([]);
    expect(result.charges).toEqual([]);
    expect(result.rentProfiles).toEqual([]);
  });

  it("still uploads a charge and a profile the server never confirmed", async () => {
    const store = await loadStore();
    replies.push({ charges: [A, B], rentProfiles: [P1], syncedAt: iso(T0) });
    await store.syncHouseholdChargesFromServer(true);
    await settle();
    // Locally created and never read back from the server: C and a second profile.
    const P2 = makeProfile({ id: "rrp-2", residentEmail: "other@test.com" });
    store.seedDemoHouseholdCharges([A, B, C], [P1, P2]);
    posts.length = 0;

    // B and P1 were deleted server-side in the meantime.
    vi.setSystemTime(T0 + 60_000);
    replies.push({ charges: [A], rentProfiles: [], syncedAt: iso(T0 + 60_000) });
    await store.syncHouseholdChargesFromServer(true);
    await settle();

    const replace = replacePosts();
    expect(replace.length).toBeGreaterThan(0);
    const last = replace[replace.length - 1]!;
    const uploaded = last.charges as HouseholdCharge[];
    expect(ids(uploaded)).toEqual(expect.arrayContaining(["chg-a", "chg-c"]));
    expect(ids(uploaded)).not.toContain("chg-b");
    // The unconfirmed profile still bills; the deleted one's months are gone.
    expect(rentChargesFor(uploaded, "rrp-2").length).toBeGreaterThan(0);
    expect(rentChargesFor(uploaded, "rrp-1")).toEqual([]);
    expect(ids(last.rentProfiles as RecurringRentProfile[])).toEqual(["rrp-2"]);
  });

  it("a cache from before this change (no confirmed set) is treated as server-confirmed and never resurrects", async () => {
    const legacy = new Map<string, string>([
      ["axis:household-charges:v1", JSON.stringify([A, B])],
      ["axis:household-rent-profiles:v1", JSON.stringify([P1])],
    ]);
    const store = await loadStore(legacy);
    expect(legacy.has("axis:household-confirmed-ids:v1")).toBe(false);

    replies.push({ charges: [], rentProfiles: [], syncedAt: iso(T0) });
    const result = await store.syncHouseholdChargesFromServer(true);
    await settle();

    expect(replacePosts()).toEqual([]);
    expect(result.charges).toEqual([]);
    expect(result.rentProfiles).toEqual([]);
    expect(rentChargesFor(result.charges, "rrp-1")).toEqual([]);
  });

  it("a cache that does carry a confirmed set keeps its never-confirmed rows", async () => {
    const cache = new Map<string, string>([
      ["axis:household-charges:v1", JSON.stringify([A, C])],
      ["axis:household-rent-profiles:v1", JSON.stringify([])],
      ["axis:household-confirmed-ids:v1", JSON.stringify({ charges: ["chg-a"], profiles: [] })],
    ]);
    const store = await loadStore(cache);

    replies.push({ charges: [], rentProfiles: [], syncedAt: iso(T0) });
    const result = await store.syncHouseholdChargesFromServer(true);
    await settle();

    // A was confirmed and is gone; C was never confirmed and is still ours to upload.
    expect(ids(result.charges)).toEqual(["chg-c"]);
    const replace = replacePosts();
    expect(replace).toHaveLength(1);
    expect(ids(replace[0]!.charges as HouseholdCharge[])).toEqual(["chg-c"]);
  });

  it("a failed full read changes nothing and uploads nothing", async () => {
    const store = await loadStore();
    replies.push({ charges: [A, B], rentProfiles: [P1], syncedAt: iso(T0) });
    await store.syncHouseholdChargesFromServer(true);
    await settle();
    posts.length = 0;

    vi.setSystemTime(T0 + 60_000);
    replies.push({ ok: false });
    const result = await store.syncHouseholdChargesFromServer(true);
    await settle();

    expect(replacePosts()).toEqual([]);
    expect(ids(result.charges)).toEqual(expect.arrayContaining(["chg-a", "chg-b"]));
    expect(result.rentProfiles.map((p) => p.id)).toContain("rrp-1");
  });

  it("a read at the row cap may be truncated, so absence does not delete", async () => {
    const store = await loadStore();
    replies.push({ charges: [A, B], rentProfiles: [P1], syncedAt: iso(T0) });
    await store.syncHouseholdChargesFromServer(true);
    await settle();

    const filler = Array.from({ length: 2000 }, (_, index) =>
      makeCharge({ id: `fill-${index}`, residentEmail: `f${index}@test.com`, rentMonth: "2026-06", title: `Rent ${index}` }),
    );
    vi.setSystemTime(T0 + 60_000);
    replies.push({ charges: filler, rentProfiles: [P1], syncedAt: iso(T0 + 60_000) });
    const result = await store.syncHouseholdChargesFromServer(true);
    await settle();

    expect(ids(result.charges)).toEqual(expect.arrayContaining(["chg-a", "chg-b"]));
  });
});

describe("mergeHouseholdChargesWithServer / mergeServerAuthoritativeRentProfiles", () => {
  it("omits a confirmed id the server dropped, keeps an unconfirmed local one", async () => {
    const store = await loadStore();
    const { merged } = store.mergeHouseholdChargesWithServer([A], [A, B, C], new Set(["chg-a", "chg-b"]));
    expect(ids(merged)).toEqual(["chg-a", "chg-c"]);
    const profiles = store.mergeServerAuthoritativeRentProfiles(
      [],
      [P1, makeProfile({ id: "rrp-2", residentEmail: "o@test.com" })],
      new Set(["rrp-1"]),
    );
    expect(ids(profiles)).toEqual(["rrp-2"]);
  });

  it("without a confirmed set behaves as before (every local-only row survives)", async () => {
    const store = await loadStore();
    expect(ids(store.mergeHouseholdChargesWithServer([A], [A, B]).merged)).toEqual(["chg-a", "chg-b"]);
  });
});
