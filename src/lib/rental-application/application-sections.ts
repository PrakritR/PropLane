/**
 * Catalog of the standard Axis rental-application sections.
 *
 * Used by the manager create-listing wizard (to show the default application
 * outline and attach custom questions to a section) and by the applicant
 * wizard (to ask each custom question inside its section's step).
 *
 * Keep dependency-free: imported by both `manager-listing-submission` and the
 * rental-application libs.
 */

export type RentalApplicationSectionId =
  | "household"
  | "property"
  | "personal"
  | "current_address"
  | "previous_address"
  | "employment"
  | "references"
  | "additional"
  | "consent"
  | "review";

export type RentalApplicationSection = {
  id: RentalApplicationSectionId;
  title: string;
  /** Applicant rental-wizard step that asks this section's questions. */
  wizardStep: number;
  /** Standard fields the applicant fills in this section (manager-facing outline). */
  standardFields: readonly string[];
};

/**
 * Sections managers can review and extend with custom questions, in applicant
 * order. Household runs before property selection; managers may remove either
 * built-in household question if they do not need it.
 */
export const RENTAL_APPLICATION_SECTIONS: readonly RentalApplicationSection[] = [
  {
    id: "household",
    title: "Household application",
    wizardStep: 1,
    standardFields: ["Group application", "Co-signer planned"],
  },
  {
    id: "property",
    title: "Property information",
    wizardStep: 3,
    standardFields: [
      "Property",
      "Room choices (1st – 3rd)",
      "Lease term",
      "Lease start & end dates",
    ],
  },
  {
    id: "personal",
    title: "Personal information",
    wizardStep: 2,
    standardFields: [
      "Full legal name",
      "Phone",
      "Email",
      "Date of birth",
      "Social Security number",
      "Driver's license / ID",
      "Driver's license / ID — front photo",
      "Driver's license / ID — back photo",
    ],
  },
  {
    id: "current_address",
    title: "Current address",
    wizardStep: 4,
    standardFields: [
      "Street, city, state, ZIP",
      "Current landlord name & phone",
      "Move-in / move-out dates",
      "Reason for leaving",
    ],
  },
  {
    id: "previous_address",
    title: "Previous address",
    wizardStep: 5,
    standardFields: [
      "Street, city, state, ZIP",
      "Previous landlord name & phone",
      "Move-in / move-out dates",
      "Reason for leaving",
    ],
  },
  {
    id: "employment",
    title: "Employment & income",
    wizardStep: 6,
    standardFields: [
      "Employer & employer address",
      "Supervisor name & phone",
      "Job title & employment start",
      "Monthly / annual income",
      "Proof of income (pay stub, etc.)",
      "Other income",
    ],
  },
  {
    id: "references",
    title: "References",
    wizardStep: 7,
    standardFields: [
      "Reference 1 — name, relationship, phone",
      "Reference 2 — name, relationship, phone",
    ],
  },
  {
    id: "additional",
    title: "Additional details",
    wizardStep: 8,
    standardFields: [
      "Number of occupants",
      "Pets",
      "Eviction history",
      "Bankruptcy history",
      "Criminal history",
    ],
  },
  {
    id: "consent",
    title: "Consent & signature",
    wizardStep: 9,
    standardFields: [
      "Credit & background check consent",
      "Truthfulness certification",
      "Digital signature & date",
    ],
  },
  {
    id: "review",
    title: "Review",
    wizardStep: 10,
    standardFields: [],
  },
];

const SECTION_BY_ID = new Map(RENTAL_APPLICATION_SECTIONS.map((s) => [s.id, s]));

export const RENTAL_APPLICATION_SECTION_IDS: ReadonlySet<string> = new Set(SECTION_BY_ID.keys());

/** Section for questions saved without one (legacy manager questions). */
export const DEFAULT_CUSTOM_FIELD_SECTION_ID: RentalApplicationSectionId = "additional";

export function applicationSectionById(id: string | undefined): RentalApplicationSection | undefined {
  return id ? SECTION_BY_ID.get(id as RentalApplicationSectionId) : undefined;
}

/** Applicant wizard step that should ask a custom question with this section tag. */
export function applicationWizardStepForSection(section: string | undefined): number {
  return applicationSectionById(section)?.wizardStep
    ?? SECTION_BY_ID.get(DEFAULT_CUSTOM_FIELD_SECTION_ID)!.wizardStep;
}
