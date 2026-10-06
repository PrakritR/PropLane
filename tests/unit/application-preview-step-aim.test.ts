import { describe, expect, it } from "vitest";
import { applicationPreviewGroups, applicationPreviewStepAim } from "@/components/portal/application-form-builder";
import { packPreviewSteps } from "@/components/portal/preview-pager";
import type { RentalApplicationSection } from "@/lib/rental-application/application-sections";
import type { ResolvedApplicationField } from "@/lib/rental-application/application-field-catalog";

const section = (id: string, title: string): RentalApplicationSection =>
  ({ id, title, wizardStep: 1, standardFields: [] }) as RentalApplicationSection;

const field = (
  sectionId: string,
  key: string,
  showIf?: { fieldKey: string; equals: string },
): ResolvedApplicationField =>
  ({
    id: `f-${key}`,
    key,
    label: key,
    type: "text",
    required: false,
    options: [],
    section: sectionId,
    isStandard: false,
    ...(showIf ? { showIf } : {}),
  }) as ResolvedApplicationField;

const sections = [section("household", "Household"), section("personal", "Personal"), section("documents", "Documents")];

/** Six in Household, so Personal cannot join its step; Documents then shares Personal's. */
const fields = [
  ...Array.from({ length: 6 }, (_, i) => field("household", `house-${i + 1}`)),
  field("personal", "person-1"),
  field("documents", "doc-1"),
];

const aim = (over: Partial<Parameters<typeof applicationPreviewStepAim>[0]> = {}) =>
  applicationPreviewStepAim({ sections, fields, answers: {}, focusedSectionId: null, stepPick: null, ...over });

describe("applicationPreviewStepAim", () => {
  it("lands on the step holding the focused section", () => {
    expect(aim({ focusedSectionId: "household" })).toBe(0);
    expect(aim({ focusedSectionId: "personal" })).toBe(1);
    expect(aim({ focusedSectionId: "documents" })).toBe(1);
  });

  it("packs from the SAME live answers the pane does, so a revealed conditional question cannot desync the step", () => {
    // Short form: Household, Personal and Documents all fit one step — until answering the first
    // Household question reveals five more, which fills Household's step and pushes Personal off it.
    const conditional = [
      field("household", "house-1"),
      field("household", "house-2"),
      field("personal", "person-1"),
      field("documents", "doc-1"),
      ...Array.from({ length: 5 }, (_, i) => field("household", `extra-${i + 1}`, { fieldKey: "house-1", equals: "yes" })),
    ];
    const answers = { "house-1": "yes" };

    const hidden = applicationPreviewStepAim({ sections, fields: conditional, answers: {}, focusedSectionId: "personal", stepPick: null });
    const shown = applicationPreviewStepAim({ sections, fields: conditional, answers, focusedSectionId: "personal", stepPick: null });
    expect(hidden).toBe(0);
    expect(shown).toBe(1);

    // The step really does hold Personal once the pane is packed from those same answers.
    const step = packPreviewSteps(applicationPreviewGroups(sections, conditional, answers))[shown];
    expect(step?.some((group) => group.key === "personal")).toBe(true);
  });

  it("keeps an arrow step but clamps it to the steps that still exist", () => {
    expect(aim({ stepPick: 1 })).toBe(1);
    expect(aim({ stepPick: 9 })).toBe(1);
    expect(aim({ stepPick: -3 })).toBe(0);
    // Every question deleted: no steps left, so the pick collapses to 0 instead of pointing past the end.
    expect(applicationPreviewStepAim({ sections, fields: [], answers: {}, focusedSectionId: null, stepPick: 4 })).toBe(0);
  });

  it("falls to the nearest section with questions — forward first, then BACK from an empty last section", () => {
    // Personal empty: the next section that draws something, which is not step 0.
    const forward = [...fields.filter((f) => f.section === "household"), field("documents", "doc-1")];
    expect(applicationPreviewStepAim({ sections, fields: forward, answers: {}, focusedSectionId: "personal", stepPick: null })).toBe(1);

    // Documents — the focused, LAST section — empty: the nearest step behind it, not back to step 0.
    const backward = fields.filter((f) => f.section !== "documents");
    expect(applicationPreviewStepAim({ sections, fields: backward, answers: {}, focusedSectionId: "documents", stepPick: null })).toBe(1);

    // Nothing anywhere: step 0.
    expect(applicationPreviewStepAim({ sections, fields: [], answers: {}, focusedSectionId: "documents", stepPick: null })).toBe(0);
  });
});
