/**
 * One identity rule for every manager list that groups by person.
 *
 * Payments, Tours and Services are read side by side. If one grouped by email and another by
 * name, the same person would head two differently-shaped groups on two tabs and a manager would
 * reasonably conclude PropLane had lost track of who they are.
 *
 * The asymmetry that matters: losing a group header is cosmetic, merging two people's rows is not.
 * Every ambiguous case below therefore resolves toward keeping people APART.
 */
import { describe, expect, it } from "vitest";
import {
  clusterRowsByResident,
  residentClusterKey,
  residentClusterLabel,
} from "@/lib/resident-row-clustering";

const row = (over: Partial<Parameters<typeof residentClusterKey>[0]> & { id: string }) => ({
  residentName: "Ahalya Bindhu Rajesh",
  residentEmail: "ahalya@example.com",
  ...over,
});

describe("resident identity", () => {
  it("prefers the name for the header and the email for the key", () => {
    const r = row({ id: "1" });
    expect(residentClusterLabel(r)).toBe("Ahalya Bindhu Rajesh");
    expect(residentClusterKey(r)).toBe("email:ahalya@example.com");
  });

  it("matches the same person across case and whitespace", () => {
    expect(residentClusterKey(row({ id: "1", residentEmail: "  AHALYA@Example.com " }))).toBe(
      residentClusterKey(row({ id: "2" })),
    );
  });

  it("falls back to the email as a label when there is no name", () => {
    expect(residentClusterLabel(row({ id: "1", residentName: "" }))).toBe("ahalya@example.com");
  });

  it("shows an em dash rather than an empty header", () => {
    expect(residentClusterLabel({ id: "1", residentName: "", residentEmail: "" })).toBe("—");
  });

  it("does not treat a bare string as an email", () => {
    // "not-an-email" has no @, so it must not become an `email:` key that another row could join.
    expect(residentClusterKey({ id: "1", residentName: "", residentEmail: "not-an-email" })).toBe("id:1");
  });

  it("prefixes keys by kind so a name cannot collide with an email", () => {
    const byName = residentClusterKey({ id: "1", residentName: "x@y.com", residentEmail: "" });
    const byEmail = residentClusterKey({ id: "2", residentEmail: "x@y.com" });
    expect(byName).not.toBe(byEmail);
  });

  it("keeps two anonymous rows APART rather than merging strangers", () => {
    const a = residentClusterKey({ id: "a", residentName: "", residentEmail: "" });
    const b = residentClusterKey({ id: "b", residentName: "", residentEmail: "" });
    expect(a).not.toBe(b);
  });
});

describe("clustering", () => {
  it("groups one person's rows under a single header", () => {
    const out = clusterRowsByResident([
      row({ id: "1" }),
      row({ id: "2", residentEmail: "AHALYA@example.com" }),
      row({ id: "3", residentEmail: "someone.else@example.com", residentName: "Nayan Taori" }),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]!.rows.map((r) => r.id)).toEqual(["1", "2"]);
    expect(out[1]!.residentLabel).toBe("Nayan Taori");
  });

  it("preserves the caller's ordering", () => {
    // The surface already sorted by due date or tour time; re-sorting here would silently
    // override a sort the manager can see.
    const out = clusterRowsByResident([
      row({ id: "z", residentEmail: "z@example.com" }),
      row({ id: "a", residentEmail: "a@example.com" }),
      row({ id: "z2", residentEmail: "z@example.com" }),
    ]);
    expect(out.map((c) => c.key)).toEqual(["email:z@example.com", "email:a@example.com"]);
    expect(out[0]!.rows.map((r) => r.id)).toEqual(["z", "z2"]);
  });

  it("labels the property only when every row agrees", () => {
    const same = clusterRowsByResident(
      [row({ id: "1" }), row({ id: "2" })],
      () => "5257 Brooklyn Ave NE",
    );
    expect(same[0]!.propertyLabel).toBe("5257 Brooklyn Ave NE");

    // A resident with rows at two properties gets NO header label rather than the first row's,
    // which would misattribute the rest.
    const mixed = clusterRowsByResident([row({ id: "1" }), row({ id: "2" })], (r) =>
      r.id === "1" ? "5257 Brooklyn Ave NE" : "4709A 8th Ave NE",
    );
    expect(mixed[0]!.propertyLabel).toBeNull();
  });

  it("has no property label when the list carries no property", () => {
    expect(clusterRowsByResident([row({ id: "1" })])[0]!.propertyLabel).toBeNull();
  });

  it("handles an empty list", () => {
    expect(clusterRowsByResident([])).toEqual([]);
  });
});
