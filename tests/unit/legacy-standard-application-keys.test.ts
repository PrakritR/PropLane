/**
 * A built-in question's `standardKey` is slugged from its label, so rewording the catalog mints a new
 * key while listings keep storing the old one. "Room choices (1st – 3rd)" became "Room"; a listing that
 * had turned that question OFF, reworded it, made it optional or reordered it must keep all four.
 */
import { describe, expect, it } from "vitest";

import {
  applicationConfigForVariant,
  isWizardFormFieldEnabled,
  resolveListingApplicationFields,
} from "@/lib/rental-application/application-field-catalog";
import {
  canonicalApplicationQuestionId,
  canonicalStandardApplicationKey,
} from "@/lib/rental-application/standard-application-key-aliases";
import { normalizeCustomApplicationFields } from "@/lib/manager-listing-submission";

const LEGACY_ROOM_KEY = "property-room-choices-1st-3rd";

describe("legacy built-in question keys", () => {
  it("maps the stored key and its row id onto today's catalog key", () => {
    expect(canonicalStandardApplicationKey(LEGACY_ROOM_KEY)).toBe("property-room");
    expect(canonicalApplicationQuestionId(`std-${LEGACY_ROOM_KEY}`)).toBe("std-property-room");
    expect(canonicalStandardApplicationKey("property-property")).toBe("property-property");
    expect(canonicalApplicationQuestionId("caf-123")).toBe("caf-123");
  });

  it("keeps a room question the manager removed removed", () => {
    const sub = {
      disabledStandardApplicationKeys: [LEGACY_ROOM_KEY],
      customApplicationFields: [],
      applicationConfigMode: "custom",
    };
    expect(applicationConfigForVariant(sub, "standard").disabledStandardApplicationKeys).toContain("property-room");
    expect(isWizardFormFieldEnabled(sub, "roomChoice1")).toBe(false);
    const fields = resolveListingApplicationFields(sub, normalizeCustomApplicationFields);
    expect(fields.some((field) => field.standardKey === "property-room")).toBe(false);
  });

  it("keeps a stored relabel, required override and display order", () => {
    const sub = {
      disabledStandardApplicationKeys: [],
      customApplicationFields: [
        {
          id: `std-${LEGACY_ROOM_KEY}`,
          key: LEGACY_ROOM_KEY,
          label: "Pick your room",
          type: "select",
          required: false,
          options: [],
          standardKey: LEGACY_ROOM_KEY,
        },
      ],
      questionDisplayOrder: [`std-${LEGACY_ROOM_KEY}`, "std-property-property"],
    };
    const fields = resolveListingApplicationFields(sub, normalizeCustomApplicationFields);
    const room = fields.find((field) => field.standardKey === "property-room");
    expect(room?.label).toBe("Pick your room");
    expect(room?.required).toBe(false);
    expect(fields.findIndex((field) => field.standardKey === "property-room")).toBeLessThan(
      fields.findIndex((field) => field.standardKey === "property-property"),
    );
  });

  it("re-stores the canonical key, so the row heals on the next save", () => {
    const [row] = normalizeCustomApplicationFields([
      {
        id: `std-${LEGACY_ROOM_KEY}`,
        key: LEGACY_ROOM_KEY,
        label: "Room",
        type: "select",
        required: true,
        options: [],
        standardKey: LEGACY_ROOM_KEY,
        replacedStandardKey: LEGACY_ROOM_KEY,
      },
    ]);
    expect(row.standardKey).toBe("property-room");
    expect(row.replacedStandardKey).toBe("property-room");
    expect(row.id).toBe("std-property-room");
  });
});
