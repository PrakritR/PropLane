import { beforeEach, describe, expect, it, vi } from "vitest";
import { reportFixture } from "../helpers/inspection-fixture";
import { createInspectionDocument, type InspectionRecord } from "@/lib/inspections/model";
import { createRoomInspectionDocument } from "@/lib/inspections/room-template";

/**
 * The export is the artifact a deposit dispute is argued from, so what it prints
 * matters as much as what it stores: a room section holding one item named after
 * the section printed its heading twice, and a room report whose baseline is a
 * legacy 15-area document dropped the move-in evidence the portal still shows.
 */
const drawn: string[] = [];
vi.mock("pdf-lib", () => {
  const capture = (text: string, options?: { size?: number }) => {
    if (options?.size === 12 && text.trim()) drawn.push(text);
  };
  return {
    rgb: () => ({}),
    StandardFonts: { Helvetica: "h", HelveticaBold: "hb" },
    PDFDocument: {
      create: async () => ({
        embedFont: async () => ({ widthOfTextAtSize: (text: string) => text.length * 5 }),
        embedJpg: async () => ({ scaleToFit: () => ({ width: 10, height: 10 }) }),
        addPage: () => ({ drawText: capture, drawImage: () => undefined }),
        getPages: () => [{ drawText: () => undefined }],
        getPageCount: () => 1,
        save: async () => new Uint8Array(),
      }),
    },
  };
});

let reports: InspectionRecord[];
vi.mock("@/lib/inspections/server", () => ({
  INSPECTION_BUCKET: "inspection-evidence",
  getInspection: async (_actor: unknown, id: string) => reports.find((r) => r.id === id)!,
}));

import { inspectionPdf } from "@/lib/inspections/pdf";

const actor = { role: "manager", context: { db: { storage: { from: () => ({ download: async () => ({ data: null, error: "x" }) }) } } } };
const roomDocument = () =>
  createRoomInspectionDocument({ assignment: "home::a", label: "Room A", furnished: false, privateBathroom: false });

beforeEach(() => {
  drawn.length = 0;
});

describe("inspection PDF headings", () => {
  it("prints a one-item room section's name once, not twice", async () => {
    reports = [reportFixture({ document: roomDocument() })];
    await inspectionPdf(actor as never, reports[0]!.id);
    expect(drawn.filter((line) => line === "Room overview")).toHaveLength(1);
  });

  it("still labels every item of a multi-item legacy section", async () => {
    reports = [reportFixture({ document: createInspectionDocument() })];
    await inspectionPdf(actor as never, reports[0]!.id);
    expect(drawn).toContain("Bedroom / private room");
    expect(drawn).toContain("Doors, knobs & locks");
  });
});

describe("a legacy baseline whose item ids no longer match", () => {
  it("prints the preserved private-room baseline instead of dropping it", async () => {
    const baseline = reportFixture({
      id: "22222222-2222-4222-8222-222222222222",
      document: createInspectionDocument(),
    });
    baseline.document.areas[0]!.items[0]!.resident.notes = "Scuff by the door at move-in";
    reports = [
      reportFixture({ document: roomDocument(), kind: "move-out", baseline_id: baseline.id }),
      baseline,
    ];

    await inspectionPdf(actor as never, reports[0]!.id);

    expect(drawn.some((line) => line.startsWith("Move-in baseline (original report"))).toBe(true);
    // The private room only — a room inspection never imports shared property areas.
    expect(drawn).toContain("Doors, knobs & locks");
    expect(drawn).not.toContain("Refrigerator");
  });

  it("adds no legacy section when the baseline shares this report's item ids", async () => {
    const baseline = reportFixture({ id: "33333333-3333-4333-8333-333333333333", document: roomDocument() });
    reports = [
      reportFixture({ document: roomDocument(), kind: "move-out", baseline_id: baseline.id }),
      baseline,
    ];

    await inspectionPdf(actor as never, reports[0]!.id);

    expect(drawn.some((line) => line.startsWith("Move-in baseline (original report"))).toBe(false);
  });
});
