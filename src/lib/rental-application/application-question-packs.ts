/**
 * Ready-made question bundles a manager can add to a property's rental
 * application in one click from the ADD flow, instead of authoring each
 * question by hand.
 *
 * Each pack holds question TEMPLATES only (no `id`/`key` — those are minted
 * per property, against that property's already-taken keys, when the manager
 * adds the pack via {@link buildQuestionsFromPack}).
 */

import {
  customApplicationFieldKeyFromLabel,
  mintCustomApplicationFieldId,
  type ManagerCustomApplicationField,
} from "@/lib/manager-listing-submission";
import type { RentalApplicationSectionId } from "@/lib/rental-application/application-sections";

export type ApplicationQuestionPack = {
  id: string;
  label: string;
  /** One short line describing what the pack asks. */
  blurb: string;
  /** Section these questions default into. */
  section: RentalApplicationSectionId;
  /** True for the pack offered pre-selected in the ADD flow. */
  recommended?: boolean;
  /** Question templates — no `id`/`key` yet; those are minted per property on add. */
  questions: ReadonlyArray<
    Omit<ManagerCustomApplicationField, "id" | "key" | "section"> & { section?: RentalApplicationSectionId }
  >;
};

export const APPLICATION_QUESTION_PACKS: readonly ApplicationQuestionPack[] = [
  {
    id: "emergency-contact",
    label: "Emergency contact",
    blurb: "Ask for a contact's name, relationship, phone, and email.",
    section: "additional",
    recommended: true,
    questions: [
      { label: "Emergency contact full name", type: "text", required: true, options: [] },
      { label: "Relationship to applicant", type: "text", required: true, options: [] },
      { label: "Emergency contact phone", type: "phone", required: true, options: [] },
      { label: "Emergency contact email", type: "email", required: false, options: [] },
    ],
  },
  {
    id: "pets",
    label: "Pets",
    blurb: "Ask whether the applicant has a pet, its type, and its weight.",
    section: "additional",
    questions: [
      { label: "Do you have a pet?", type: "yes_no", required: true, options: [] },
      { label: "Pet type and breed", type: "text", required: false, options: [] },
      { label: "Pet weight (lbs)", type: "number", required: false, options: [] },
      {
        label: "Is this a service or emotional-support animal?",
        type: "yes_no",
        required: false,
        options: [],
        description: "These are not pets under fair-housing rules and are not charged pet fees.",
      },
    ],
  },
  {
    id: "vehicles",
    label: "Vehicles",
    blurb: "Ask how many vehicles the applicant will park and their details.",
    section: "additional",
    questions: [
      { label: "Number of vehicles to park", type: "number", required: false, options: [] },
      { label: "Vehicle make, model and year", type: "text", required: false, options: [] },
      { label: "License plate and state", type: "text", required: false, options: [] },
    ],
  },
  {
    id: "smoking-house-rules",
    label: "Smoking & house rules",
    blurb: "Ask about smoking, vaping, and agreement to quiet hours.",
    section: "additional",
    questions: [
      { label: "Does anyone in the household smoke or vape?", type: "yes_no", required: true, options: [] },
      { label: "I agree to the building's quiet hours", type: "checkbox", required: true, options: [] },
      { label: "How did you hear about the property's house rules?", type: "text", required: false, options: [] },
    ],
  },
  {
    id: "roommate-fit",
    label: "Roommate fit",
    blurb: "Ask about schedule, guests, and shared-space chores.",
    section: "household",
    questions: [
      {
        label: "Typical schedule",
        type: "select",
        required: false,
        options: ["Days", "Nights", "Overnight shifts", "Varies"],
      },
      {
        label: "How often do you have overnight guests?",
        type: "select",
        required: false,
        options: ["Rarely", "A few times a month", "Weekly", "Most nights"],
      },
      {
        label: "Comfortable with a shared-space chores rota?",
        type: "yes_no",
        required: false,
        options: [],
      },
    ],
  },
  {
    id: "move-in-timing",
    label: "Move-in timing",
    blurb: "Ask for the earliest move-in date and any scheduling flexibility.",
    section: "property",
    questions: [
      { label: "Earliest move-in date", type: "date", required: true, options: [] },
      { label: "Are you flexible on this date?", type: "yes_no", required: false, options: [] },
      {
        label: "Anything affecting your move-in schedule?",
        type: "long_text",
        required: false,
        options: [],
      },
    ],
  },
  {
    id: "referral-source",
    label: "Referral source",
    blurb: "Ask how the applicant heard about this home.",
    section: "additional",
    questions: [
      {
        label: "How did you hear about this home?",
        type: "select",
        required: false,
        options: ["Zillow", "A friend or current resident", "Walked or drove past", "Social media", "Search engine", "Other"],
      },
      { label: "Details", type: "text", required: false, options: [] },
    ],
  },
];

/**
 * Mint a fresh, codebase-consistent id for a question created from a pack.
 *
 * Mirrors the format of the unexported `rid("caf")` helper in
 * `manager-listing-submission.ts` (`emptyCustomApplicationField` uses it for
 * the same purpose) since that helper is not exported for reuse here.
 */
/** Mint concrete fields for a pack, with keys unique against `takenKeys`. */
export function buildQuestionsFromPack(
  pack: ApplicationQuestionPack,
  takenKeys: Iterable<string>,
): ManagerCustomApplicationField[] {
  const usedKeys = new Set(takenKeys);
  return pack.questions.map((question) => {
    const key = customApplicationFieldKeyFromLabel(question.label, usedKeys);
    usedKeys.add(key);
    return {
      ...question,
      id: mintCustomApplicationFieldId(),
      key,
      section: question.section ?? pack.section,
      options: question.options ?? [],
    };
  });
}
