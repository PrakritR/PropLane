import { describe, expect, it } from "vitest";
import { reportFixture } from "../helpers/inspection-fixture";
import { createInspectionDocument } from "@/lib/inspections/model";
import { createRoomInspectionDocument } from "@/lib/inspections/room-template";
import { buildInspectionPrintSections } from "@/lib/inspections/model";

/**
 * C137: the resident/manager Export opens a real print-styled report. This mirrors
 * `tests/unit/inspection-pdf-export.test.ts` exactly — same fixtures, same
 * assertions in spirit — because the print view and the PDF must print the same
 * sections; `buildInspectionPrintSections` is the one function both `pdf.ts` logic
 * and the print page are built from never disagreeing about what belongs where.
 */
const roomDocument = () =>
  createRoomInspectionDocument({ assignment: "home::a", label: "Room A", furnished: false, privateBathroom: false });

describe("inspection print sections", () => {
  it("prints a one-item room section's name once, not twice", () => {
    const report = reportFixture({ document: roomDocument() });
    const sections = buildInspectionPrintSections(report, null);
    expect(sections.filter((s) => s.title === "Room overview")).toHaveLength(1);
  });

  it("labels every item of a multi-item legacy section by area — item", () => {
    const report = reportFixture({ document: createInspectionDocument() });
    const sections = buildInspectionPrintSections(report, null);
    expect(sections.some((s) => s.title === "Bedroom / private room — Doors, knobs & locks")).toBe(true);
  });

  it("each section carries move-in/move-out manager and resident observations", () => {
    const report = reportFixture({ document: roomDocument() });
    const sections = buildInspectionPrintSections(report, null);
    const headings = sections[0]!.observations.map((o) => o.heading);
    expect(headings).toEqual(["Move-in / manager", "Move-in / resident"]);
  });

  it("includes photos on the observation they belong to", () => {
    const document = roomDocument();
    document.areas[0]!.items[0]!.resident.photos = [
      { id: "p1", path: "x/y.jpg", uploadedBy: "u1", uploadedAt: "2026-09-05T00:00:00Z", url: "https://signed.example/p1" },
    ];
    const report = reportFixture({ document });
    const sections = buildInspectionPrintSections(report, null);
    const residentObs = sections[0]!.observations.find((o) => o.heading === "Move-in / resident")!;
    expect(residentObs.photos).toHaveLength(1);
    expect(residentObs.photos[0]!.url).toBe("https://signed.example/p1");
  });
});

describe("a legacy baseline whose item ids no longer match", () => {
  it("keeps the preserved private-room baseline instead of dropping it", () => {
    const baseline = reportFixture({
      id: "22222222-2222-4222-8222-222222222222",
      document: createInspectionDocument(),
    });
    baseline.document.areas[0]!.items[0]!.resident.notes = "Scuff by the door at move-in";
    const report = reportFixture({ document: roomDocument(), kind: "move-out", baseline_id: baseline.id });

    const sections = buildInspectionPrintSections(report, baseline);

    expect(sections.some((s) => s.title.startsWith("Move-in baseline ("))).toBe(true);
    // The private room only — a room inspection never imports shared property areas.
    expect(sections.some((s) => s.title.endsWith("Doors, knobs & locks"))).toBe(true);
    expect(sections.some((s) => s.title.endsWith("Refrigerator"))).toBe(false);
  });

  it("adds no legacy section when the baseline shares this report's item ids", () => {
    const baseline = reportFixture({ id: "33333333-3333-4333-8333-333333333333", document: roomDocument() });
    const report = reportFixture({ document: roomDocument(), kind: "move-out", baseline_id: baseline.id });

    const sections = buildInspectionPrintSections(report, baseline);

    expect(sections.some((s) => s.title.startsWith("Move-in baseline ("))).toBe(false);
  });
});

describe("a room section the listing has since dropped", () => {
  it("keeps its move-in evidence in the export", () => {
    const furnished = createRoomInspectionDocument({ assignment: "home::a", label: "Room A", furnished: true, privateBathroom: false });
    const baseline = reportFixture({ id: "44444444-4444-4444-8444-444444444444", document: furnished });
    const report = reportFixture({ document: roomDocument(), kind: "move-out", baseline_id: baseline.id });

    const sections = buildInspectionPrintSections(report, baseline);

    expect(sections.some((s) => s.title.startsWith("Move-in baseline (") && s.title.endsWith("Furniture"))).toBe(true);
    // Matched sections stay inline, so they are not repeated in the retained block.
    expect(sections.filter((s) => s.title === "Room overview")).toHaveLength(1);
  });
});
