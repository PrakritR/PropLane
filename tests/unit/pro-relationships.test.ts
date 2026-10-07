import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mergeRelationshipRows,
  normalizeProRelationshipRecord,
  writeProRelationships,
  type ProRelationshipRecord,
} from "@/lib/pro-relationships";

function makeRow(id: string, assignedPropertyIds: string[] = []): ProRelationshipRecord {
  return {
    id,
    linkedAxisId: `${id}@example.com`,
    perspective: "manager_tab",
    payoutPercentForManager: 15,
    assignedPropertyIds,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("pro-relationships", () => {
  it("normalizes co-manager link rows with permissions", () => {
    const row = normalizeProRelationshipRecord({
      id: "rel-1",
      linkedAxisId: "co@example.com",
      linkedDisplayName: "Co Manager",
      payoutPercentForManager: 20,
      assignedPropertyIds: ["prop-a", "prop-b"],
      coManagerPermissions: { applications: true, payments: true },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(row?.linkedAxisId).toBe("co@example.com");
    expect(row?.payoutPercentForManager).toBe(20);
    expect(row?.assignedPropertyIds).toEqual(["prop-a", "prop-b"]);
    expect(row?.coManagerPermissions).toEqual({ applications: true, payments: true });
  });

  it("migrates legacy canEditListing to properties permission", () => {
    const row = normalizeProRelationshipRecord({
      id: "rel-2",
      linkedAxisId: "legacy@example.com",
      canEditListing: true,
    });
    expect(row?.coManagerPermissions?.properties).toBe(true);
  });

  it("defaults payout percent when missing", () => {
    const row = normalizeProRelationshipRecord({
      id: "rel-3",
      linkedAxisId: "default@example.com",
    });
    expect(row?.payoutPercentForManager).toBe(15);
  });

  it("rejects invalid records", () => {
    expect(normalizeProRelationshipRecord(null)).toBeNull();
    expect(normalizeProRelationshipRecord({ id: "only-id" })).toBeNull();
  });

  it("allows assigned property lists to shrink on merge", () => {
    const previous = [makeRow("rel-1", ["prop-a", "prop-b", "prop-c"])];
    const incoming = [makeRow("rel-1", ["prop-a"])];
    const merged = mergeRelationshipRows(previous, incoming);
    expect(merged[0]?.assignedPropertyIds).toEqual(["prop-a"]);
  });

  it("keeps previous assigned ids only when incoming omits the list", () => {
    const previous = [makeRow("rel-1", ["prop-a", "prop-b"])];
    const incoming = [makeRow("rel-1", [])];
    const merged = mergeRelationshipRows(previous, incoming);
    expect(merged[0]?.assignedPropertyIds).toEqual(["prop-a", "prop-b"]);
  });
});

describe("writeProRelationships no-op guard", () => {
  // The infinite-render-loop guard: an unchanged write must not dispatch the
  // "axis-pro-relationships" event or POST, since that event re-enters the
  // render effects that called it.
  let dispatchEvent: ReturnType<typeof vi.fn>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dispatchEvent = vi.fn();
    fetchMock = vi.fn(() => Promise.resolve({ ok: true, json: async () => ({}) }));
    vi.stubGlobal("window", { dispatchEvent });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("dispatches and POSTs on a real change, then stays silent on an identical write", () => {
    const userId = `user-${Math.random().toString(36).slice(2)}`;

    writeProRelationships(userId, [makeRow("a")]);
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Identical content (fresh array reference) must be a no-op.
    writeProRelationships(userId, [makeRow("a")]);
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A genuine change resumes dispatching.
    writeProRelationships(userId, [makeRow("a"), makeRow("b")]);
    expect(dispatchEvent).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("skips the network POST when there are no rows", () => {
    const userId = `user-${Math.random().toString(36).slice(2)}`;
    writeProRelationships(userId, []);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
