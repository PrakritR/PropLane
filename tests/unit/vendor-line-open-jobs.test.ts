// list_open_jobs_near: the Find work board's own public view, filtered by the place and trade a texter names.
import { describe, expect, it, vi } from "vitest";
import { createFakeDb } from "../helpers/fake-table-db";
import { BOARD_FIXTURE } from "../helpers/vendor-line-fixtures";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));
vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveTestWorkspaceClassification: vi.fn(async () => ({ kind: "normal" })),
  lookupRecordTestWorkspaceId: vi.fn(async () => null),
}));

import { listOpenJobsNear, titleWithoutAddress } from "@/lib/open-jobs-near.server";
import { vendorLineRegistry } from "@/lib/tools/vendor-line-index";
import { buildVendorLineContext } from "@/lib/tools/vendor-line-context";

const db = () => createFakeDb({ portal_work_order_records: BOARD_FIXTURE, work_order_vendor_offers: [], vendor_business_profiles: [] }) as never;

describe("listOpenJobsNear", () => {
  it("lists only published, unassigned, still-open services", async () => {
    const out = await listOpenJobsNear(db(), {});
    expect(out.total).toBe(3);
    expect(out.jobs.map((j) => j.trade).sort()).toEqual(["Cleaning", "Plumbing", "Plumbing"]);
    expect(out.filteredByArea).toBe(false);
  });

  it("filters by the place named: Ballard has only the cleaning job", async () => {
    const out = await listOpenJobsNear(db(), { areaText: "any jobs near Ballard" });
    expect(out.filteredByArea).toBe(true);
    expect(out.place?.id).toBeTruthy();
    expect(out.jobs).toHaveLength(1);
    expect(out.jobs[0]).toMatchObject({ trade: "Cleaning", area: expect.stringContaining("Ballard") });
  });

  it("filters by a zip", async () => {
    const out = await listOpenJobsNear(db(), { areaText: "98115" });
    expect(out.jobs).toHaveLength(1);
    expect(out.jobs[0]!.area).toContain("98115");
  });

  it("filters by trade, and trade + place together", async () => {
    const plumbing = await listOpenJobsNear(db(), { tradeLabel: "Plumbing" });
    expect(plumbing.jobs.every((j) => j.trade === "Plumbing")).toBe(true);
    expect(plumbing.total).toBe(2);
    const none = await listOpenJobsNear(db(), { tradeLabel: "Plumbing", areaText: "Ballard" });
    expect(none.jobs).toEqual([]);
  });

  it("a place with no jobs returns none, not everything", async () => {
    const out = await listOpenJobsNear(db(), { areaText: "West Seattle" });
    expect(out.jobs).toEqual([]);
    expect(out.total).toBe(0);
  });

  it("never carries a street address, unit, resident, id or ref", async () => {
    const out = await listOpenJobsNear(db(), {});
    const text = JSON.stringify(out);
    for (const secret of ["1420 Alder", "88 Pike", "500 Pine", "4B", "SECRET RESIDENT", "ref-wo", "wo-ravenna", "mgr-1"]) {
      expect(text).not.toContain(secret);
    }
    expect(out.jobs.find((j) => j.trade === "Cleaning")!.title).toBe("Turnover clean");
  });

  it("shows the published budget and arrival, nothing else about pay", async () => {
    const out = await listOpenJobsNear(db(), { areaText: "98115" });
    expect(out.jobs[0]).toMatchObject({ budget: "Up to $250", when: "Anytime" });
    const clean = (await listOpenJobsNear(db(), { areaText: "Ballard" })).jobs[0]!;
    expect(clean).toMatchObject({ budget: "", when: "Weekdays" });
  });

  it("a signed-in vendor skips jobs they already hold an offer on and uses their saved area", async () => {
    const d = createFakeDb({
      portal_work_order_records: BOARD_FIXTURE,
      work_order_vendor_offers: [{ work_order_id: "wo-ravenna", vendor_user_id: "v1" }],
    }) as never;
    const profile = { user_id: "v1", trades: ["Plumbing"], service_area_zips: ["98101"], service_radius_miles: 5, license_number: null, insurance_expires_at: null, insurance_doc_path: null, directory_listed: true, onboarding_completed_at: "2026-09-01" };
    const out = await listOpenJobsNear(d, { vendor: { userId: "v1", profile } });
    expect(out.filteredByArea).toBe(true);
    expect(out.jobs.map((j) => j.title)).toEqual(["Toilet running"]);
  });

  it("the limit cuts the list but total keeps the count", async () => {
    const out = await listOpenJobsNear(db(), { limit: 1 });
    expect(out.jobs).toHaveLength(1);
    expect(out.total).toBe(3);
  });
});

describe("titleWithoutAddress", () => {
  it("drops the street and keeps the work", () => {
    expect(titleWithoutAddress("Leaky tap at 123 Main St", "Plumbing")).toBe("Leaky tap");
    expect(titleWithoutAddress("123 Main St", "Plumbing")).toBe("Plumbing");
    expect(titleWithoutAddress("Replace water heater", "Plumbing")).toBe("Replace water heater");
  });
});

describe("the vendor-line registry", () => {
  it("is one read tool and no write", () => {
    expect([...vendorLineRegistry.values()].map((t) => t.name)).toEqual(["list_open_jobs_near"]);
    expect([...vendorLineRegistry.values()].every((t) => t.kind === "read")).toBe(true);
  });

  it("runs from the context and cannot be handed a scope by the model", async () => {
    const tool = vendorLineRegistry.get("list_open_jobs_near")!;
    expect(tool.inputSchema.safeParse({ trade: "Plumbing", landlordId: "x" }).success).toBe(false);
    const ctx = buildVendorLineContext(db(), { landlordId: "svc", senderPhone: "+12065550142", vendorUserId: null });
    const out = (await (tool as never as { handler: (c: unknown, i: unknown) => Promise<{ jobs: unknown[] }> }).handler(ctx, { area: "98107" })).jobs;
    expect(out).toHaveLength(1);
  });
});
