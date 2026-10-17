/**
 * Source guard for the Oct 16 UI sweep (P9/P10): sentences removed from pop-ups
 * and settings stay removed, a pick stays a dropdown, and the Add tour steps
 * stay short enough to be labeled tabs on a phone (never the unlabeled step dropdown).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { phoneStripFits } from "@/components/ui/phone-strip-picker";
import { SCHEDULE_TOUR_STEP_LABELS } from "@/components/portal/schedule-tour-simple-modal";
import { tourNoticeUnitLabel } from "@/lib/tour-notice-labels";

const PORTAL = join(__dirname, "..", "..", "src", "components", "portal");
const read = (name: string) => readFileSync(join(PORTAL, name), "utf8");

describe("UI sweep 1016: no subtext", () => {
  it("Dashboard Customize draws a label and a switch per section, nothing else", () => {
    const source = read("dashboard-customize-modal.tsx");
    expect(source).not.toMatch(/Choose which sections/);
    expect(source).not.toMatch(/description/);
    expect(source).not.toMatch(/text-xs text-muted/);
  });

  it("Export my data is the two password fields; the explanation paragraphs are gone", () => {
    const source = read("portal-data-export-button.tsx");
    expect(source).not.toMatch(/You&apos;ll get one file/);
    expect(source).not.toMatch(/never included/);
    expect(source).not.toMatch(/store it somewhere safe/);
    expect(source).not.toMatch(/at least \{EXPORT_PASSWORD_MIN_LENGTH\}/);
  });

  it("the AI info editor preview carries no standing placeholder sentence", () => {
    expect(read("property-ai-info-editor-modal.tsx")).not.toMatch(/I do not have that yet/);
  });

  it("the Add booking resident pick is plain 'No one', not an instruction", () => {
    expect(read("bookings-block-dates-modal.tsx")).not.toMatch(/just close the room/);
  });

  it("Notice required has no caption under the number and the unit sits inside the stepper", () => {
    const source = read("pro-portal-settings-panels.tsx");
    expect(source).not.toMatch(/text-\[10px\][^\n]*tourNoticeDaysLabel/);
    expect(source).toMatch(/tourNoticeUnitLabel\(value\)/);
    expect(tourNoticeUnitLabel(0)).toBe("days");
    expect(tourNoticeUnitLabel(1)).toBe("day");
    expect(tourNoticeUnitLabel(7)).toBe("days");
  });

  it("Settings -> Automations select cells are wide enough for the longest reminder timing", () => {
    const source = read("automations-settings-sections.tsx");
    expect(source).not.toMatch(/wrapperClassName="w-72"/);
  });
});

describe("UI sweep 1016: picks are dropdowns", () => {
  it("Tasks filter Priority is a collapsible dropdown section, never chips", () => {
    const source = read("pro-task-filter-fields.tsx");
    expect(source).not.toMatch(/FilterChipsField/);
    const start = source.indexOf("function TaskPriorityFilterField");
    expect(source.slice(start, source.indexOf("export function ManagerTaskFilterFields"))).toMatch(
      /FilterCollapsibleSection[\s\S]*FilterSingleSelectList/,
    );
  });
});

describe("UI sweep 1016: Add tour steps stay labeled tabs on a phone", () => {
  it("fits one phone strip even when every step carries a glyph", () => {
    const tabs = SCHEDULE_TOUR_STEP_LABELS.map((label) => ({ label, glyphs: 1 }));
    expect(phoneStripFits(tabs)).toBe(true);
  });
});
