import { describe, expect, it } from "vitest";
import { ALL_RECORD_KINDS, recordSections } from "@/lib/portals/record-sections";
import { isPlaceholderRecordActionIcon, recordActionIcon } from "@/lib/portals/record-action-icons";
import { Eye } from "lucide-react";

/** Every id/label a record's header + ⋯ menu can carry, across every section's own action set. */
function everyAction() {
  const seen = new Map<string, { id: string; label: string }>();
  for (const { role, kind } of ALL_RECORD_KINDS) {
    const base = recordSections(role, kind);
    const sectionIds = [undefined, ...base.groups.flatMap((group) => group.items.map((item) => item.id))];
    for (const sectionId of sectionIds) {
      for (const action of recordSections(role, kind, {}, sectionId).headerActions) {
        seen.set(`${action.id}|${action.label}`, { id: action.id, label: action.label });
      }
    }
  }
  return [...seen.values()];
}

describe("record action icons", () => {
  it("every record-sections action resolves to a real icon, never the placeholder dots", () => {
    const placeholders = everyAction().filter(({ id, label }) => isPlaceholderRecordActionIcon(label) && isPlaceholderRecordActionIcon(id));
    expect(placeholders).toEqual([]);
  });

  it("row-menu words that used to fall through now have glyphs", () => {
    for (const label of ["View", "Unlist", "Mark as signed", "Move up", "Move down", "View receipt", "Add receipt", "Edit reply", "Reply with a quick reply"]) {
      expect(isPlaceholderRecordActionIcon(label), label).toBe(false);
    }
    expect(recordActionIcon("View")).toBe(Eye);
  });
});
