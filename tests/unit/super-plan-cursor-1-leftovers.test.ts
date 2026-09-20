import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const src = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

describe("cursor-1 Super plan leftovers", () => {
  it("Import always draws the same Add-photos rail cover Basics uses", () => {
    const create = src("src/components/portal/listing-wizard-v2/create-workspace.tsx");
    expect(create).toContain("photoUrl={chrome?.coverUrl ?? null}");
    expect(create).toContain("photoCount={chrome?.photoCount ?? 0}");
  });

  it("empty Pending uses Add applicant, not Send application link", () => {
    const applications = src("src/components/portal/pro-applications.tsx");
    expect(applications).toContain('label: "Add applicant"');
    expect(applications).not.toMatch(/empty[\s\S]{0,400}Send application link/);
  });

  it("room calendar is a labeled Calendar toggle with drag-to-occupy", () => {
    const occupied = src("src/components/portal/listing-wizard-v2/occupied-dates.tsx");
    expect(occupied).toContain("Calendar is a labeled switch");
    expect(occupied).toContain("Drag open days to occupy");
    expect(occupied).toContain("showCalendar");
    expect(occupied).toContain("RoomAvailabilityMonthCalendar");
  });

  it("bathroom Who uses it is a dropdown on the main card", () => {
    const editor = src("src/components/portal/listing-wizard-v2/listing-editor.tsx");
    expect(editor).toContain('label="Who uses it"');
    expect(editor).toContain('dataAttr="listing-v2-bath-who-uses"');
    expect(editor).not.toContain("Doesn't use it");
  });
});
