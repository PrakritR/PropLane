/**
 * An empty scope is not "no scope".
 *
 * A workspace holding no homes produced an EMPTY property list, and every
 * caller collapsed that into "the caller named no houses" — which means "show
 * everything". A workspace with 0 properties therefore listed every tour,
 * application and resident in the account. These guard the two halves of that
 * bug: the tour filter, and the report scope helper the server reads with.
 */
import { describe, expect, it } from "vitest";
import { tourInquiryVisibleToViewer } from "@/lib/co-manager-calendar";
import type { PartnerInquiry } from "@/lib/demo-admin-scheduling";
import {
  applyReportPropertyScope,
  reportPropertyScope,
  reportRowInScope,
  reportScopeIsEmpty,
} from "@/lib/reports/workspace-scope";

const inquiry = {
  id: "inq-1",
  kind: "tour",
  status: "pending",
  propertyId: "mgr-demo-cascade",
  propertyTitle: "Cascade Lofts",
  managerUserId: "mgr-1",
  name: "Guest",
  email: "guest@example.com",
} as unknown as PartnerInquiry;

describe("tour visibility under a workspace scope", () => {
  it("shows the tour when no scope is named", () => {
    expect(tourInquiryVisibleToViewer(inquiry, { viewerUserId: "mgr-1", propertyId: null, peers: [] })).toBe(true);
  });

  it("hides every tour when the scope holds no houses", () => {
    expect(
      tourInquiryVisibleToViewer(inquiry, {
        viewerUserId: "mgr-1",
        propertyId: null,
        propertyIds: [],
        peers: [],
      }),
    ).toBe(false);
  });

  it("shows only the tours the scope names", () => {
    const filter = { viewerUserId: "mgr-1", propertyId: null, peers: [] };
    expect(tourInquiryVisibleToViewer(inquiry, { ...filter, propertyIds: ["mgr-demo-cascade"] })).toBe(true);
    expect(tourInquiryVisibleToViewer(inquiry, { ...filter, propertyIds: ["mgr-demo-pioneer"] })).toBe(false);
  });
});

describe("manager report property scope", () => {
  it("does not narrow when the account is a single workspace", () => {
    expect(reportPropertyScope({})).toBeNull();
    expect(reportScopeIsEmpty({})).toBe(false);
    expect(reportRowInScope({}, null)).toBe(true);
  });

  it("reports nothing when the workspace holds no houses", () => {
    const filters = { workspacePropertyIds: [] };
    expect(reportPropertyScope(filters)).toEqual([]);
    expect(reportScopeIsEmpty(filters)).toBe(true);
    expect(reportRowInScope(filters, "p1")).toBe(false);
  });

  it("intersects the workspace with an explicit property filter", () => {
    const filters = { workspacePropertyIds: ["p1", "p2"] };
    expect(reportPropertyScope(filters, "p1")).toEqual(["p1"]);
    // A house outside the workspace cannot be filtered back in.
    expect(reportPropertyScope(filters, "p9")).toEqual([]);
  });

  it("narrows a query and never widens one", () => {
    const calls: { column: string; values: string[] }[] = [];
    const query = {
      in(column: string, values: string[]) {
        calls.push({ column, values });
        return this;
      },
    };
    applyReportPropertyScope(query, {});
    expect(calls).toHaveLength(0);

    applyReportPropertyScope(query, { workspacePropertyIds: ["p1"] });
    expect(calls.at(-1)).toEqual({ column: "property_id", values: ["p1"] });

    // An empty scope must still reach the database as a predicate that matches
    // nothing — dropping it would return the whole account.
    applyReportPropertyScope(query, { workspacePropertyIds: [] });
    expect(calls.at(-1)!.values).toHaveLength(1);
    expect(calls.at(-1)!.values[0]).not.toBe("");
  });
});
