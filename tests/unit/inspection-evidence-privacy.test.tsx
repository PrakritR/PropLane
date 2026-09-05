// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { reportFixture } from "../helpers/inspection-fixture";

vi.mock("@/lib/inspections/client", () => ({ downloadInspection: vi.fn(), inspectionRequest: vi.fn() }));
vi.mock("@/lib/native/use-native-camera", () => ({ useNativeCamera: () => ({ capture: vi.fn() }) }));
vi.mock("@/components/ui/modal", () => ({ Modal: () => null }));
import { InspectionEditor } from "@/components/portal/inspection-editor";

afterEach(cleanup);

it.each(["draft", "completed"] as const)("excludes %s evidence and notes from autocapture and session replay", status => {
  const report = reportFixture({ status });
  const baseline = reportFixture({ status: "completed" });
  // Keep one area/item while exercising both parties and the historical baseline.
  for (const record of [report, baseline]) {
    record.document.areas = [record.document.areas[0]!];
    record.document.areas[0]!.items = [record.document.areas[0]!.items[0]!];
    const item = record.document.areas[0]!.items[0]!;
    for (const role of ["manager", "resident"] as const) {
      item[role].notes = `${record === report ? "Current" : "Baseline"} ${role} private notes`;
      item[role].photos = [{ id: `${role}-photo`, path: "private/evidence.jpg", uploadedBy: role,
        uploadedAt: "2026-09-05", url: `https://storage.example.test/evidence.jpg?token=${role}-secret` }];
    }
  }
  const { container } = render(<InspectionEditor initial={{ report, baseline, canEdit: true }} role="manager" userId="manager" onBack={vi.fn()} onChanged={vi.fn()} />);
  for (const link of container.querySelectorAll("a[href*='token=']")) {
    expect(link.closest(".ph-no-capture.ph-no-record")).not.toBeNull();
    expect(link.querySelector("img")?.closest(".ph-no-capture.ph-no-record")).not.toBeNull();
  }
  expect(container.querySelectorAll("a[href*='token=']")).toHaveLength(4);
  for (const notes of ["Current resident private notes", "Baseline manager private notes", "Baseline resident private notes"]) {
    expect(screen.getByText(notes).closest(".ph-no-capture.ph-no-record")).not.toBeNull();
  }
  const ownNotes = status === "draft" ? screen.getByRole("textbox") : screen.getByText("Current manager private notes");
  expect(ownNotes.closest(".ph-no-capture.ph-no-record")).not.toBeNull();
  // Non-sensitive workflow actions remain observable.
  expect(screen.getByRole("button", { name: "Back to inspections" }).closest(".ph-no-capture, .ph-no-record")).toBeNull();
});
