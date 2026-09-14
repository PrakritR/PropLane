import { describe, expect, it } from "vitest";
import {
  normalizeCustomApplicationFields,
  type ManagerCustomApplicationField,
} from "@/lib/manager-listing-submission";
import {
  canMoveCustomApplicationField,
  customQuestionsInSection,
  moveCustomApplicationField,
  moveCustomApplicationFieldToSection,
  type ApplicationConfigSlice,
} from "@/lib/rental-application/application-field-catalog";

type RawCustomField = {
  id: string;
  label: string;
  type?: ManagerCustomApplicationField["type"];
  required?: boolean;
  options?: string[];
  section?: string;
  standardKey?: string;
};

function raw(field: RawCustomField): Record<string, unknown> {
  return {
    id: field.id,
    key: field.id,
    label: field.label,
    type: field.type ?? "text",
    required: field.required ?? false,
    options: field.options ?? [],
    section: field.section,
    standardKey: field.standardKey,
  };
}

function buildSlice(fields: RawCustomField[]): ApplicationConfigSlice {
  return {
    disabledStandardApplicationKeys: ["some-standard-key"],
    customApplicationFields: normalizeCustomApplicationFields(fields.map(raw)),
    applicationConfigMode: "custom",
  };
}

const norm = normalizeCustomApplicationFields;

function ids(fields: readonly ManagerCustomApplicationField[]): string[] {
  return fields.map((f) => f.id);
}

describe("application-question-reorder", () => {
  it("moving down then up returns the original order (round trip)", () => {
    const slice = buildSlice([
      { id: "a", label: "A", section: "household" },
      { id: "b", label: "B", section: "household" },
    ]);
    const original = slice.customApplicationFields;

    const down = moveCustomApplicationField(slice, "a", "down", norm);
    expect(ids(down.customApplicationFields)).toEqual(["b", "a"]);

    const up = moveCustomApplicationField(down, "a", "up", norm);
    expect(ids(up.customApplicationFields)).toEqual(ids(original));
    expect(up.customApplicationFields).toEqual(original);
  });

  it("a question first in its section cannot move up, last cannot move down (no-ops)", () => {
    const slice = buildSlice([
      { id: "a", label: "A", section: "household" },
      { id: "b", label: "B", section: "household" },
    ]);

    expect(canMoveCustomApplicationField(slice, "a", "up", norm)).toBe(false);
    expect(canMoveCustomApplicationField(slice, "b", "down", norm)).toBe(false);

    const afterA = moveCustomApplicationField(slice, "a", "up", norm);
    expect(ids(afterA.customApplicationFields)).toEqual(["a", "b"]);
    expect(afterA.customApplicationFields).toEqual(slice.customApplicationFields);

    const afterB = moveCustomApplicationField(slice, "b", "down", norm);
    expect(ids(afterB.customApplicationFields)).toEqual(["a", "b"]);
    expect(afterB.customApplicationFields).toEqual(slice.customApplicationFields);
  });

  it("moves within a section across interleaved array positions, leaving the other section's row untouched", () => {
    // Flat array order: A(household), B(additional), C(household).
    // "down" on A must swap it with C (the next HOUSEHOLD question), never with B.
    const slice = buildSlice([
      { id: "a", label: "A", section: "household" },
      { id: "b", label: "B", section: "additional" },
      { id: "c", label: "C", section: "household" },
    ]);

    expect(canMoveCustomApplicationField(slice, "a", "down", norm)).toBe(true);
    const moved = moveCustomApplicationField(slice, "a", "down", norm);

    expect(ids(moved.customApplicationFields)).toEqual(["c", "b", "a"]);
    // B's array position (index 1) and content are unchanged.
    expect(moved.customApplicationFields[1]).toEqual(slice.customApplicationFields[1]);
    expect(moved.customApplicationFields[1]?.id).toBe("b");
  });

  it("a built-in question id and an unknown id are both no-ops, and canMove is false for both", () => {
    const slice = buildSlice([
      { id: "override-1", label: "Override", section: "additional", standardKey: "personal-full-legal-name" },
      { id: "a", label: "A", section: "additional" },
      { id: "b", label: "B", section: "additional" },
    ]);
    const original = slice.customApplicationFields;

    expect(canMoveCustomApplicationField(slice, "override-1", "up", norm)).toBe(false);
    expect(canMoveCustomApplicationField(slice, "override-1", "down", norm)).toBe(false);
    expect(canMoveCustomApplicationField(slice, "does-not-exist", "up", norm)).toBe(false);
    expect(canMoveCustomApplicationField(slice, "does-not-exist", "down", norm)).toBe(false);

    const movedStandard = moveCustomApplicationField(slice, "override-1", "down", norm);
    expect(movedStandard.customApplicationFields).toEqual(original);

    const movedUnknown = moveCustomApplicationField(slice, "does-not-exist", "up", norm);
    expect(movedUnknown.customApplicationFields).toEqual(original);

    const movedToSectionStandard = moveCustomApplicationFieldToSection(slice, "override-1", "household", norm);
    expect(movedToSectionStandard.customApplicationFields).toEqual(original);

    const movedToSectionUnknown = moveCustomApplicationFieldToSection(slice, "does-not-exist", "household", norm);
    expect(movedToSectionUnknown.customApplicationFields).toEqual(original);
  });

  it("moves a question into another section, appending at that section's end and preserving existing order there", () => {
    const slice = buildSlice([
      { id: "h1", label: "H1", section: "household" },
      { id: "h2", label: "H2", section: "household" },
      { id: "x1", label: "X1", section: "additional" },
    ]);

    const result = moveCustomApplicationFieldToSection(slice, "h1", "additional", norm);

    const moved = result.customApplicationFields.find((f) => f.id === "h1");
    expect(moved?.section).toBe("additional");

    expect(ids(customQuestionsInSection(result, "household", norm))).toEqual(["h2"]);
    // X1's existing position/order is unchanged; h1 is appended after it.
    expect(ids(customQuestionsInSection(result, "additional", norm))).toEqual(["x1", "h1"]);
  });

  it("moving to the current section, or to an unknown section, is a no-op", () => {
    const slice = buildSlice([
      { id: "h1", label: "H1", section: "household" },
      { id: "x1", label: "X1", section: "additional" },
    ]);
    const original = slice.customApplicationFields;

    const sameSection = moveCustomApplicationFieldToSection(slice, "h1", "household", norm);
    expect(sameSection.customApplicationFields).toEqual(original);

    const unknownSection = moveCustomApplicationFieldToSection(slice, "h1", "not-a-real-section", norm);
    expect(unknownSection.customApplicationFields).toEqual(original);
  });

  it("never mutates the input slice or its custom-fields array", () => {
    const slice = buildSlice([
      { id: "a", label: "A", section: "household" },
      { id: "b", label: "B", section: "additional" },
      { id: "c", label: "C", section: "household" },
    ]);
    const fieldsRef = slice.customApplicationFields;
    const clone = structuredClone(slice);

    moveCustomApplicationField(slice, "a", "down", norm);
    moveCustomApplicationField(slice, "b", "up", norm);
    moveCustomApplicationFieldToSection(slice, "a", "additional", norm);
    canMoveCustomApplicationField(slice, "a", "down", norm);
    customQuestionsInSection(slice, "household", norm);

    expect(slice.customApplicationFields).toBe(fieldsRef);
    expect(slice).toEqual(clone);
  });

  it("preserves every other slice property across every operation", () => {
    const slice = buildSlice([
      { id: "a", label: "A", section: "household" },
      { id: "b", label: "B", section: "additional" },
      { id: "c", label: "C", section: "household" },
    ]);

    for (const result of [
      moveCustomApplicationField(slice, "a", "down", norm),
      moveCustomApplicationField(slice, "does-not-exist", "up", norm),
      moveCustomApplicationFieldToSection(slice, "a", "additional", norm),
      moveCustomApplicationFieldToSection(slice, "a", "household", norm),
    ]) {
      expect(result.disabledStandardApplicationKeys).toEqual(slice.disabledStandardApplicationKeys);
      expect(result.applicationConfigMode).toBe(slice.applicationConfigMode);
    }
  });
});
