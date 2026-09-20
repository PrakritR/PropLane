// A shared space is its own card (PLAN-0920-0631). The Shared spaces step of
// the v2 listing wizard draws no "Default shared space" card, no "This shared
// space only · Reset" tick, no per-row Reset and no "Make all the same", and
// never writes the legacy `sharedSpaceDefaults` block. Rooms and Bathrooms keep
// their Default cards. This reads the source so the card cannot quietly return.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const EDITOR = join(process.cwd(), "src/components/portal/listing-wizard-v2/listing-editor.tsx");
const raw = readFileSync(EDITOR, "utf8");
// Comments explain the code to developers; the rule is about what renders.
const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** The step, from its declaration to the next step's banner. */
function sharedSpacesStep(): string {
  const start = code.indexOf("function StepSharedSpaces(");
  expect(start, "StepSharedSpaces is still the step").toBeGreaterThan(-1);
  const end = code.indexOf("step 4 · rent & fees", start);
  return code.slice(start, end === -1 ? undefined : end);
}

describe("the Shared spaces step has no Default card", () => {
  it("draws no Default shared space card, tick, per-row Reset or Make-all button", () => {
    for (const banned of [
      'title="Default shared space"',
      "Default shared space",
      "listing-v2-space-defaults-card",
      "listing-v2-space-defaults-editor",
      "listing-v2-space-defaults-more",
      "listing-v2-spaces-reset-all",
      "listing-v2-space-same-as-all",
      "Floor for every shared space",
      "to the Default shared space",
      "to every shared space",
    ]) {
      expect(code.includes(banned), `listing-editor.tsx still renders ${banned}`).toBe(false);
    }
  });

  it("never reads or writes the legacy sharedSpaceDefaults block, and inherits nothing", () => {
    const step = sharedSpacesStep();
    expect(step.includes("sharedSpaceDefaults:"), "the step writes sharedSpaceDefaults").toBe(false);
    expect(step.includes("sharedSpaceDefaultsForSubmission"), "the step reads the legacy block").toBe(false);
    for (const banned of ["useOwnFields", "SameAsAllToggle", "CellResetTag", "ResetAllInheritanceButton", "resetAllSharedSpaces", "writeSharedSpaceField", "SHARED_SPACE_DEFAULT_FIELDS"]) {
      expect(step.includes(banned), `the step still uses ${banned}`).toBe(false);
    }
    expect(code.includes("sharedSpaceDefaults:"), "listing-editor.tsx writes sharedSpaceDefaults somewhere").toBe(false);
  });

  it("keeps a space's own rows and starts a new one on the ground floor with Everyone", () => {
    const step = sharedSpacesStep();
    expect(step.includes('dataAttr="listing-v2-space-card"')).toBe(true);
    expect(step.includes('dataAttr="listing-v2-add-space"')).toBe(true);
    expect(step.includes('floorLevelSelectOptions(sub.listingStoriesId, "")[0]')).toBe(true);
    expect(step.includes("roomAccessIds: encodeSharedSpaceEveryone()")).toBe(true);
    expect(step.includes("onDuplicate=")).toBe(true);
    expect(step.includes("onRemove=")).toBe(true);
  });

  it("Rooms and Bathrooms keep their Default cards", () => {
    expect(code.includes('dataAttr="listing-v2-defaults-card"')).toBe(true);
    expect(code.includes('dataAttr="listing-v2-bath-defaults-card"')).toBe(true);
    expect(code.includes('title="Default bathroom"')).toBe(true);
    expect(code.includes("listing-v2-rooms-reset-all")).toBe(true);
    expect(code.includes("listing-v2-bathrooms-reset-all")).toBe(true);
  });
});
