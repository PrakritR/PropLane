// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
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
    expect(screen.queryByRole("button", { name: "Add photos" })).toBeNull();
    expect(screen.getByRole("button", { name: "Actions for Room overview" })).toBeTruthy();
  });

  it("does not render a page footer", () => {
    const src = readFileSync(join(process.cwd(), "src/components/portal/inspection-editor.tsx"), "utf8");
    expect(src).not.toContain("PortalPageFooterActions");
    expect(src).not.toContain("type=\"checkbox\"");
  });
});
