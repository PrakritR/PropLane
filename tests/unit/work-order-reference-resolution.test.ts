import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";

const mocks = vi.hoisted(() => ({
  managerRows: vi.fn(),
  residentRows: vi.fn(),
  vendorRows: vi.fn(),
}));

vi.mock("@/lib/tools/domains/work-orders", () => ({ loadManagerWorkOrders: mocks.managerRows }));
vi.mock("@/lib/tools/domains/resident/load-resident-rows", () => ({ loadResidentEmailRows: mocks.residentRows }));
vi.mock("@/lib/tools/domains/vendor/load-vendor-rows", () => ({ loadVendorWorkOrders: mocks.vendorRows }));

import {
  resolveManagerWorkOrderReference,
  resolveResidentWorkOrderReference,
  resolveVendorWorkOrderReference,
  resolveVisibleWorkOrderReference,
} from "@/lib/tools/work-order-reference-resolution";

function row(id: string, reference: string, title: string, propertyName = "Cascade", unit = "2A") {
  return { id, reference, title, propertyName, unit, status: "Open" } as DemoManagerWorkOrderRow;
}

describe("resolveVisibleWorkOrderReference", () => {
  it("resolves a visible reference without replacing the opaque primary key", () => {
    const result = resolveVisibleWorkOrderReference("status wo 1042", [
      row("opaque-primary-key", "WO-1042", "Kitchen sink"),
    ]);
    expect(result).toMatchObject({
      kind: "resolved",
      candidates: [{ id: "opaque-primary-key", reference: "WO-1042", title: "Kitchen sink" }],
    });
  });

  it("does not resolve a row omitted by the caller's authorization scope", () => {
    expect(resolveVisibleWorkOrderReference("WO-1042", [])).toEqual({
      kind: "not_found",
      candidates: [],
      message: "We can't find that work order.",
    });
  });

  it("asks a useful question when a co-manager can see the same sequence under two owners", () => {
    const result = resolveVisibleWorkOrderReference("WO-1042", [
      row("one", "WO-1042", "Kitchen sink", "Cascade", "2A"),
      row("two", "WO-1042", "Bathroom fan", "Juniper", "4B"),
    ]);
    expect(result.kind).toBe("ambiguous");
    expect(result.message).toBe(
      "Did you mean WO-1042 (Kitchen sink, Cascade · 2A) or WO-1042 (Bathroom fan, Juniper · 4B)?",
    );
  });

  it("does not claim messages without a work-order reference", () => {
    expect(resolveVisibleWorkOrderReference("The sink is still leaking", [row("one", "WO-1042", "Sink")])).toEqual({
      kind: "no_reference",
      candidates: [],
      message: null,
    });
  });
});

describe("role-scoped work-order reference loaders", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses the manager loader, including its delegated-property scope", async () => {
    mocks.managerRows.mockResolvedValue([row("manager-visible", "WO-1042", "Kitchen sink")]);
    const result = await resolveManagerWorkOrderReference({} as never, "WO-1042");
    expect(mocks.managerRows).toHaveBeenCalledOnce();
    expect(result.candidates[0]?.id).toBe("manager-visible");
  });

  it("uses the resident email/active-manager loader", async () => {
    mocks.residentRows.mockImplementation(async (_ctx, table, map) => {
      expect(table).toBe("portal_work_order_records");
      return [map(row("resident-visible", "WO-1042", "Kitchen sink"))];
    });
    const result = await resolveResidentWorkOrderReference({} as never, "WO-1042");
    expect(mocks.residentRows).toHaveBeenCalledOnce();
    expect(result.candidates[0]?.id).toBe("resident-visible");
  });

  it("uses only assigned or live-offered vendor jobs", async () => {
    mocks.vendorRows.mockResolvedValue([
      { id: "vendor-visible", row: row("vendor-visible", "WO-1042", "Kitchen sink"), assignment: "assigned" },
    ]);
    const result = await resolveVendorWorkOrderReference({} as never, "WO-1042");
    expect(mocks.vendorRows).toHaveBeenCalledOnce();
    expect(result.candidates[0]?.id).toBe("vendor-visible");
  });
});

describe("work-order human reference migration", () => {
  const sql = readFileSync(
    join(process.cwd(), "supabase/migrations/20260904120000_work_order_human_references.sql"),
    "utf8",
  ).toLowerCase();

  it("keeps the primary key and enforces per-manager uniqueness", () => {
    expect(sql).not.toContain("drop column id");
    expect(sql).toContain("(manager_user_id, reference_sequence)");
    expect(sql).toContain("partition by manager_user_id");
  });

  it("allocates through an atomic counter and stamps row_data for every writer", () => {
    expect(sql).toContain("on conflict (manager_user_id) do update");
    expect(sql).toContain("before insert or update of manager_user_id, reference_sequence, row_data");
    expect(sql).toContain("'{reference}'");
  });
});
