import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DemoApplicantRow } from "@/data/demo-portal";

/**
 * Same resurrection as the household charges (2026-10-08): a stale manager tab kept an application the
 * server had deleted, `writeManagerApplicationRows` re-uploaded it through `action:"replace"`, and
 * `reconcileApprovedResidentPaymentSchedules` regenerated the resident's profile and charges from it.
 * A complete manager-scope read drops an application the server confirmed earlier and now omits; a
 * row the server never confirmed (a wizard draft whose POST has not landed) is kept.
 */

function row(over: Partial<DemoApplicantRow>): DemoApplicantRow {
  return {
    id: "PROPLANE-AAAAAAAA",
    name: "Jamie Rivera",
    property: "Alder Row — 3 rooms",
    stage: "Pending review",
    bucket: "pending",
    detail: "Started",
    ...over,
  } as DemoApplicantRow;
}

const SERVER_A = row({ id: "PROPLANE-SERVERA" });
const SERVER_B = row({ id: "PROPLANE-SERVERB", name: "Sam Lee" });
const DRAFT = row({ id: "PROPLANE-DRAFT1", stage: "In progress" });

let replies: Array<{ rows?: DemoApplicantRow[]; ok?: boolean }>;
let posts: Array<Record<string, unknown>>;

function stubBrowser() {
  replies = [];
  posts = [];
  vi.stubGlobal("window", {
    sessionStorage: {
      length: 0,
      key: () => null,
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    },
    localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    dispatchEvent: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init?: { method?: string; body?: string }) => {
      if ((init?.method ?? "GET").toUpperCase() !== "GET") {
        posts.push(JSON.parse(init?.body ?? "{}") as Record<string, unknown>);
        return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
      }
      const reply = replies.shift() ?? { rows: [] };
      return Promise.resolve({
        ok: reply.ok ?? true,
        status: reply.ok === false ? 500 : 200,
        json: async () => ({ rows: reply.rows ?? [] }),
      });
    }),
  );
}

async function loadStore() {
  vi.resetModules();
  stubBrowser();
  return import("@/lib/manager-applications-storage");
}

const ids = (rows: DemoApplicantRow[]) => rows.map((r) => r.id).sort();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse("2026-10-08T12:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("manager applications never resurrect a server-side delete", () => {
  it("drops a previously confirmed application a complete read omits, and keeps a never-confirmed draft", async () => {
    const store = await loadStore();
    replies.push({ rows: [SERVER_A, SERVER_B] });
    const first = await store.syncManagerApplicationsFromServerWithStatus({ force: true, managerUserId: "mgr-1" });
    expect(ids(first.rows)).toEqual(["PROPLANE-SERVERA", "PROPLANE-SERVERB"]);

    // A wizard draft created in this tab; its POST has not landed.
    store.appendManagerApplicationRow(DRAFT, { skipServerMirror: true });
    posts.length = 0;

    // The server deleted B (Delete resident); the draft is not on it yet.
    replies.push({ rows: [SERVER_A] });
    const second = await store.syncManagerApplicationsFromServerWithStatus({ force: true, managerUserId: "mgr-1" });

    expect(ids(second.rows)).toEqual(["PROPLANE-DRAFT1", "PROPLANE-SERVERA"]);
    expect(ids(store.readManagerApplicationRows())).toEqual(["PROPLANE-DRAFT1", "PROPLANE-SERVERA"]);
  });

  it("a failed read changes nothing", async () => {
    const store = await loadStore();
    replies.push({ rows: [SERVER_A, SERVER_B] });
    await store.syncManagerApplicationsFromServerWithStatus({ force: true, managerUserId: "mgr-1" });

    replies.push({ ok: false });
    const result = await store.syncManagerApplicationsFromServerWithStatus({ force: true, managerUserId: "mgr-1" });

    expect(result.ok).toBe(false);
    expect(ids(store.readManagerApplicationRows())).toEqual(["PROPLANE-SERVERA", "PROPLANE-SERVERB"]);
  });

  it("a read at the row cap may be truncated, so absence does not delete", async () => {
    const store = await loadStore();
    replies.push({ rows: [SERVER_A, SERVER_B] });
    await store.syncManagerApplicationsFromServerWithStatus({ force: true, managerUserId: "mgr-1" });

    const filler = Array.from({ length: 500 }, (_, index) => row({ id: `PROPLANE-FILL${index}`, name: `F${index}` }));
    replies.push({ rows: filler });
    await store.syncManagerApplicationsFromServerWithStatus({ force: true, managerUserId: "mgr-1" });

    const held = ids(store.readManagerApplicationRows());
    expect(held).toContain("PROPLANE-SERVERA");
    expect(held).toContain("PROPLANE-SERVERB");
  });

  it("the self slice never deletes (it only ever sees the caller's own rows)", async () => {
    const store = await loadStore();
    replies.push({ rows: [SERVER_A, SERVER_B] });
    await store.syncManagerApplicationsFromServerWithStatus({ force: true, managerUserId: "mgr-1" });

    replies.push({ rows: [SERVER_A] });
    await store.syncManagerApplicationsFromServerWithStatus({ force: true, managerUserId: "mgr-1", selfScope: true });

    expect(ids(store.readManagerApplicationRows())).toEqual(["PROPLANE-SERVERA", "PROPLANE-SERVERB"]);
  });
});
