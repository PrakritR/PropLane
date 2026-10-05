import { describe, expect, it } from "vitest";
import {
  createPropertyApplicationTemplate,
  groupApplicationTemplatesByStay,
  withApplicationAppliesTo,
  withApplicationDefaultForStay,
  withoutApplicationDefaultForStay,
  type PropertyApplicationTemplate,
} from "@/lib/property-application-templates";

function app(label: string, appliesTo: "long_term" | "short_term" | "both"): PropertyApplicationTemplate {
  return { ...createPropertyApplicationTemplate({ kind: "standard", label }), appliesTo };
}

describe("groupApplicationTemplatesByStay", () => {
  it("orders groups Long term, Short term regardless of row order, and has no Both group", () => {
    const rows = [app("B", "both"), app("S", "short_term"), app("L", "long_term")];
    const groups = groupApplicationTemplatesByStay(rows);
    expect(groups.map((g) => [g.id, g.label])).toEqual([
      ["long_term", "Long term"],
      ["short_term", "Short term"],
    ]);
  });

  it("lists a both-form in EACH section as the same item", () => {
    const both = app("B", "both");
    const groups = groupApplicationTemplatesByStay([app("L", "long_term"), both, app("S", "short_term")]);
    expect(groups.map((g) => g.rows.map((r) => r.template.label))).toEqual([["L", "B"], ["B", "S"]]);
    const copies = groups.flatMap((g) => g.rows.filter((r) => r.template.id === both.id));
    expect(copies.map((r) => r.stay)).toEqual(["long_term", "short_term"]);
    expect(new Set(copies.map((r) => r.template.id)).size).toBe(1);
  });

  it("lists the co-signer application under Long term only, and never as a default", () => {
    const cosigner = { ...createPropertyApplicationTemplate({ kind: "long-term", label: "Co-signer" }), formVariant: "cosigner" as const };
    const l1 = app("L1", "long_term");
    const groups = groupApplicationTemplatesByStay([l1, cosigner, app("S", "short_term")]);
    expect(groups.map((g) => [g.id, g.rows.map((r) => r.template.label)])).toEqual([
      ["long_term", ["L1", "Co-signer"]],
      ["short_term", ["S"]],
    ]);
    const rows = groups[0]!.rows;
    expect(rows.every((r) => !(r.template.label === "Co-signer" && r.isDefault))).toBe(true);
  });

  it("a both-form can be the default of long term and/or short term (defaultFor)", () => {
    const both = app("B", "both");
    const l = app("L", "long_term");
    const s = app("S", "short_term");
    const flags = (list: PropertyApplicationTemplate[]) =>
      groupApplicationTemplatesByStay(list).map((g) => [g.id, g.rows.find((r) => r.isDefault)?.template.label]);
    // Long term only: the short-term default stays the section's own first form.
    let rows = withApplicationDefaultForStay([s, both, l], both.id, "long_term");
    expect(flags(rows)).toEqual([["long_term", "B"], ["short_term", "S"]]);
    expect(rows.find((r) => r.id === both.id)!.defaultFor).toEqual(["long_term"]);
    rows = withApplicationDefaultForStay(rows, both.id, "short_term");
    expect(flags(rows)).toEqual([["long_term", "B"], ["short_term", "B"]]);
    expect(rows.find((r) => r.id === both.id)!.defaultFor).toEqual(["long_term", "short_term"]);
    rows = withoutApplicationDefaultForStay(rows, both.id, "long_term");
    expect(rows.find((r) => r.id === both.id)!.defaultFor).toEqual(["short_term"]);
  });

  it("omits empty groups", () => {
    const groups = groupApplicationTemplatesByStay([app("L1", "long_term"), app("L2", "long_term")]);
    expect(groups.map((g) => g.id)).toEqual(["long_term"]);
    expect(groupApplicationTemplatesByStay([])).toEqual([]);
  });

  it("derives the default flag per group from defaultFor, never for a lone row", () => {
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
    // B is in both sections; neither section names it, and the first row of each is not it either.

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
    expect(groups.map((g) => g.id)).toEqual(["long_term", "short_term"]);
    // L1 is now a both-form: it keeps its long-term default (it still covers long term) and shows once per section.
    expect(moved.find((r) => r.id === l1.id)!.defaultFor).toEqual(["long_term"]);
    expect(groups[0]!.rows.map((r) => [r.template.label, r.isDefault])).toEqual([["L1", true], ["L2", false]]);
    expect(groups[1]!.rows.map((r) => [r.template.label, r.isDefault])).toEqual([["L1", false]]);
    // Moved to short term only, the long-term default it held goes with it.
    const short = withApplicationAppliesTo(moved, l1.id, "short_term");
    expect(short.find((r) => r.id === l1.id)!.defaultFor).toBeUndefined();
  });

  it("keeps defaults judged over all rows when only some are visible (search)", () => {
    const l1 = app("L1", "long_term");
    const l2 = app("L2", "long_term");
    const groups = groupApplicationTemplatesByStay([l1, l2], [], [l2]);
    expect(groups[0]!.rows.map((r) => [r.template.label, r.isDefault])).toEqual([["L2", false]]);
  });
});
