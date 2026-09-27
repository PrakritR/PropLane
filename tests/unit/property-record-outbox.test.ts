// @vitest-environment jsdom
/**
 * The property-record outbox replaced the page-load mirror, which re-uploaded
 * every property on every Properties page visit (12 full-record writes for a
 * 3-property portfolio, with 409s against concurrent edits). These pin what the
 * outbox must keep from that mirror (one write at a time, only a plan refusal
 * is ever surfaced) and what it adds (nothing sent when nothing is unsent, a
 * failed write survives to the next sync, a refused one is never replayed).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PROPERTY_RECORD_OUTBOX_MAX_AGE_MS,
  PROPERTY_RECORD_REFUSED_EVENT,
  enqueuePropertyRecordWrite,
  flushPropertyRecordOutbox,
  overlayPendingPropertyWrites,
  pendingPropertyRecordWrites,
  type PropertyRecordRefusedDetail,
  type PropertyRecordUpsertBody,
} from "@/lib/property-record-outbox";
import type { PropertyPipelineSnapshot } from "@/lib/persisted-property-records";

const VIEWER = "mgr-outbox-viewer";

function body(id: string, status = "live", extra: Partial<PropertyRecordUpsertBody> = {}): PropertyRecordUpsertBody {
  return {
    action: "upsert",
    id,
    managerUserId: VIEWER,
    status,
    propertyData: { id, buildingName: `House ${id}` },
    editRequestNote: null,
    ...extra,
  };
}

type Reply = { status: number; body?: unknown } | "offline";

/** A fake server that records every upsert id and concurrency; `reply` decides each answer. */
function server(reply: (id: string) => Reply) {
  const sent: string[] = [];
  let inFlight = 0;
  let maxConcurrent = 0;
  const fetchImpl = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
    const { id } = JSON.parse(String(init?.body ?? "{}")) as { id: string };
    sent.push(id);
    inFlight += 1;
    maxConcurrent = Math.max(maxConcurrent, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 0));
    inFlight -= 1;
    const answer = reply(id);
    if (answer === "offline") throw new TypeError("Failed to fetch");
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      json: async () => answer.body ?? {},
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, sent, maxConcurrent: () => maxConcurrent };
}

let refused: PropertyRecordRefusedDetail[];
const onRefused = (event: Event) => refused.push((event as CustomEvent<PropertyRecordRefusedDetail>).detail);

beforeEach(() => {
  window.localStorage.clear();
  refused = [];
  window.addEventListener(PROPERTY_RECORD_REFUSED_EVENT, onRefused);
});
afterEach(() => {
  window.removeEventListener(PROPERTY_RECORD_REFUSED_EVENT, onRefused);
  vi.useRealTimers();
});

describe("property-record outbox", () => {
  it("sends nothing when there is nothing unsent (the ordinary page load)", async () => {
    const { fetchImpl, sent } = server(() => ({ status: 200 }));
    await flushPropertyRecordOutbox(VIEWER, fetchImpl);
    expect(sent).toEqual([]);
  });

  it("clears a write the server accepted", async () => {
    const { fetchImpl, sent } = server(() => ({ status: 200 }));
    await enqueuePropertyRecordWrite(VIEWER, body("mgr-a"), fetchImpl);
    expect(sent).toEqual(["mgr-a"]);
    expect(pendingPropertyRecordWrites(VIEWER)).toEqual([]);
  });

  it("keeps a write that never landed and retries it on the next flush, one at a time", async () => {
    let online = false;
    const { fetchImpl, sent, maxConcurrent } = server(() => (online ? { status: 200 } : "offline"));
    await enqueuePropertyRecordWrite(VIEWER, body("mgr-a"), fetchImpl);
    await enqueuePropertyRecordWrite(VIEWER, body("mgr-b"), fetchImpl);
    expect(pendingPropertyRecordWrites(VIEWER).map((e) => e.body.id).sort()).toEqual(["mgr-a", "mgr-b"]);

    online = true;
    sent.length = 0;
    await flushPropertyRecordOutbox(VIEWER, fetchImpl);
    expect(sent).toEqual(["mgr-a", "mgr-b"]);
    expect(maxConcurrent()).toBe(1);
    expect(pendingPropertyRecordWrites(VIEWER)).toEqual([]);
  });

  it("keeps a write the server failed with a 5xx, and never surfaces its text", async () => {
    const { fetchImpl } = server(() => ({ status: 500, body: { error: 'null value in column "id"' } }));
    await enqueuePropertyRecordWrite(VIEWER, body("mgr-a"), fetchImpl);
    expect(pendingPropertyRecordWrites(VIEWER)).toHaveLength(1);
    expect(refused).toEqual([]);
  });

  it("settles a refused write (no silent replay) and reports the server's own explanation", async () => {
    const refusal = { error: "Your plan allows 1 listing.", code: "property_limit_reached" };
    const { fetchImpl, sent } = server(() => ({ status: 403, body: refusal }));
    await enqueuePropertyRecordWrite(VIEWER, body("mgr-a"), fetchImpl);
    expect(pendingPropertyRecordWrites(VIEWER)).toEqual([]);
    expect(refused).toEqual([{ id: "mgr-a", status: 403, message: refusal.error, code: refusal.code }]);

    await flushPropertyRecordOutbox(VIEWER, fetchImpl);
    expect(sent).toEqual(["mgr-a"]);
  });

  it("keeps only the latest write per record, and a slow older answer cannot clear the newer edit", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        await gate; // the OLD write is slow, then accepted
        return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
      }
      throw new TypeError("Failed to fetch"); // the NEW write never lands
    }) as unknown as typeof fetch;

    const oldWrite = enqueuePropertyRecordWrite(VIEWER, body("mgr-a", "live", { propertyData: { id: "mgr-a", buildingName: "Old" } }), fetchImpl);
    await enqueuePropertyRecordWrite(VIEWER, body("mgr-a", "live", { propertyData: { id: "mgr-a", buildingName: "New" } }), fetchImpl);
    release();
    await oldWrite;

    const pending = pendingPropertyRecordWrites(VIEWER);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.seq).toBe(2);
    expect(pending[0]?.body.propertyData).toEqual({ id: "mgr-a", buildingName: "New" });
  });

  it("never replays another account's writes", async () => {
    const { fetchImpl, sent } = server(() => "offline");
    await enqueuePropertyRecordWrite("mgr-someone-else", body("mgr-theirs"), fetchImpl);
    sent.length = 0;
    await flushPropertyRecordOutbox(VIEWER, fetchImpl);
    expect(sent).toEqual([]);
    expect(pendingPropertyRecordWrites(VIEWER)).toEqual([]);
  });

  it("drops a write left unsent past the max age instead of replaying it over newer work", async () => {
    const { fetchImpl } = server(() => "offline");
    await enqueuePropertyRecordWrite(VIEWER, body("mgr-a"), fetchImpl);
    const later = Date.now() + PROPERTY_RECORD_OUTBOX_MAX_AGE_MS + 1;
    expect(pendingPropertyRecordWrites(VIEWER, later)).toEqual([]);
    expect(pendingPropertyRecordWrites(VIEWER)).toEqual([]);
  });

  it("lays an unsent write over a fresh snapshot so the edit never appears to revert", async () => {
    const { fetchImpl } = server(() => "offline");
    await enqueuePropertyRecordWrite(VIEWER, body("mgr-a", "live", { propertyData: { id: "mgr-a", buildingName: "Edited" } }), fetchImpl);
    await enqueuePropertyRecordWrite(
      VIEWER,
      body("pend-b", "pending", { propertyData: undefined, rowData: { id: "pend-b", buildingName: "Draft" } }),
      fetchImpl,
    );
    const snapshot = {
      pendingByUser: {},
      extrasByUser: { [VIEWER]: [{ id: "mgr-a", buildingName: "Server copy" }, { id: "mgr-c", buildingName: "Other" }] },
      sideGlobal: { requestChange: [], unlisted: [], rejected: [], drafts: [] },
      sideByUser: {},
    } as unknown as PropertyPipelineSnapshot;

    const next = overlayPendingPropertyWrites(snapshot, pendingPropertyRecordWrites(VIEWER));
    expect(next.extrasByUser[VIEWER]?.map((p) => p.buildingName)).toEqual(["Edited", "Other"]);
    expect(next.pendingByUser[VIEWER]?.map((p) => p.id)).toEqual(["pend-b"]);
    // The server snapshot itself is untouched.
    expect(snapshot.extrasByUser[VIEWER]?.[0]?.buildingName).toBe("Server copy");
  });
});
