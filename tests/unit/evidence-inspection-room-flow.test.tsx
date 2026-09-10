// @vitest-environment jsdom
/**
 * Render regression + evidence harness for the resident/manager room inspection.
 *
 * Drives the REAL `InspectionEditor` through the flow a person actually performs —
 * open a room section, add a photo from the section's own camera, let it autosave,
 * read the generated document — and writes the rendered markup to EVIDENCE_DIR (when
 * set) so it can be screenshotted in a browser. Same convention as
 * `evidence-lease-template-ui.test.tsx`: the render is always exercised, the HTML is
 * only written when EVIDENCE_DIR asks.
 *
 * There is no review ritual to drive: a report is a room and photos of it, from either
 * side, for as long as the residency lasts.
 */
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { writeEvidenceSurface } from "../helpers/evidence-dom";
import { reportFixture } from "../helpers/inspection-fixture";
import { createRoomInspectionDocument } from "@/lib/inspections/room-template";
import type { InspectionDetail, InspectionRecord } from "@/lib/inspections/model";

const { request, capture } = vi.hoisted(() => ({ request: vi.fn(), capture: vi.fn() }));
vi.mock("@/lib/inspections/client", () => ({ downloadInspection: vi.fn(), inspectionRequest: request }));
vi.mock("@/lib/native/use-native-camera", () => ({ useNativeCamera: () => ({ capture }) }));
import { InspectionEditor } from "@/components/portal/inspection-editor";


// A 1x1-ish inline photo so the evidence screenshots show a real image element.
const PHOTO_URL =
  "data:image/svg+xml;base64," +
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="112" height="80"><rect width="112" height="80" fill="#cbd5e1"/><rect x="8" y="34" width="96" height="38" fill="#94a3b8"/><circle cx="26" cy="22" r="10" fill="#e2e8f0"/><text x="56" y="26" font-family="system-ui" font-size="10" fill="#334155" text-anchor="middle">room photo</text></svg>`,
  ).toString("base64");

function roomReport(overrides: Partial<InspectionRecord> = {}): InspectionRecord {
  return reportFixture({
    resident_name: "Jordan Reyes",
    property_label: "Brooklyn House",
    room_label: "Room 3",
    document: createRoomInspectionDocument({ assignment: "home::room-3", label: "Room 3", furnished: true, privateBathroom: true }),
    ...overrides,
  });
}

/** The row that OPENS a section, not the camera button sitting beside it. */
const sectionRow = (label: string) => screen.getByRole("button", { name: new RegExp(`^${label}`) });

afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("resident: room sections, photo upload from the section, autosave, document preview", async () => {
  const detail: InspectionDetail = { report: roomReport(), baseline: null, canEdit: true };

  // Only the resident's assigned room — no common areas, no other rooms.
  expect(detail.report.document.areas.map(a => a.label)).toEqual([
    "Room overview", "Walls, ceiling & floor", "Windows & blinds", "Door, lock & closet",
    "Lights & outlets", "Other", "Furniture", "Private bathroom",
  ]);

  render(<InspectionEditor initial={detail} role="resident" userId="resident" onBack={vi.fn()} onChanged={vi.fn()} />);
  // No Refresh / search / status-filter chrome, and no routine Save/Reload buttons.
  for (const gone of [/^Refresh$/, /^Reload$/, /^Save$/, /^Search$/]) {
    expect(screen.queryByRole("button", { name: gone })).toBeNull();
  }
  // Every section carries its own camera; nothing has to be ticked first.
  expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  expect(screen.getAllByRole("button", { name: /^Add photos to / })).toHaveLength(8);
  writeEvidenceSurface("inspection-01-room-sections", "Resident · Inspections · assigned room sections only, each row opening a section with its own camera beside it. Pinned bottom actions: Add photos, View document.", 150);

  fireEvent.click(sectionRow("Room overview"));

  // Typing a note autosaves after the pause — no Save button anywhere.
  const noted = structuredClone(detail);
  noted.report.revision = 2;
  noted.report.document.areas[0]!.items[0]!.resident.notes = "Small scuff to the left of the door frame.";
  request.mockResolvedValueOnce(noted);
  fireEvent.change(screen.getByRole("textbox", { name: "Room overview notes" }), {
    target: { value: "Small scuff to the left of the door frame." },
  });
  await waitFor(() => expect(request).toHaveBeenCalledTimes(1), { timeout: 3000 });
  await screen.findByText("Saved automatically.");

  // A photo from the native/web picker uploads against the freshly saved revision.
  const photo = { previewUrl: "blob:pending", file: new File(["image"], "room-3.jpg", { type: "image/jpeg" }) };
  capture.mockResolvedValue(photo);
  vi.stubGlobal("URL", Object.assign(URL, { revokeObjectURL: vi.fn() }));
  const withPhoto = structuredClone(noted);
  withPhoto.report.revision = 3;
  withPhoto.report.document.areas[0]!.items[0]!.resident.photos.push({
    id: "photo-1", path: "private/room-3.jpg", url: PHOTO_URL, uploadedBy: "resident", uploadedAt: "2026-09-05T10:00:00Z",
  });
  request.mockResolvedValueOnce(withPhoto);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Add photos" })); });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Choose from files" })); });
  await screen.findByText("Photo added. Your document is up to date.");
  expect(screen.getByAltText("Room overview evidence")).toBeTruthy();
  writeEvidenceSurface("inspection-02-section-photo-note", "Resident · one open section · photo uploaded from the picker, optional note autosaved (“Saved automatically.” / “Photo added.”). No condition or liability inferred from the photo.", 150);

  // The document preview is deterministic: exactly what was saved.
  fireEvent.click(screen.getByRole("button", { name: "View document" }));
  expect(screen.getByText("ROOM CONDITION REPORT")).toBeTruthy();
  expect(screen.getByText("Small scuff to the left of the door frame.")).toBeTruthy();
  expect(screen.getByText(/records who added it and when/)).toBeTruthy();
  writeEvidenceSurface("inspection-03-document-preview", "Resident · generated document preview — Room 3 only, resident photos and notes, each photo attributed to whoever added it.", 150);
  vi.unstubAllGlobals();
});

/**
 * The captain's rule: "there is a room, either resident or manager uploads photos in move-in
 * and move-out. THAT'S IT." No submit, no confirmation, no approval, no reopen — on either
 * side — and no report that closes itself against the other party.
 */
it("neither party is offered a review step, and both can add photos to the same report", async () => {
  const draft = roomReport();
  draft.document.areas[0]!.items[0]!.resident.notes = "Small scuff to the left of the door frame.";
  draft.document.areas[0]!.items[0]!.resident.photos.push({
    id: "photo-1", path: "private/room-3.jpg", url: PHOTO_URL, uploadedBy: "resident", uploadedAt: "2026-09-05T10:00:00Z",
  });

  render(<InspectionEditor initial={{ report: structuredClone(draft), baseline: null, canEdit: true }} role="resident" userId="resident" onBack={vi.fn()} onChanged={vi.fn()} />);
  for (const gone of ["Submit for review", "Request confirmation", "Confirm review", "Request changes", "Approve inspection", "Mark reviewed"]) {
    expect(screen.queryByRole("button", { name: gone })).toBeNull();
  }
  expect(screen.getByRole("button", { name: "Add photos" })).toBeTruthy();
  writeEvidenceSurface("inspection-04-resident-photos-only", "Resident · a report with saved photos and notes — the pinned footer holds Add photos and View document, and nothing else. No submit, no confirmation.", 150);
  cleanup();

  // The manager opens the SAME report: reads the resident's evidence, adds their own.
  render(<InspectionEditor initial={{ report: structuredClone(draft), baseline: null, canEdit: true }} role="manager" userId="owner" onBack={vi.fn()} onChanged={vi.fn()} />);
  for (const gone of ["Request confirmation", "Approve inspection", "Request changes", "Mark reviewed"]) {
    expect(screen.queryByRole("button", { name: gone })).toBeNull();
  }
  fireEvent.click(sectionRow("Room overview"));
  // The manager reads the resident's evidence separately from their own.
  expect(screen.getByText("Resident observations")).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "Room overview notes" })).toBeTruthy();
  writeEvidenceSurface("inspection-05-manager-same-report", "Manager · the same report — the resident's photos and notes read as their own section, and the manager adds theirs beside them. No approval gate.", 150);
});

it("move-out: the move-in baseline stays readable beside the new observations", async () => {
  const baseline = roomReport({ id: "baseline-id", inspection_date: "2026-03-01" });
  baseline.document.areas[0]!.items[0]!.resident.notes = "Wall was clean at move-in.";
  baseline.document.areas[0]!.items[0]!.resident.photos.push({
    id: "baseline-photo", path: "private/baseline.jpg", url: PHOTO_URL, uploadedBy: "resident", uploadedAt: "2026-03-01T10:00:00Z",
  });
  const detail: InspectionDetail = {
    report: roomReport({ id: "move-out-id", kind: "move-out", inspection_date: "2026-09-05", baseline_id: "baseline-id" }),
    baseline,
    canEdit: true,
  };
  render(<InspectionEditor initial={detail} role="resident" userId="resident" onBack={vi.fn()} onChanged={vi.fn()} />);
  fireEvent.click(sectionRow("Room overview"));
  // Same residency / property / manager / room, with the move-in report as baseline.
  expect(screen.getByText(/Move-in photos and notes · 2026-03-01/)).toBeTruthy();
  fireEvent.click(screen.getByText(/Move-in photos and notes · 2026-03-01/));
  expect(screen.getByText("Wall was clean at move-in.")).toBeTruthy();
  writeEvidenceSurface("inspection-06-move-out-baseline", "Resident · move-out on the same room — the move-in report is attached automatically as the baseline, readable inline beside the new photos.", 150);
});
