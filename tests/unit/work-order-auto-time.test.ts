/**
 * `autoTimeNewWorkOrder` decides what to do with a Stage C time suggestion for
 * a brand-new resident service — book it, merely propose it, or leave the row
 * alone. The suggestion engine itself is covered by
 * `manager-schedule-suggest-server.test.ts`, so this stubs
 * `suggestManagerTimeForKind` outright and exercises only the booking policy.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";

const suggestManagerTimeForKind = vi.fn();
vi.mock("@/lib/manager-schedule-suggest.server", () => ({
  suggestManagerTimeForKind: (...args: unknown[]) => suggestManagerTimeForKind(...args),
}));

const loadVendorDispatchSettings = vi.fn();
vi.mock("@/lib/vendor-dispatch-settings", () => ({
  loadVendorDispatchSettings: (...args: unknown[]) => loadVendorDispatchSettings(...args),
}));

import { autoTimeNewWorkOrder, willDispatchRun } from "@/lib/work-order-auto-time.server";

const MANAGER = "mgr-autotime-1";
const NOW = new Date("2026-09-15T17:00:00Z");
const SUGGESTED_ISO = "2026-09-16T17:00:00.000Z";

function baseRow(overrides: Partial<DemoManagerWorkOrderRow> = {}): DemoManagerWorkOrderRow {
  return {
    id: "wo-autotime-1",
    propertyName: "Alder Row",
    unit: "2",
    title: "Leaky faucet",
    priority: "Medium",
    status: "Submitted",
    bucket: "open",
    description: "Kitchen faucet drips.",
    scheduled: "—",
    cost: "—",
    ...overrides,
  };
}

const db = {} as never;

beforeEach(() => {
  suggestManagerTimeForKind.mockReset();
  loadVendorDispatchSettings.mockReset();
});

describe("autoTimeNewWorkOrder", () => {
  it("books the visit when Stage C found painted availability and dispatch will not run", async () => {
    suggestManagerTimeForKind.mockResolvedValueOnce({ iso: SUGGESTED_ISO, source: "availability" });

    const { row, outcome } = await autoTimeNewWorkOrder(db, MANAGER, baseRow(), {
      now: NOW,
      dispatchWillRun: false,
    });

    expect(outcome).toEqual({ kind: "booked", iso: SUGGESTED_ISO });
    expect(row.bucket).toBe("scheduled");
    expect(row.status).toBe("Scheduled");
    expect(row.scheduledAtIso).toBe(SUGGESTED_ISO);
    expect(row.selfAssigned).toBe(true);
    expect(row.proposedVisit).toEqual({
      iso: SUGGESTED_ISO,
      source: "availability",
      suggestedAtIso: NOW.toISOString(),
    });
  });

  it("only proposes an availability slot when vendor dispatch is about to run", async () => {
    suggestManagerTimeForKind.mockResolvedValueOnce({ iso: SUGGESTED_ISO, source: "availability" });

    const { row, outcome } = await autoTimeNewWorkOrder(db, MANAGER, baseRow(), {
      now: NOW,
      dispatchWillRun: true,
    });

    expect(outcome).toEqual({ kind: "proposed", iso: SUGGESTED_ISO, source: "availability" });
    expect(row.bucket).toBe("open");
    expect(row.scheduledAtIso).toBeUndefined();
    expect(row.selfAssigned).toBeUndefined();
    expect(row.proposedVisit).toEqual({
      iso: SUGGESTED_ISO,
      source: "availability",
      suggestedAtIso: NOW.toISOString(),
    });
  });

  it("only proposes a PropLane pick, never books it", async () => {
    suggestManagerTimeForKind.mockResolvedValueOnce({ iso: SUGGESTED_ISO, source: "proplane-pick" });

    const { row, outcome } = await autoTimeNewWorkOrder(db, MANAGER, baseRow(), {
      now: NOW,
      dispatchWillRun: false,
    });

    expect(outcome).toEqual({ kind: "proposed", iso: SUGGESTED_ISO, source: "proplane-pick" });
    expect(row.bucket).toBe("open");
    expect(row.scheduledAtIso).toBeUndefined();
  });

  it("does nothing when Stage C has no suggestion at all", async () => {
    suggestManagerTimeForKind.mockResolvedValueOnce(null);

    const { row, outcome } = await autoTimeNewWorkOrder(db, MANAGER, baseRow(), { now: NOW });

    expect(outcome).toEqual({ kind: "none" });
    expect(row.proposedVisit).toBeUndefined();
  });

  it("leaves an already-scheduled row untouched without even asking Stage C", async () => {
    const scheduled = baseRow({ bucket: "scheduled", scheduledAtIso: "2026-09-16T18:00:00.000Z" });

    const { row, outcome } = await autoTimeNewWorkOrder(db, MANAGER, scheduled, { now: NOW });

    expect(outcome).toEqual({ kind: "none" });
    expect(row).toBe(scheduled);
    expect(suggestManagerTimeForKind).not.toHaveBeenCalled();
  });

  it("leaves a manager-initiated row untouched", async () => {
    const managerInitiated = baseRow({ managerInitiated: true });

    const { row, outcome } = await autoTimeNewWorkOrder(db, MANAGER, managerInitiated, { now: NOW });

    expect(outcome).toEqual({ kind: "none" });
    expect(row).toBe(managerInitiated);
    expect(suggestManagerTimeForKind).not.toHaveBeenCalled();
  });
});

describe("willDispatchRun", () => {
  it("is false once any of prepareDispatch's own early-return guards would fire", async () => {
    expect(await willDispatchRun(db, MANAGER, baseRow({ managerInitiated: true, category: "plumbing" }))).toBe(false);
    expect(await willDispatchRun(db, MANAGER, baseRow({ bucket: "scheduled", category: "plumbing" }))).toBe(false);
    expect(await willDispatchRun(db, MANAGER, baseRow({ selfAssigned: true, category: "plumbing" }))).toBe(false);
    expect(await willDispatchRun(db, MANAGER, baseRow({ vendorId: "v1", category: "plumbing" }))).toBe(false);
    expect(await willDispatchRun(db, MANAGER, baseRow({ category: undefined }))).toBe(false);
    expect(loadVendorDispatchSettings).not.toHaveBeenCalled();
  });

  it("defers to the manager's vendor dispatch mode once the row itself qualifies", async () => {
    loadVendorDispatchSettings.mockResolvedValueOnce({ mode: "off" });
    expect(await willDispatchRun(db, MANAGER, baseRow({ category: "plumbing" }))).toBe(false);

    loadVendorDispatchSettings.mockResolvedValueOnce({ mode: "approve" });
    expect(await willDispatchRun(db, MANAGER, baseRow({ category: "plumbing" }))).toBe(true);
  });
});
