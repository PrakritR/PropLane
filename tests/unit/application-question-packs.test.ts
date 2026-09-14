import { describe, expect, it } from "vitest";

import {
  CUSTOM_APPLICATION_FIELD_TYPES,
  emptyCustomApplicationField,
  normalizeCustomApplicationFields,
  normalizeCustomApplicationFieldsForEditor,
} from "@/lib/manager-listing-submission";
import {
  APPLICATION_QUESTION_PACKS,
  buildQuestionsFromPack,
} from "@/lib/rental-application/application-question-packs";

const VALID_TYPES = new Set<string>(CUSTOM_APPLICATION_FIELD_TYPES);

describe("application-question-packs", () => {
  it("only uses valid, non-retired question types", () => {
    for (const pack of APPLICATION_QUESTION_PACKS) {
      for (const question of pack.questions) {
        expect(VALID_TYPES.has(question.type)).toBe(true);
        expect(question.type).not.toBe("photos");
      }
    }
  });

  it("gives every select question a non-empty options array", () => {
    for (const pack of APPLICATION_QUESTION_PACKS) {
      for (const question of pack.questions) {
        if (question.type === "select") {
          expect(question.options.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("marks exactly one pack recommended, and it is emergency-contact", () => {
    const recommended = APPLICATION_QUESTION_PACKS.filter((p) => p.recommended === true);
    expect(recommended).toHaveLength(1);
    expect(recommended[0]?.id).toBe("emergency-contact");
  });

  it("has all seven packs in the specified order", () => {
    expect(APPLICATION_QUESTION_PACKS.map((p) => p.id)).toEqual([
      "emergency-contact",
      "pets",
      "vehicles",
      "smoking-house-rules",
      "roommate-fit",
      "move-in-timing",
      "referral-source",
    ]);
  });

  it("mints unique keys within a single pack build", () => {
    const pack = APPLICATION_QUESTION_PACKS.find((p) => p.id === "pets")!;
    const built = buildQuestionsFromPack(pack, []);
    const keys = built.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(built.every((f) => f.id)).toBe(true);
  });

  it("mints unique keys across two builds of the same pack against accumulated taken keys", () => {
    const pack = APPLICATION_QUESTION_PACKS.find((p) => p.id === "emergency-contact")!;
    const takenKeys = new Set<string>();
    const first = buildQuestionsFromPack(pack, takenKeys);
    for (const field of first) takenKeys.add(field.key);
    const second = buildQuestionsFromPack(pack, takenKeys);

    const allKeys = [...first.map((f) => f.key), ...second.map((f) => f.key)];
    expect(new Set(allKeys).size).toBe(allKeys.length);
    // Also confirm ids differ between the two batches.
    const allIds = [...first.map((f) => f.id), ...second.map((f) => f.id)];
    expect(new Set(allIds).size).toBe(allIds.length);
  });

  it("does not mutate the takenKeys iterable passed in", () => {
    const pack = APPLICATION_QUESTION_PACKS.find((p) => p.id === "vehicles")!;
    const takenKeys = new Set<string>(["number-of-vehicles-to-park"]);
    const snapshotBefore = [...takenKeys];
    buildQuestionsFromPack(pack, takenKeys);
    expect([...takenKeys]).toEqual(snapshotBefore);
  });

  it("falls back to the pack's section when a question does not set its own", () => {
    for (const pack of APPLICATION_QUESTION_PACKS) {
      const built = buildQuestionsFromPack(pack, []);
      for (const field of built) {
        expect(field.section).toBe(pack.section);
      }
    }
  });

  it("gives every non-option question an empty options array", () => {
    for (const pack of APPLICATION_QUESTION_PACKS) {
      const built = buildQuestionsFromPack(pack, []);
      for (const field of built) {
        if (field.type !== "select" && field.type !== "multi_select") {
          expect(field.options).toEqual([]);
        }
      }
    }
  });

  it("survives a round trip through normalizeCustomApplicationFields for every pack, with no question dropped or re-typed", () => {
    for (const pack of APPLICATION_QUESTION_PACKS) {
      const built = buildQuestionsFromPack(pack, []);
      const normalized = normalizeCustomApplicationFields(built);

      expect(normalized).toHaveLength(built.length);
      const normalizedByKey = new Map(normalized.map((f) => [f.key, f]));
      for (const field of built) {
        const match = normalizedByKey.get(field.key);
        expect(match, `expected ${pack.id} question "${field.label}" to survive normalization`).toBeTruthy();
        expect(match?.type).toBe(field.type);
        expect(match?.label).toBe(field.label);
        expect(match?.required).toBe(field.required);
        expect(match?.section).toBe(field.section);
        expect(match?.options).toEqual(field.options);
      }
    }
  });

  it("builds unique keys and ids across all seven packs minted together for one property", () => {
    const takenKeys = new Set<string>();
    const allFields: ReturnType<typeof buildQuestionsFromPack> = [];
    for (const pack of APPLICATION_QUESTION_PACKS) {
      const built = buildQuestionsFromPack(pack, takenKeys);
      for (const field of built) takenKeys.add(field.key);
      allFields.push(...built);
    }
    expect(new Set(allFields.map((f) => f.key)).size).toBe(allFields.length);
    expect(new Set(allFields.map((f) => f.id)).size).toBe(allFields.length);

    const normalized = normalizeCustomApplicationFields(allFields);
    expect(normalized).toHaveLength(allFields.length);
  });

  // A pack question and a hand-added question must never be able to share an id.
  // Both are minted from ONE counter for exactly this reason: a second module
  // reproducing the `caf-<ms>-<n>` format with its own counter collides inside a
  // single millisecond, and a question's id is both its React key and the handle
  // used to patch or remove it — so a collision silently edits the wrong question.
  it("never mints a pack question id that collides with a hand-added question", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      for (const field of buildQuestionsFromPack(APPLICATION_QUESTION_PACKS[0]!, [])) {
        ids.add(field.id);
      }
      ids.add(emptyCustomApplicationField("additional").id);
    }
    const minted = 200 * (buildQuestionsFromPack(APPLICATION_QUESTION_PACKS[0]!, []).length + 1);
    expect(ids.size).toBe(minted);
  });
});

// The question editor deliberately KEEPS a blank option row while a manager is
// typing into it (it would otherwise vanish on the first keystroke). That
// leniency must not reach stored data: a blank option is dropped again on the
// way in, so a saved multi-select can never carry an empty choice.
describe("blank option rows never reach stored data", () => {
  it("drops blank options on the strict normalize even if one is present", () => {
    const withBlank = [
      {
        id: "caf-1",
        key: "shift",
        label: "Typical schedule",
        type: "multi_select",
        required: false,
        options: ["Days", "", "   ", "Nights"],
        section: "household",
      },
    ];
    const strict = normalizeCustomApplicationFields(withBlank);
    expect(strict).toHaveLength(1);
    expect(strict[0]!.options).toEqual(["Days", "Nights"]);

    const editor = normalizeCustomApplicationFieldsForEditor(withBlank);
    expect(editor[0]!.options).toEqual(["Days", "", "   ", "Nights"]);
  });
});
