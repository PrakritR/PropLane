import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const inspections = readFileSync("src/components/portal/inspections-panel.tsx", "utf8");

describe("Inspections list has no photographed-room caption", () => {
  it("does not render a muted progress sentence under the tabs", () => {
    expect(inspections).not.toContain("inspection-resident-progress");
    expect(inspections).not.toContain("photographed their room");
    expect(inspections).not.toContain("reminded automatically around their move date");
  });
});
