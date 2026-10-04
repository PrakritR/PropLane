import { describe, expect, it } from "vitest";
import {
  createPropertyApplicationTemplate,
  groupApplicationTemplatesByStay,
  withApplicationAppliesTo,
  withApplicationDefaultForStay,
  type PropertyApplicationTemplate,
} from "@/lib/property-application-templates";

function app(label: string, appliesTo: "long_term" | "short_term" | "both"): PropertyApplicationTemplate {
  return { ...createPropertyApplicationTemplate({ kind: "standard", label }), appliesTo };
}

describe("groupApplicationTemplatesByStay", () => {
  it("orders groups Long term, Short term, Both regardless of row order", () => {
    const rows = [app("B", "both"), app("S", "short_term"), app("L", "long_term")];
    const groups = groupApplicationTemplatesByStay(rows);
    expect(groups.map((g) => [g.id, g.label])).toEqual([
      ["long_term", "Long term"],
      ["short_term", "Short term"],
      ["both", "Both"],
    ]);
  });

  it("omits empty groups", () => {
    const groups = groupApplicationTemplatesByStay([app("L1", "long_term"), app("L2", "long_term")]);
    expect(groups.map((g) => g.id)).toEqual(["long_term"]);
    expect(groupApplicationTemplatesByStay([])).toEqual([]);
  });

  it("derives the default flag per group from defaultFor, never for Both or a lone row", () => {
    const l1 = app("L1", "long_term");
    const l2 = app("L2", "long_term");
    const s1 = app("S1", "short_term");
    const s2 = app("S2", "short_term");
    const both = app("B", "both");
    const lone = app("Lone", "long_term");
    let rows = [l1, l2, s1, s2, both];
    rows = withApplicationDefaultForStay(rows, l2.id, "long_term");
    rows = withApplicationDefaultForStay(rows, s1.id, "short_term");
    const groups = groupApplicationTemplatesByStay(rows);
    const flags = Object.fromEntries(groups.flatMap((g) => g.rows.map((r) => [r.template.label, r.isDefault])));
    expect(flags).toEqual({ L1: false, L2: true, S1: true, S2: false, B: false });

    const single = groupApplicationTemplatesByStay([lone]);
    expect(single[0]!.rows[0]!.isDefault).toBe(false);
  });

  it("falls back to the first row of a stay when none is explicit, and follows Applies to moves", () => {
    const l1 = app("L1", "long_term");
    const l2 = app("L2", "long_term");
    const flagsOf = (rows: PropertyApplicationTemplate[]) =>
      Object.fromEntries(groupApplicationTemplatesByStay(rows).flatMap((g) => g.rows.map((r) => [r.template.label, r.isDefault])));
    expect(flagsOf([l1, l2])).toEqual({ L1: true, L2: false });
    const moved = withApplicationAppliesTo(withApplicationDefaultForStay([l1, l2], l1.id, "long_term"), l1.id, "both");
    const groups = groupApplicationTemplatesByStay(moved);
    expect(groups.map((g) => g.id)).toEqual(["long_term", "both"]);
    expect(flagsOf(moved)).toEqual({ L1: false, L2: false });
  });

  it("keeps defaults judged over all rows when only some are visible (search)", () => {
    const l1 = app("L1", "long_term");
    const l2 = app("L2", "long_term");
    const groups = groupApplicationTemplatesByStay([l1, l2], [], [l2]);
    expect(groups[0]!.rows.map((r) => [r.template.label, r.isDefault])).toEqual([["L2", false]]);
  });
});
