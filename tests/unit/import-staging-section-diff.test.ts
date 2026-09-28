// F004/F016: the shared section-diff used to compute "N sections found · N
// changed" and the changed-sections-only compare view.
import { describe, expect, it } from "vitest";
import { changedSectionEntries, diffImportSections } from "@/lib/import-staging/section-diff";

describe("diffImportSections", () => {
  it("counts an unchanged section as unchanged, not changed", () => {
    const summary = diffImportSections(
      [{ key: "fees", title: "Fees", body: "Rent is due on the 1st." }],
      [{ key: "fees", title: "Fees", body: "Rent is due on the 1st." }],
    );
    expect(summary.totalIncoming).toBe(1);
    expect(summary.changedCount).toBe(0);
    expect(summary.entries).toEqual([
      { key: "fees", title: "Fees", status: "unchanged", currentBody: "Rent is due on the 1st.", incomingBody: "Rent is due on the 1st." },
    ]);
  });

  it("counts a section whose body differs as changed", () => {
    const summary = diffImportSections(
      [{ key: "fees", title: "Fees", body: "Rent is due on the 1st." }],
      [{ key: "fees", title: "Fees", body: "Rent is due on the 5th." }],
    );
    expect(summary.changedCount).toBe(1);
    expect(summary.entries[0]!.status).toBe("changed");
  });

  it("counts a brand-new section (not present in current) as changed, via 'added'", () => {
    const summary = diffImportSections(
      [{ key: "fees", title: "Fees", body: "Rent is due on the 1st." }],
      [
        { key: "fees", title: "Fees", body: "Rent is due on the 1st." },
        { key: "pets", title: "Pets", body: "No pets allowed." },
      ],
    );
    expect(summary.totalIncoming).toBe(2);
    expect(summary.changedCount).toBe(1);
    const added = summary.entries.find((entry) => entry.key === "pets");
    expect(added?.status).toBe("added");
    expect(added?.currentBody).toBeNull();
  });

  it("counts a section present only in current (dropped by the new parse) as removed, and still changed", () => {
    const summary = diffImportSections(
      [
        { key: "fees", title: "Fees", body: "Rent is due on the 1st." },
        { key: "pets", title: "Pets", body: "No pets allowed." },
      ],
      [{ key: "fees", title: "Fees", body: "Rent is due on the 1st." }],
    );
    // "removed" sections are not part of the incoming parse's own total.
    expect(summary.totalIncoming).toBe(1);
    expect(summary.changedCount).toBe(1);
    const removed = summary.entries.find((entry) => entry.key === "pets");
    expect(removed?.status).toBe("removed");
    expect(removed?.incomingBody).toBeNull();
  });

  it("matches by normalized title when no explicit key is given", () => {
    const summary = diffImportSections(
      [{ title: "  Fees  ", body: "old" }],
      [{ title: "fees", body: "old" }],
    );
    expect(summary.entries[0]!.status).toBe("unchanged");
  });

  it("changedSectionEntries excludes unchanged sections only", () => {
    const summary = diffImportSections(
      [{ key: "a", title: "A", body: "same" }],
      [
        { key: "a", title: "A", body: "same" },
        { key: "b", title: "B", body: "new" },
      ],
    );
    const changed = changedSectionEntries(summary);
    expect(changed.map((e) => e.key)).toEqual(["b"]);
  });

  it("an empty incoming parse against real current content reports zero found and every current section removed", () => {
    const summary = diffImportSections([{ key: "a", title: "A", body: "x" }], []);
    expect(summary.totalIncoming).toBe(0);
    expect(summary.changedCount).toBe(1);
    expect(summary.entries[0]!.status).toBe("removed");
  });
});
