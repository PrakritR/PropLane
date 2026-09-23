import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/rental-application/data", () => ({
  getRoomOptionsForProperty: (propertyId: string) =>
    propertyId === "house-1" ? [{ value: "house-1::open", label: "Open room · $900/mo" }] : [],
  getRoomChoiceLabel: (value: string) => {
    if (value === "house-1::open") return "Open room · $900/mo";
    if (value === "house-1::full") return "Occupied room · $900/mo";
    return value;
  },
}));

import { emptyRoomsForManagerService, roomLabelForManagerService } from "@/lib/manager-add-service-where";

describe("emptyRoomsForManagerService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists only empty rooms, by room name", () => {
    expect(emptyRoomsForManagerService("house-1")).toEqual([{ value: "house-1::open", label: "Open room" }]);
    expect(emptyRoomsForManagerService("vacant")).toEqual([]);
  });

  it("keeps the resident's current room even when it is full", () => {
    expect(emptyRoomsForManagerService("house-1", "house-1::full")).toEqual([
      { value: "house-1::full", label: "Occupied room" },
      { value: "house-1::open", label: "Open room" },
    ]);
  });

  it("names a saved room choice without rent copy", () => {
    expect(roomLabelForManagerService("house-1::open")).toBe("Open room");
    expect(roomLabelForManagerService("")).toBe("");
  });
});

describe("Add service Where is property-only", () => {
  it("continues without a resident and offers Room", () => {
    const src = readFileSync(join(process.cwd(), "src/components/portal/pro-add-service-modal.tsx"), "utf8");
    expect(src).toContain('const whereIncomplete = !selectedProperty');
    expect(src).toContain('label="Room"');
    expect(src).toContain("emptyRoomsForManagerService");
    expect(src).toContain("buildManagerPropertyFilterOptions");
    expect(src).not.toMatch(/if \(!residentEmail \|\| !selectedResident\)/);
  });
});
