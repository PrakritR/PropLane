// @vitest-environment jsdom
/**
 * Render regression + evidence harness for the resident/manager room inspection.
 *
 * Drives the REAL `InspectionEditor` through the flow a person actually performs —
 * open a room section, add a photo, let it autosave, read the generated document,
 * submit with the acknowledgment confirmation, then approve as the manager — and
 * writes the rendered markup to EVIDENCE_DIR (when set) so it can be screenshotted
 * in a browser. Same convention as `evidence-lease-template-ui.test.tsx`: the
 * render is always exercised, the HTML is only written when EVIDENCE_DIR asks.
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

afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("resident: room sections, photo upload, autosave, document preview, submit + acknowledge", async () => {
  const detail: InspectionDetail = { report: roomReport(), baseline: null, canEdit: true };

  // Only the resident's assigned room — no common areas, no other rooms.
  expect(detail.report.document.areas.map(a => a.label)).toEqual([
    "Room overview", "Walls, ceiling & floor", "Windows & blinds", "Door, lock & closet",
    "Lights & outlets", "Furniture", "Private bathroom",
  ]);

  render(<InspectionEditor initial={detail} role="resident" userId="resident" onBack={vi.fn()} onChanged={vi.fn()} />);
  // No Refresh / search / status-filter chrome, and no routine Save/Reload buttons.
  for (const gone of [/^Refresh$/, /^Reload$/, /^Save$/, /^Search$/]) {
    expect(screen.queryByRole("button", { name: gone })).toBeNull();
  }
  expect(screen.getAllByRole("checkbox")).toHaveLength(7);
  writeEvidenceSurface("inspection-01-room-sections", "Resident · Inspections · assigned room sections only, each row a checkbox that opens one section. Pinned bottom actions.", 150);

  fireEvent.click(screen.getByRole("button", { name: /Room overview/ }));

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
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Upload photos" })); });
  await screen.findByText("Photo added. Your document is up to date.");
  expect(screen.getByAltText("Room overview evidence")).toBeTruthy();
  writeEvidenceSurface("inspection-02-section-photo-note", "Resident · one open section · photo uploaded from the picker, optional note autosaved (“Saved automatically.” / “Photo added.”). No Good/liability inferred from the photo.", 150);

  // The document preview is deterministic: exactly what was saved.
  fireEvent.click(screen.getByRole("button", { name: "View document" }));
  expect(screen.getByText("ROOM CONDITION REPORT")).toBeTruthy();
  expect(screen.getByText("Small scuff to the left of the door frame.")).toBeTruthy();
  expect(screen.getByText(/Resident acknowledgment pending/)).toBeTruthy();
  writeEvidenceSurface("inspection-03-document-preview", "Resident · generated document preview — Room 3 only, resident observations, acknowledgment + manager approval both pending.", 150);

  expect(screen.queryByRole("button", { name: "Submit for review" })).toBeNull();
  cleanup();
  const submitted = structuredClone(withPhoto);
  submitted.report.status = "submitted"; submitted.report.revision = 4;
  const acknowledged = structuredClone(submitted); acknowledged.report.revision = 5;
  acknowledged.report.document.residentAcknowledgment = { userId: "resident", at: "2026-09-05T11:00:00Z" };
  request.mockResolvedValueOnce(acknowledged);
  render(<InspectionEditor initial={submitted} role="resident" userId="resident" onBack={() => {}} onChanged={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Confirm review" }));
  const dialog = await screen.findByRole("dialog");
  expect(dialog.textContent).toContain("not agreement with charges");
  await act(async () => { fireEvent.click(dialog.querySelector("[data-attr='inspection-confirm']")!); });
  expect(JSON.parse(request.mock.calls.at(-1)![2].body)).toEqual({ revision: 4, action: "acknowledge" });
  expect(screen.queryByRole("button", { name: "Confirm review" })).toBeNull();
  vi.unstubAllGlobals();
});

it("manager: approves only once the resident has acknowledged, and a completed report is locked", async () => {
  const report = roomReport({ status: "submitted", revision: 5 });
  report.document.areas[0]!.items[0]!.resident.notes = "Small scuff to the left of the door frame.";
  report.document.areas[0]!.items[0]!.resident.photos.push({
    id: "photo-1", path: "private/room-3.jpg", url: PHOTO_URL, uploadedBy: "resident", uploadedAt: "2026-09-05T10:00:00Z",
  });
  report.document.residentAcknowledgment = { userId: "resident", at: "2026-09-05T11:00:00Z", revision: 4 };
  report.document.history = [
    { at: "2026-09-05T09:00:00Z", role: "manager", action: "created" },
    { at: "2026-09-05T10:30:00Z", role: "resident", action: "submitted" },
    { at: "2026-09-05T11:00:00Z", role: "resident", action: "acknowledged" },
  ];
  const detail: InspectionDetail = { report, baseline: null, canEdit: true };
  render(<InspectionEditor initial={detail} role="manager" userId="owner" onBack={vi.fn()} onChanged={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: /Room overview/ }));
  // The manager reads the resident's observations separately from their own.
  expect(screen.getByText("Resident observations")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Approve inspection" }) as HTMLButtonElement).disabled).toBe(false);
  writeEvidenceSurface("inspection-06-manager-review", "Manager · submitted report — resident observations shown separately, Request changes + Approve inspection pinned. Approve is enabled only because the resident acknowledged.", 150);

  const completed = structuredClone(detail);
  completed.report.status = "completed"; completed.report.revision = 6;
  request.mockResolvedValueOnce(completed);
  fireEvent.click(screen.getByRole("button", { name: "Approve inspection" }));
  await screen.findByRole("dialog");
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Approve inspection", selector: "[data-attr='inspection-confirm']" })); });
  expect(screen.getByText("Completed")).toBeTruthy();
  // A completed report is immutable: no editing, no submit, no approve.
  for (const gone of ["Upload photos", "Submit for review", "Approve inspection", "Request changes"]) {
    expect(screen.queryByRole("button", { name: gone })).toBeNull();
  }
  writeEvidenceSurface("inspection-07-completed-locked", "Manager · completed report is permanently locked — read-only observations, no upload/submit/approve controls remain.", 150);
});

it("move-out: the move-in baseline stays readable beside the new observations", async () => {
  const baseline = roomReport({ id: "baseline-id", status: "completed", inspection_date: "2026-03-01" });
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
  fireEvent.click(screen.getByRole("button", { name: /Room overview/ }));
  // Same residency / property / manager / room, with the move-in report as baseline.
  expect(screen.getByText(/Move-in photos and notes · 2026-03-01/)).toBeTruthy();
  fireEvent.click(screen.getByText(/Move-in photos and notes · 2026-03-01/));
  expect(screen.getByText("Wall was clean at move-in.")).toBeTruthy();
  writeEvidenceSurface("inspection-08-move-out-baseline", "Resident · move-out on the same room — the completed move-in report is the baseline, readable inline beside the new observations.", 150);
});
