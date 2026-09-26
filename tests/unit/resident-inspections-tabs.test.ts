import { describe, expect, it } from "vitest";
import {
  parseResidentInspectionTab,
  parseResidentInspectionTypeFilter,
  residentInspectionTab,
  RESIDENT_INSPECTION_TAB_LABELS,
  RESIDENT_INSPECTION_TAB_ORDER,
} from "@/lib/resident-inspections-tabs";

describe("residentInspectionTab", () => {
  it("buckets a row with no filed report as upcoming", () => {
    expect(residentInspectionTab(null)).toBe("upcoming");
    expect(residentInspectionTab(undefined)).toBe("upcoming");
  });

  it("buckets a draft report as in-progress", () => {
    expect(residentInspectionTab({ status: "draft" })).toBe("in-progress");
  });

  it("buckets a submitted report as in-progress (not yet done)", () => {
    expect(residentInspectionTab({ status: "submitted" })).toBe("in-progress");
  });

  it("buckets a completed report as done", () => {
    expect(residentInspectionTab({ status: "completed" })).toBe("done");
  });
});

describe("parseResidentInspectionTab", () => {
  it("accepts every real bucket id", () => {
    for (const id of RESIDENT_INSPECTION_TAB_ORDER) {
      expect(parseResidentInspectionTab(id)).toBe(id);
    }
  });

  it("falls back to upcoming for garbage or missing input", () => {
    expect(parseResidentInspectionTab("bogus")).toBe("upcoming");
    expect(parseResidentInspectionTab(undefined)).toBe("upcoming");
    expect(parseResidentInspectionTab(null)).toBe("upcoming");
  });

  it("has a label for every bucket", () => {
    for (const id of RESIDENT_INSPECTION_TAB_ORDER) {
      expect(RESIDENT_INSPECTION_TAB_LABELS[id]).toBeTruthy();
    }
  });
});

describe("parseResidentInspectionTypeFilter", () => {
  it("accepts all/move-in/move-out and defaults to all", () => {
    expect(parseResidentInspectionTypeFilter("move-in")).toBe("move-in");
    expect(parseResidentInspectionTypeFilter("move-out")).toBe("move-out");
    expect(parseResidentInspectionTypeFilter("all")).toBe("all");
    expect(parseResidentInspectionTypeFilter("bogus")).toBe("all");
    expect(parseResidentInspectionTypeFilter(undefined)).toBe("all");
  });
});
