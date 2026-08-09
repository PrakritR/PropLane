/**
 * Regression: the organizer's group size was never collected anywhere in the
 * apply wizard — the field was only ever READ back (a joining member inherits it
 * from the organizer's preview).
 *
 * That value is load-bearing twice over:
 *   - `buildApplicationGroups` derives `expectedSize` from the first
 *     applicant's `groupSize`, which drives "Group N/M", `missingCount` and
 *     `isComplete`. With no value every group reads as size-unknown.
 *   - `bundle-cost-split` divides the move-in charges by the declared household
 *     size, so with no value there is nothing to split by.
 */
import { describe, expect, it } from "vitest";
import { validateGroupSize } from "@/app/(public)/rent/apply/apply-validation";
import { buildApplicationGroups } from "@/lib/rental-application/application-groups";

describe("validateGroupSize", () => {
  it("accepts a real group", () => {
    expect(validateGroupSize("2").ok).toBe(true);
    expect(validateGroupSize("3").ok).toBe(true);
    expect(validateGroupSize(" 4 ").ok).toBe(true);
  });

  it("rejects blank — the state that used to ship", () => {
    const r = validateGroupSize("");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/how many people/i);
  });

  it("rejects a group of one and points at the No option", () => {
    const r = validateGroupSize("1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/2 or more/i);
  });

  it("rejects non-numeric and absurd sizes", () => {
    expect(validateGroupSize("three").ok).toBe(false);
    expect(validateGroupSize("2.5").ok).toBe(false);
    expect(validateGroupSize("30").ok).toBe(false);
  });
});

describe("group reconciliation with a declared size", () => {
  const base = {
    groupId: "AXISGRP-ABCDEFGH1234",
    bundleId: "bundle-1",
    propertyId: "prop-1",
    status: "submitted" as const,
  };

  it("derives expectedSize from the organizer so N/M can render", () => {
    const groups = buildApplicationGroups([
      { ...base, id: "a", name: "Alex", email: "a@x.com", role: "first", groupSize: "3" },
      { ...base, id: "b", name: "Bo", email: "b@x.com", role: "joining", groupSize: "" },
    ]);
    const group = groups.get(base.groupId);
    expect(group?.expectedSize).toBe(3);
    expect(group?.totalCount).toBe(2);
    expect(group?.missingCount).toBe(1);
    expect(group?.isComplete).toBe(false);
  });

  it("without an organizer size the group is unknown — the old behaviour", () => {
    const groups = buildApplicationGroups([
      { ...base, id: "a", name: "Alex", email: "a@x.com", role: "first", groupSize: "" },
      { ...base, id: "b", name: "Bo", email: "b@x.com", role: "joining", groupSize: "" },
    ]);
    const group = groups.get(base.groupId);
    expect(group?.expectedSize).toBeNull();
    expect(group?.missingCount).toBeNull();
    expect(group?.isComplete).toBe(false);
  });

  it("completes once every declared member has submitted", () => {
    const groups = buildApplicationGroups([
      { ...base, id: "a", name: "Alex", email: "a@x.com", role: "first", groupSize: "2" },
      { ...base, id: "b", name: "Bo", email: "b@x.com", role: "joining", groupSize: "" },
    ]);
    const group = groups.get(base.groupId);
    expect(group?.expectedSize).toBe(2);
    expect(group?.isComplete).toBe(true);
    expect(group?.isOverSubscribed).toBe(false);
  });
});
