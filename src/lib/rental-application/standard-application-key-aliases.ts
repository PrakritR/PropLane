/**
 * A built-in application question's `standardKey` is slugged from its LABEL
 * (`application-field-catalog.ts`), so rewording the catalog mints a new key while listings keep
 * storing the old one — in `disabledStandardApplicationKeys`, in saved override rows
 * (`standardKey` / `replacedStandardKey` / the `std-<key>` id) and in `questionDisplayOrder`.
 *
 * Every stored key is read through here, so a reworded question keeps the manager's off switch,
 * relabel, required override and ordering instead of silently reverting to catalog defaults. No
 * imports: both the submission normalizer and the field catalog read it.
 */
const LEGACY_STANDARD_KEY_ALIASES: Record<string, string> = {
  // "Room choices (1st – 3rd)" became "Room" when the wizard dropped to one room choice.
  "property-room-choices-1st-3rd": "property-room",
};

/** The key today's catalog uses for a stored (possibly pre-rename) built-in question key. */
export function canonicalStandardApplicationKey(key: string): string {
  return LEGACY_STANDARD_KEY_ALIASES[key] ?? key;
}

/** The same, for a question row id (`std-<key>`), which display order and override rows carry. */
export function canonicalApplicationQuestionId(id: string): string {
  if (!id.startsWith("std-")) return id;
  return `std-${canonicalStandardApplicationKey(id.slice(4))}`;
}
