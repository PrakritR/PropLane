// @vitest-environment jsdom
//
// Captain, Oct 3: the phone step sheet was see-through, sat UNDER the dialog and its footer, and
// had cramped rows. Every phone "jump to section" picker and every select now draws ONE shared
// sheet (ui/phone-bottom-sheet.tsx): opaque, above the dialog stack, 48px rows with a current bar.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FieldSingleSelect, CheckboxMultiSelect } from "@/components/ui/checkbox-multi-select";
import { PortalRecordSectionChrome } from "@/components/portal/portal-record-section-chrome";
import { SettingsSectionPicker } from "@/components/portal/settings-section-picker";
import {
  PHONE_SHEET_BACKDROP_Z_INDEX,
  PHONE_SHEET_Z_INDEX,
  PhoneSectionPicker,
  PhoneSheetGlyph,
} from "@/components/ui/phone-bottom-sheet";
import type { RecordSections } from "@/lib/portals/record-sections";

function mockPhoneMatchMedia() {
  // A touch phone: no fine pointer, narrow window.
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("max-width"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  }));
}

beforeEach(() => mockPhoneMatchMedia());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const STEPS = [
  { id: "a", label: "Home" },
  { id: "b", label: "Recipient", attention: 1 },
  { id: "c", label: "Review" },
];

// The wizard steps are tabs now; the shared sheet is still what the section pickers and every
// phone select draw, so the sheet's own contract is exercised through PhoneSectionPicker.
function StepsPicker() {
  const todo = STEPS.filter((step) => step.attention).length;
  return (
    <PhoneSectionPicker
      title="Steps"
      triggerLabel="Jump to step"
      meta={todo > 0 ? <span>{todo} to finish</span> : null}
      trigger={<span>Recipient</span>}
      groups={[
        {
          items: STEPS.map((step, index) => ({
            id: step.id,
            label: step.label,
            current: index === 1,
            srHint: step.attention ? "Needs something" : undefined,
            glyph: <PhoneSheetGlyph kind={step.attention ? "attention" : index === 1 ? "current" : "todo"} />,
            onSelect: () => {},
          })),
        },
      ]}
    />
  );
}

function openSteps() {
  const view = render(
    <div data-testid="dialog" style={{ position: "fixed", zIndex: 91 }}>
      <StepsPicker />
    </div>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Jump to step" }));
  return view;
}

describe("the shared phone bottom sheet", () => {
  it("renders in a body portal with an opaque surface above the dialog stack", () => {
    const { getByTestId } = openSteps();
    const root = document.querySelector("[data-phone-bottom-sheet]") as HTMLElement;
    expect(root).not.toBeNull();
    expect(getByTestId("dialog").contains(root)).toBe(false);
    expect(root.parentElement).toBe(document.body);
    // The ROOT carries the layer: a popup (z-[80]) paints over a sheet whose root has no z-index.
    expect(Number(root.style.zIndex)).toBe(PHONE_SHEET_BACKDROP_Z_INDEX);
    expect(Number(root.style.zIndex)).toBeGreaterThan(91);
    const panel = root.querySelector("[data-phone-sheet-panel]") as HTMLElement;
    expect(panel.className).toContain("phone-sheet-surface");
    expect(panel.className).toContain("bg-card");
    expect(panel.className).toContain("rounded-t-");
    // The modal panel is z-[91]; the sheet and its backdrop must clear it.
    expect(Number(panel.style.zIndex)).toBe(PHONE_SHEET_Z_INDEX);
    expect(PHONE_SHEET_Z_INDEX).toBeGreaterThan(PHONE_SHEET_BACKDROP_Z_INDEX);
    expect(PHONE_SHEET_BACKDROP_Z_INDEX).toBeGreaterThan(91);
    const backdrop = root.querySelector("[data-phone-sheet-backdrop]") as HTMLElement;
    expect(Number(backdrop.style.zIndex)).toBe(PHONE_SHEET_BACKDROP_Z_INDEX);
    expect(panel.style.maxHeight).toBe("70dvh");
    expect(panel.innerHTML).toContain("safe-area-inset-bottom");
  });

  it("the stylesheet gives the surface an opaque background in both themes", () => {
    const css = readFileSync(join(__dirname, "../../src/app/globals.css"), "utf8");
    expect(css).toMatch(/\.phone-sheet-surface\s*\{[^}]*background-color:\s*#ffffff\s*!important/);
    expect(css).toMatch(/\[data-theme="dark"\]\s*\.phone-sheet-surface\s*\{[^}]*background-color:\s*#111827\s*!important/);
  });

  it("closes when the backdrop is tapped", () => {
    openSteps();
    fireEvent.click(document.querySelector("[data-phone-sheet-backdrop]")!);
    expect(document.querySelector("[data-phone-bottom-sheet]")).toBeNull();
  });

  it("closes on Escape and hands focus back to the trigger", () => {
    openSteps();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.querySelector("[data-phone-bottom-sheet]")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Jump to step" }));
  });

  it("closes from the header close button", () => {
    openSteps();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(document.querySelector("[data-phone-bottom-sheet]")).toBeNull();
  });

  it("marks the current step with aria-current=step, a bar and bold text; shows N to finish", () => {
    openSteps();
    const rows = [...document.querySelectorAll('[data-phone-bottom-sheet] [role="option"]')] as HTMLElement[];
    expect(rows).toHaveLength(3);
    expect(rows[1]!.getAttribute("aria-current")).toBe("step");
    expect(rows[0]!.getAttribute("aria-current")).toBeNull();
    expect(rows[1]!.className).toContain("min-h-12");
    expect(rows[1]!.innerHTML).toContain("bg-primary"); // the blue left bar
    expect(rows[1]!.innerHTML).toContain("font-bold");
    expect(rows[1]!.textContent).not.toContain("Here");
    expect(screen.getByText("1 to finish")).toBeTruthy();
  });

  it("a FieldSingleSelect on a phone opens the same sheet and marks the chosen option", () => {
    const picked: string[] = [];
    render(
      <FieldSingleSelect
        label="Channel"
        value="email"
        onChange={(v) => picked.push(v)}
        options={[
          { value: "email", label: "Email" },
          { value: "sms", label: "Text message to the number on file for this prospect" },
        ]}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Channel" });
    fireEvent.click(trigger);
    const root = document.querySelector("[data-phone-bottom-sheet]") as HTMLElement;
    expect(root).not.toBeNull();
    expect(root.querySelector("[data-phone-sheet-panel]")!.className).toContain("phone-sheet-surface");
    expect(root.querySelector("h2")!.textContent).toBe("Channel");
    const rows = [...root.querySelectorAll('[role="option"]')] as HTMLElement[];
    expect(rows[0]!.getAttribute("aria-selected")).toBe("true");
    expect(rows[0]!.querySelector("svg")).not.toBeNull(); // the check
    expect(rows[1]!.getAttribute("aria-selected")).toBe("false");
    // Long option text wraps instead of truncating.
    expect(rows[1]!.innerHTML).toContain("break-words");
    expect(rows[1]!.innerHTML).not.toContain("truncate");
    // Picking reports the value.
    fireEvent.pointerDown(rows[1]!, { pointerId: 1, clientX: 5, clientY: 5 });
    fireEvent.pointerUp(rows[1]!, { pointerId: 1, clientX: 5, clientY: 5 });
    expect(picked).toEqual(["sms"]);
  });

  it("a CheckboxMultiSelect on a phone opens the same sheet with checked rows", () => {
    render(
      <CheckboxMultiSelect
        label="Notify by"
        selected={["email"]}
        onChange={() => {}}
        options={[
          { value: "email", label: "Email" },
          { value: "sms", label: "Text" },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Notify by" }));
    const rows = [...document.querySelectorAll('[data-phone-bottom-sheet] [role="option"]')] as HTMLElement[];
    expect(rows.map((row) => row.getAttribute("aria-selected"))).toEqual(["true", "false"]);
  });

  it("Escape on a select sheet closes only the sheet", () => {
    render(<FieldSingleSelect label="Channel" value="" onChange={() => {}} options={[{ value: "a", label: "A" }]} />);
    fireEvent.click(screen.getByRole("button", { name: "Channel" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.querySelector("[data-phone-bottom-sheet]")).toBeNull();
  });

  it("a desktop pointer keeps the popover menu for a select", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("pointer: fine"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => true,
    }));
    render(<FieldSingleSelect label="Channel" value="" onChange={() => {}} options={[{ value: "a", label: "A" }]} />);
    fireEvent.click(screen.getByRole("button", { name: "Channel" }));
    expect(document.querySelector("[data-phone-bottom-sheet]")).toBeNull();
    expect(document.querySelector(".field-dropdown-menu")).not.toBeNull();
  });
});

describe("every phone section picker uses the shared sheet", () => {
  const sections: RecordSections = {
    groups: [
      {
        label: "Resident",
        items: [
          { id: "overview", label: "Overview", href: (id: string) => `/portal/residents/${id}` },
          { id: "lease", label: "Lease", href: (id: string) => `/portal/residents/${id}/lease` },
        ],
      },
    ],
    headerActions: [],
  };

  it("the record-page section picker opens the shared sheet with a current-section bar", () => {
    render(
      <PortalRecordSectionChrome
        sections={sections}
        recordId="rec_1"
        activeId="lease"
        title="Jordan Lee"
        backHref="/portal/residents"
        backLabel="All residents"
        ariaLabel="Resident sections"
      >
        <p>body</p>
      </PortalRecordSectionChrome>,
    );
    fireEvent.click(document.querySelector('[data-attr="record-section-picker-toggle"]')!);
    const root = document.querySelector("[data-phone-bottom-sheet]") as HTMLElement;
    expect(root).not.toBeNull();
    expect(root.querySelector("[data-phone-sheet-panel]")!.className).toContain("phone-sheet-surface");
    const lease = root.querySelector('[data-attr="record-section-picker-item-lease"]') as HTMLElement;
    expect(lease.getAttribute("aria-current")).toBe("page");
    expect(lease.className).toContain("min-h-12");
    expect(root.querySelector('[data-attr="record-section-picker-group-Resident"]')?.textContent).toBe("Resident");
  });

  it("the Settings section picker opens the shared sheet and selects a section", () => {
    const picked: string[] = [];
    render(
      <SettingsSectionPicker
        items={[
          { id: "applications", label: "Applications" },
          { id: "tours", label: "Tours" },
        ]}
        activeId="tours"
        onSelect={(id) => picked.push(id)}
      />,
    );
    fireEvent.click(document.querySelector('[data-attr="manager-settings-section-picker-toggle"]')!);
    const root = document.querySelector("[data-phone-bottom-sheet]") as HTMLElement;
    expect(root).not.toBeNull();
    expect(root.querySelector('[data-attr="manager-settings-tab-tours"]')!.getAttribute("aria-current")).toBe("step");
    fireEvent.click(root.querySelector('[data-attr="manager-settings-tab-applications"]')!);
    expect(picked).toEqual(["applications"]);
    expect(document.querySelector("[data-phone-bottom-sheet]")).toBeNull();
  });

  it("the Settings pills stay on a desktop pointer", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("pointer: fine"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => true,
    }));
    render(<SettingsSectionPicker items={[{ id: "tours", label: "Tours" }]} activeId="tours" onSelect={() => {}} />);
    expect(document.querySelector('[data-attr="manager-settings-section-picker-toggle"]')).toBeNull();
    expect(document.querySelector('[data-attr="manager-settings-tab-tours"]')).not.toBeNull();
  });
});
