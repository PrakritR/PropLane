// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { reportFixture } from "../helpers/inspection-fixture";
import { createRoomInspectionDocument } from "@/lib/inspections/room-template";
import type { InspectionDetail } from "@/lib/inspections/model";

const { request, capture } = vi.hoisted(() => ({ request: vi.fn(), capture: vi.fn() }));
vi.mock("@/lib/inspections/client", () => ({ downloadInspection: vi.fn(), inspectionRequest: request }));
vi.mock("@/lib/native/use-native-camera", () => ({ useNativeCamera: () => ({ capture }) }));
vi.mock("@/components/ui/modal", () => ({ Modal: ({ open, title, children, footer }: { open: boolean; title: string; children: ReactNode; footer: ReactNode }) => open ? <div role="dialog" aria-label={title}>{children}{footer}</div> : null }));
import { InspectionEditor } from "@/components/portal/inspection-editor";

let detail: InspectionDetail;
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  vi.stubGlobal("URL", Object.assign(URL, { revokeObjectURL: vi.fn() }));
  detail = { report: reportFixture({ document: createRoomInspectionDocument({ assignment: "home::a", label: "Room A", furnished: false, privateBathroom: false }) }), baseline: null, canEdit: true };
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
function mount() {
  render(<InspectionEditor initial={detail} role="resident" userId="resident" onBack={vi.fn()} onChanged={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: /Room overview/ }));
}
async function pause() { await act(async () => { await vi.advanceTimersByTimeAsync(700); }); }
function savedNotes(notes: string) {
  const next = structuredClone(detail); next.report.revision++;
  next.report.document.areas[0]!.items[0]!.resident.notes = notes;
  return next;
}

it("saves after typing pauses and flushes the latest notes into the preview", async () => {
  request.mockResolvedValue(savedNotes("Mark beside the door")); mount();
  const input = screen.getByRole("textbox", { name: "Room overview notes" });
  fireEvent.change(input, { target: { value: "Mark" } });
  await act(async () => { await vi.advanceTimersByTimeAsync(400); });
  fireEvent.change(input, { target: { value: "Mark beside the door" } });
  expect(request).not.toHaveBeenCalled(); await pause();
  expect(request).toHaveBeenCalledTimes(1);
  const body = JSON.parse(request.mock.calls[0]![2].body);
  expect(body.revision).toBe(1); expect(body.observations[0].notes).toBe("Mark beside the door");
  fireEvent.click(screen.getByRole("button", { name: "View document" }));
  expect(screen.getByText("Mark beside the door")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Reload|Refresh|Save changes/ })).toBeNull();
});

it("keeps unsaved notes after a failed save and retries with the original revision", async () => {
  request.mockRejectedValueOnce(new Error("Connection unavailable")).mockResolvedValueOnce(savedNotes("Existing scratch")); mount();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Existing scratch" } }); await pause();
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Existing scratch");
  expect(screen.getByRole("alert").textContent).toContain("unsaved notes remain");
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Retry save" })); });
  expect(request).toHaveBeenCalledTimes(2);
  expect(JSON.parse(request.mock.calls[1]![2].body).revision).toBe(1);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("retains a failed photo upload and retries the same file without asking for another photo", async () => {
  const photo = { previewUrl: "blob:pending-photo", file: new File(["image"], "room.jpg", { type: "image/jpeg" }) };
  capture.mockResolvedValue(photo);
  const next = structuredClone(detail); next.report.revision++;
  next.report.document.areas[0]!.items[0]!.resident.photos.push({ id: "photo", path: "private", uploadedBy: "resident", uploadedAt: "2026-09-05" });
  request.mockRejectedValueOnce(new Error("Upload interrupted")).mockResolvedValueOnce(next); mount();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Upload photos" })); });
  expect(screen.getByAltText("Photo waiting to upload")).toBeTruthy();
  expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Retry upload" })); });
  expect(capture).toHaveBeenCalledTimes(1);
  expect((request.mock.calls[1]![2].body as FormData).get("file")).toBe(photo.file);
  expect(URL.revokeObjectURL).toHaveBeenCalledWith(photo.previewUrl);
  expect(screen.queryByAltText("Photo waiting to upload")).toBeNull();
});

it("submits and acknowledges only after resident confirmation and uses the returned revision", async () => {
  detail.report.document.areas[0]!.items[0]!.resident.notes = "Reviewed photos";
  const submitted = structuredClone(detail); submitted.report.status = "submitted"; submitted.report.revision = 2;
  const acknowledged = structuredClone(submitted); acknowledged.report.revision = 3; acknowledged.report.document.residentAcknowledgment = { userId: "resident", at: "2026-09-05", revision: 2 };
  request.mockResolvedValueOnce(submitted).mockResolvedValueOnce(acknowledged); mount();
  fireEvent.click(screen.getByRole("button", { name: "Submit for review" }));
  expect(request).not.toHaveBeenCalled();
  await act(async () => { fireEvent.click(screen.getByRole("dialog").querySelector("button")!); });
  expect(request.mock.calls.map(call => JSON.parse(call[2].body))).toEqual([{ revision: 1, action: "submit" }, { revision: 2, action: "acknowledge" }]);
  expect(screen.queryByRole("button", { name: "Confirm review" })).toBeNull();
});

it("restores unsaved notes after a history-style unmount without silently overwriting a newer revision", async () => {
  mount();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Unsaved observation" } });
  cleanup(); // Browser/native back unmounts the workspace before its typing pause.
  detail.report.revision = 2;
  mount();
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Unsaved observation");
  expect(screen.getByRole("alert").textContent).toContain("saved report has changed");
  await pause(); expect(request).not.toHaveBeenCalled();
  request.mockResolvedValue(detail);
  fireEvent.click(screen.getByRole("button", { name: "Review latest", exact: true }));
  await act(async () => { fireEvent.click(screen.getByRole("dialog").querySelector("button")!); });
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
});

it("keeps the same photo across a conflict refresh and retries with the fresh revision", async () => {
  const photo = { previewUrl: "blob:conflict-photo", file: new File(["image"], "room.jpg", { type: "image/jpeg" }) };
  capture.mockResolvedValue(photo);
  const current = structuredClone(detail); current.report.revision = 2;
  const uploaded = structuredClone(current); uploaded.report.revision = 3;
  request.mockRejectedValueOnce(new Error("Someone updated this report")).mockResolvedValueOnce(current).mockResolvedValueOnce(uploaded); mount();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Upload photos" })); });
  fireEvent.click(screen.getByRole("button", { name: "Review latest", exact: true }));
  await act(async () => { fireEvent.click(screen.getByRole("dialog").querySelector("button")!); });
  expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Retry upload" })); });
  const body = request.mock.calls[2]![2].body as FormData;
  expect(body.get("revision")).toBe("2"); expect(body.get("file")).toBe(photo.file);
  expect(capture).toHaveBeenCalledTimes(1);
});
