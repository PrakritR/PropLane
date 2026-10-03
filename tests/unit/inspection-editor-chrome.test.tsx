// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reportFixture } from "../helpers/inspection-fixture";
import { createRoomInspectionDocument } from "@/lib/inspections/room-template";
import { InspectionEditor } from "@/components/portal/inspection-editor";

vi.mock("@/lib/inspections/client", () => ({ downloadInspection: vi.fn(), inspectionRequest: vi.fn() }));
vi.mock("@/lib/native/use-native-camera", () => ({ useNativeCamera: () => ({ capture: vi.fn() }) }));

afterEach(cleanup);

const detail = {
  report: reportFixture({
    resident_name: "Shivansh",
    document: createRoomInspectionDocument({
      assignment: "home::a",
      label: "Room A",
      furnished: false,
      privateBathroom: false,
    }),
  }),
  baseline: null,
  canEdit: true,
};

describe("InspectionEditor chrome", () => {
  it("has no section checkboxes, row cameras, or footer", () => {
    render(<InspectionEditor initial={detail} role="manager" userId="mgr" onBack={vi.fn()} onChanged={vi.fn()} />);
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /^Add photos to / })).toBeNull();
    expect(screen.getByRole("button", { name: "Add photos" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download PDF" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Actions for Room overview" })).toBeTruthy();
    // C137: Export opens the real print-styled report — a same-tab download is a
    // different artifact, so this is its own header icon, not a Download PDF variant.
    expect(screen.getByRole("button", { name: "Export" })).toBeTruthy();
  });

  it("Export opens the print-styled report for this report id and role (C137)", async () => {
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    render(<InspectionEditor initial={detail} role="resident" userId="res-1" onBack={vi.fn()} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() =>
      expect(openSpy).toHaveBeenCalledWith(
        `/print/inspection/${detail.report.id}?portal=resident`,
        "_blank",
        "noopener,noreferrer",
      ),
    );
    openSpy.mockRestore();
  });

  it("drops the inner identity when embedded in the record page", () => {
    render(
      <InspectionEditor
        embedded
        initial={detail}
        role="manager"
        userId="mgr"
        onBack={vi.fn()}
        onChanged={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Back to inspections" })).toBeNull();
    expect(screen.getByRole("button", { name: "Add photos" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Actions for Room overview" })).toBeTruthy();
  });

  it("does not render a page footer", () => {
    const src = readFileSync(join(process.cwd(), "src/components/portal/inspection-editor.tsx"), "utf8");
    expect(src).not.toContain("PortalPageFooterActions");
    expect(src).not.toContain("type=\"checkbox\"");
  });
});
