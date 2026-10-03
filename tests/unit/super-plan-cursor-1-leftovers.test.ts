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

  it("bathroom card: who uses it is the Room / Rooms dropdown link on the main card", () => {
    // C2-RE5: the bathroom editor mirrors the room (Type Private/Shared, Location, Room or Rooms),
    // so the old "Who uses it" row is the shared mirror-fields dropdown, not a bespoke row.
    const editor = src("src/components/portal/listing-wizard-v2/listing-editor.tsx");
    const mirror = src("src/components/portal/listing-room-editor/bathroom-editor-mirror-fields.tsx");
    expect(editor).toContain("<BathroomEditorMirrorFields");
    expect(mirror).toContain('<FactRow label="Room">');
    expect(mirror).toContain('<FactRow label="Rooms">');
    expect(editor).not.toContain("Doesn't use it");
    expect(mirror).not.toContain("Doesn't use it");
  });
});
