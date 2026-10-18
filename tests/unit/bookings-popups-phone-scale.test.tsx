// @vitest-environment jsdom
/**
 * Bookings pop-ups on a phone (390 x 844, keyboard up): content-sized confirms, the Apple HIG type
 * scale (13px labels, 16px actions, 44px targets), the dates asked before the details, and a sheet
 * that follows the visual viewport while the on-screen keyboard is open.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { ListingWizardOverlay } from "@/components/portal/listing-wizard-v2/wizard-overlay";
import { POPUP_FIELD_LABEL_CLASS, POPUP_FIELD_LINK_CLASS } from "@/components/portal/popup-phone-styles";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("phone type scale", () => {
  it("labels are 13px on a phone and the inline link is a 44px target", () => {
    expect(POPUP_FIELD_LABEL_CLASS).toContain("text-[13px]");
    expect(POPUP_FIELD_LABEL_CLASS).toContain("lg:text-xs");
    expect(POPUP_FIELD_LINK_CLASS).toContain("max-lg:min-h-11");
  });

  it.each([
    "src/components/portal/bookings-block-dates-modal.tsx",
    "src/components/portal/bookings-edit-sheet.tsx",
    "src/components/portal/bookings-guest-name-dialog.tsx",
    "src/components/portal/bookings-stay-details-dialog.tsx",
    "src/components/portal/pro-task-form-modal.tsx",
  ])("%s uses the phone label, not the 12px modal label", (path) => {
    const source = read(path);
    expect(source).toContain("POPUP_FIELD_LABEL_CLASS");
    expect(source).not.toContain("MODAL_FIELD_LABEL_CLASS");
  });

  it("the Add booking footer actions are 16px on a phone and 13.5px on desktop", () => {
    const source = read("src/components/portal/add-workspace/index.tsx");
    expect(source).not.toMatch(/text-\[13\.5px\] font-semibold(?! )/);
    expect(source).toContain("text-[16px] font-semibold lg:text-[13.5px]");
    expect(source).toContain("min-h-[44px] items-center whitespace-nowrap");
  });
});

describe("confirm pop-ups are content-sized bottom sheets on a phone", () => {
  it.each([
    "src/components/portal/bookings-cancel-dialog.tsx",
    "src/components/portal/bookings-delete-block-dialog.tsx",
    "src/components/portal/bookings-remove-stay-dialog.tsx",
    "src/components/portal/bookings-guest-name-dialog.tsx",
  ])("%s does not open full screen", (path) => {
    expect(read(path)).toContain("fullScreenMobile={false}");
  });

  it("the Undo toast spans the phone instead of overflowing it", () => {
    for (const path of ["src/components/portal/bookings-cancel-dialog.tsx", "src/components/portal/bookings-remove-stay-dialog.tsx"]) {
      const source = read(path);
      expect(source).toContain("fixed inset-x-4");
      expect(source).toContain("flex-wrap");
    }
  });
});

describe("Add booking When step", () => {
  it("asks Move in / Move out before the stay details", () => {
    const source = read("src/components/portal/bookings-block-dates-modal.tsx");
    expect(source.indexOf('id="bookings-block-check-in"')).toBeLessThan(source.indexOf('id="booking-stay-source"'));
  });
});

describe("day pop-up header", () => {
  it("has 44px day arrows and a short phone title", () => {
    const source = read("src/components/portal/bookings-day-page.tsx");
    expect(source.match(/h-11 w-11 items-center justify-center rounded-full[^"]*lg:h-9 lg:w-9/g)).toHaveLength(2);
    expect(source).toContain("dayTitleShort");
  });
});

describe("sheet follows the visual viewport while the keyboard is up", () => {
  function stubViewport(height: number) {
    const listeners = new Map<string, () => void>();
    const viewport = {
      height,
      offsetTop: 0,
      addEventListener: (name: string, fn: () => void) => listeners.set(name, fn),
      removeEventListener: (name: string) => listeners.delete(name),
    };
    vi.stubGlobal("visualViewport", viewport);
    Object.defineProperty(window, "visualViewport", { value: viewport, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 844, configurable: true });
    Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
    return { viewport, fire: () => listeners.get("resize")?.() };
  }

  it("pins the sheet to the visible height once the keyboard covers it, and releases it after", () => {
    const { viewport, fire } = stubViewport(844);
    render(<ListingWizardOverlay ariaLabel="Add booking"><div>body</div></ListingWizardOverlay>);
    const dialog = () => document.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog().style.height).toBe("");
    act(() => { viewport.height = 500; fire(); });
    expect(dialog().style.height).toBe("500px");
    act(() => { viewport.height = 844; fire(); });
    expect(dialog().style.height).toBe("");
  });
});
