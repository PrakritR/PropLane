import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DemoApplicantRow } from "@/data/demo-portal";

/**
 * The GET drops a row it cannot open and names it in `skippedRowIds`. Nothing read that field, so a
 * manager just saw one fewer application — and, worse, the short list was treated as a COMPLETE one,
 * which is what lets absence delete a cached row. The count now reaches the store and the list says
 * it in one line.
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

const KEPT = row({ id: "PROPLANE-KEPT111" });
const LATER_SKIPPED = row({ id: "PROPLANE-SKIP111", name: "Sam Lee" });

let replies: Array<{ rows: DemoApplicantRow[]; skippedRowIds?: string[] }>;

function stubBrowser() {
  replies = [];
  const listeners = new Map<string, Set<(event: Event) => void>>();
  vi.stubGlobal("window", {
    sessionStorage: {
      length: 0,
      key: () => null,
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    },
    localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    addEventListener: vi.fn((type: string, listener: (event: Event) => void) => {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    }),
    removeEventListener: vi.fn((type: string, listener: (event: Event) => void) => {
      listeners.get(type)?.delete(listener);
    }),
    dispatchEvent: vi.fn((event: Event) => {
      for (const listener of listeners.get(event.type) ?? []) listener(event);
      return true;
    }),
  });
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init?: { method?: string }) => {
      if ((init?.method ?? "GET").toUpperCase() !== "GET") {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
      }
      const reply = replies.shift() ?? { rows: [] };
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ rows: reply.rows, ...(reply.skippedRowIds ? { skippedRowIds: reply.skippedRowIds } : {}) }),
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
  vi.setSystemTime(Date.parse("2026-10-17T12:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a row the route could not open reaches the list", () => {
  it("reports how many were skipped, and repeats it on a reused read", async () => {
    const store = await loadStore();
    replies.push({ rows: [KEPT], skippedRowIds: ["PROPLANE-SKIP111"] });
    const first = await store.syncManagerApplicationsFromServerWithStatus({ force: true, managerUserId: "mgr-1" });
    expect(first.skippedCount).toBe(1);

    // The TTL hit carries the same evidence instead of losing it on a remount.
    const reused = await store.syncManagerApplicationsFromServerWithStatus({ managerUserId: "mgr-1" });
    expect(reused.skippedCount).toBe(1);
  });

  it("is not a complete list, so absence cannot delete a cached row", async () => {
    const store = await loadStore();
    replies.push({ rows: [KEPT, LATER_SKIPPED] });
    const confirming = await store.syncManagerApplicationsFromServerWithStatus({ force: true, managerUserId: "mgr-1" });
    expect(confirming.complete).toBe(true);

    // Same read, except the route could not open one of the two rows this time.
    replies.push({ rows: [KEPT], skippedRowIds: ["PROPLANE-SKIP111"] });
    const short = await store.syncManagerApplicationsFromServerWithStatus({ force: true, managerUserId: "mgr-1" });
    expect(short.complete).toBe(false);
    expect(ids(store.readManagerApplicationRows())).toEqual(["PROPLANE-KEPT111", "PROPLANE-SKIP111"]);
  });

  it("reports nothing skipped when the route skipped nothing", async () => {
    const store = await loadStore();
    replies.push({ rows: [KEPT] });
    const result = await store.syncManagerApplicationsFromServerWithStatus({ force: true, managerUserId: "mgr-1" });
    expect(result.skippedCount).toBe(0);
    expect(result.complete).toBe(true);
  });
});

describe("the Applications list says so in one line", () => {
  it("draws a single sentence, singular or plural, and no subtext paragraph", () => {
    const source = readFileSync(
      join(__dirname, "..", "..", "src", "components", "portal", "pro-applications.tsx"),
      "utf8",
    );
    expect(source).toContain('setSkippedRowCount(result.skippedCount ?? 0)');
    const notice = source.slice(source.indexOf('data-attr="applications-skipped-rows-note"'));
    const line = notice.slice(0, notice.indexOf("</div>"));
    expect(line).toContain("1 application couldn't be loaded.");
    expect(line).toContain("applications couldn't be loaded.");
  });

  it("drops the line when the workspace changes instead of waiting for the next poll", () => {
    const source = readFileSync(
      join(__dirname, "..", "..", "src", "components", "portal", "pro-applications.tsx"),
      "utf8",
    );
    const effect = source.slice(source.indexOf("const [skippedRowCount, setSkippedRowCount]"));
    const body = effect.slice(0, effect.indexOf("Returning from embedded Stripe"));
    expect(body).toContain("WORKSPACE_SELECTION_EVENT");
    expect(body).toContain("setSkippedRowCount(0)");
    expect(body).toContain("void read(true)");
  });
});

describe("a workspace switch does not keep the previous skip count", () => {
  it("forgets the count when the confirmed workspace changes, and a TTL read does not replay it", async () => {
    const store = await loadStore();
    const { setWorkspaceSelection } = await import("@/lib/workspaces/selection");
    const select = (id: string | null) =>
      setWorkspaceSelection({ workspaces: [], activeWorkspaceId: id });
    try {
      select("ws-a");
      replies.push({ rows: [KEPT], skippedRowIds: ["PROPLANE-SKIP111"] });
      const first = await store.syncManagerApplicationsFromServerWithStatus({ force: true, managerUserId: "mgr-1" });
      expect(first.skippedCount).toBe(1);

      // Refreshing the same workspace is not a switch.
      select("ws-a");
      const same = await store.syncManagerApplicationsFromServerWithStatus({ managerUserId: "mgr-1" });
      expect(same.skippedCount).toBe(1);

      select("ws-b");
      replies.push({ rows: [KEPT] });
      const next = await store.syncManagerApplicationsFromServerWithStatus({ managerUserId: "mgr-1" });
      expect(next.ok).toBe(true);
      expect(next.skippedCount).toBe(0);
    } finally {
      select(null);
    }
  });
});
