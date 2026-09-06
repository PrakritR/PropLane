import { describe, expect, it, vi } from "vitest";

const { resolveAgentContext, resolveResidentAgentContext, listInspections, listInspectionResidencies } = vi.hoisted(() => ({
  resolveAgentContext: vi.fn(),
  resolveResidentAgentContext: vi.fn(),
  listInspections: vi.fn(),
  listInspectionResidencies: vi.fn(),
}));

vi.mock("@/lib/tools/context", () => ({ resolveAgentContext }));
vi.mock("@/lib/tools/resident-context", () => ({ resolveResidentAgentContext }));
vi.mock("@/lib/inspections/server", () => ({
  listInspections, listInspectionResidencies,
  addInspectionPhoto: vi.fn(), changeInspectionStatus: vi.fn(), createInspection: vi.fn(),
  inspectionDetail: vi.fn(), removeInspectionPhoto: vi.fn(), saveInspection: vi.fn(),
}));
vi.mock("@/lib/inspections/pdf", () => ({ inspectionPdf: vi.fn() }));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/inspections/[[...path]]/route";
import { InspectionError } from "@/lib/inspections/model";

/**
 * The reports table and the residency roster are read independently. `Promise.all` let one
 * failure blank both, so on an environment whose migrations had not been applied the page
 * showed "Could not load inspection records" over an empty list — hiding a roster that read
 * perfectly well, and telling the manager to retry something no retry could fix.
 */

function request(url = "https://prop-lane.space/api/inspections?portal=manager") {
  return new NextRequest(url, { method: "GET", headers: { host: "prop-lane.space" } }) as never;
}
const params = { params: Promise.resolve({ path: undefined }) } as never;

describe("inspections list route", () => {
  it("returns the roster with a notice when the reports table is unreadable", async () => {
    resolveAgentContext.mockResolvedValue({ userId: "mgr", db: {} });
    listInspections.mockRejectedValue(new InspectionError('Inspections are not set up in this environment yet — the "resident_inspections" table is missing. Apply the pending database migrations to enable them.', 503));
    listInspectionResidencies.mockResolvedValue([{ id: "app-1", name: "aarav jain", property: "5259 Brooklyn Ave NE", room: "Room 1", canCreate: true, moveInDate: "2026-08-01", moveOutDate: "", occupancy: "current" }]);

    const response = await GET(request(), params);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.residencies).toHaveLength(1);
    expect(body.reports).toEqual([]);
    expect(body.notice).toContain("resident_inspections");
    expect(body.notice).toContain("migrations");
  });

  it("returns the reports with a notice when only the roster fails", async () => {
    resolveAgentContext.mockResolvedValue({ userId: "mgr", db: {} });
    listInspections.mockResolvedValue([{ id: "r-1" }]);
    listInspectionResidencies.mockRejectedValue(new InspectionError("Could not load inspection records. Please try again.", 500));

    const body = await (await GET(request(), params)).json();

    expect(body.reports).toHaveLength(1);
    expect(body.residencies).toEqual([]);
    expect(body.notice).toContain("Please try again");
  });

  it("fails the request outright only when neither half can be read", async () => {
    resolveAgentContext.mockResolvedValue({ userId: "mgr", db: {} });
    listInspections.mockRejectedValue(new InspectionError("Could not load inspection records. Please try again.", 500));
    listInspectionResidencies.mockRejectedValue(new InspectionError("Could not load inspection records. Please try again.", 500));

    const response = await GET(request(), params);

    expect(response.status).toBe(500);
    expect((await response.json()).error).toContain("Could not load inspection records");
  });

  it("carries no notice when both halves load", async () => {
    resolveAgentContext.mockResolvedValue({ userId: "mgr", db: {} });
    listInspections.mockResolvedValue([]);
    listInspectionResidencies.mockResolvedValue([]);

    expect(await (await GET(request(), params)).json()).toEqual({ reports: [], residencies: [] });
  });
});
