/**
 * How a tour is held: in person at the property, or virtually (video call /
 * live walkthrough). Chosen by whoever schedules the tour — the prospect on the
 * public booking form, the resident in their portal, or the manager in
 * "Schedule tour" — and carried on the inquiry AND the confirmed planned event
 * so every reader (manager Tours list, resident tour panel, emails, SMS) shows
 * the same answer.
 *
 * The value is normalized on the SERVER at every write (`createTourInquiry`,
 * `createManualPlannedTour`, `confirmTourInquiry`): anything that is not
 * exactly `"virtual"` is stored as `"in_person"`, which is also what every
 * row written before this field existed means. Readers therefore never need a
 * fallback of their own — call `normalizeTourFormat` and it is always one of
 * the two.
 */
export type TourFormat = "in_person" | "virtual";

export const DEFAULT_TOUR_FORMAT: TourFormat = "in_person";

export const TOUR_FORMAT_OPTIONS: ReadonlyArray<{ value: TourFormat; label: string; hint: string }> = [
  { value: "in_person", label: "In person", hint: "Meet at the property." },
  { value: "virtual", label: "Virtual", hint: "Video call or live walkthrough." },
];

export function normalizeTourFormat(value: unknown): TourFormat {
  if (typeof value !== "string") return DEFAULT_TOUR_FORMAT;
  const trimmed = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return trimmed === "virtual" ? "virtual" : DEFAULT_TOUR_FORMAT;
}

export function isVirtualTour(value: unknown): boolean {
  return normalizeTourFormat(value) === "virtual";
}

/** Short label for lists, badges and notification lines. */
export function tourFormatLabel(value: unknown): string {
  return normalizeTourFormat(value) === "virtual" ? "Virtual" : "In person";
}

/** Sentence-length label for detail views and email bodies. */
export function tourFormatDescription(value: unknown): string {
  return normalizeTourFormat(value) === "virtual"
    ? "Virtual tour (video call or live walkthrough)"
    : "In-person tour at the property";
}
