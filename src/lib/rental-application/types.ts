import type { ManagerCustomApplicationFieldType } from "@/lib/manager-listing-submission";

export const RENTAL_WIZARD_STEP_COUNT = 11;

export { RENTAL_WIZARD_STEP_SCHEMA } from "./wizard-step-schema";

export type YesNo = "yes" | "no" | null;
export type GroupRole = "first" | "joining" | null;
/** Primary lease applicant vs. co-signer on someone else's application. */
export type ApplicantRole = "signer" | "cosigner" | null;

/**
 * A photo/document an applicant attaches to their application — an image of a
 * driver's license / ID card, or proof of income. The image BYTES live in the
 * PRIVATE `application-documents` Supabase Storage bucket; only this reference
 * (an unguessable object path plus display metadata) is persisted on the
 * application answers. That keeps the reference flowing through the existing
 * autosave/resume path like any other answer WITHOUT inlining base64 into the
 * row_data JSON (which is re-uploaded on every keystroke). Retrieval is always
 * re-authorized per request — only the applicant and the manager who received
 * the application may fetch the bytes (see `/api/portal/application-photos`).
 */
export type ApplicationPhotoAttachment = {
  /** Object path inside the private `application-documents` bucket. */
  storagePath: string;
  /** Original file name (sanitized) for display only. */
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  /** ISO timestamp the object was stored. */
  uploadedAt: string;
};

/** Slots that accept an {@link ApplicationPhotoAttachment}. Used to scope uploads/reads. */
export type ApplicationPhotoSlot = "idFront" | "idBack" | "income";

/**
 * Applicant answer to one manager-defined application question. Label and type are
 * snapshotted at answer time so stored applications stay readable (review + PDF)
 * even if the manager later edits or removes the question on the listing.
 */
export type RentalCustomFieldAnswer = {
  key: string;
  label: string;
  type: ManagerCustomApplicationFieldType;
  /** Raw answer; checkbox answers are "yes" / "" (unchecked). */
  value: string;
};

export type RentalWizardFormState = {
  applicantRole: ApplicantRole;
  applyingAsGroup: YesNo;
  groupRole: GroupRole;
  groupSize: string;
  /** Internal household link code — minted for organizers; resolved from {@link groupLeaderAppId} for joiners. */
  groupId: string;
  /** Organizer application id typed or prefilled from a group invite link (joining members only). */
  groupLeaderAppId: string;
  hasCosigner: YesNo;
  propertyId: string;
  roomChoice1: string;
  roomChoice2: string;
  roomChoice3: string;
  /** Manager-defined lease bundle (ManagerBundleRow.id) the applicant is applying for; replaces ranked room choices when set. */
  bundleId: string;
  rentalType: "standard" | "short_term" | "airbnb";
  shortTermCheckInTime: string;
  shortTermCheckOutTime: string;
  /** Short-term only: the guest acknowledges the host's house rules for the stay. */
  shortTermRulesAck: boolean;
  leaseTerm: string;
  leaseStart: string;
  leaseEnd: string;
  managerRentOverride: string;
  managerUtilitiesOverride: string;
  managerSecurityDepositOverride: string;
  managerMoveInFeeOverride: string;
  managerOtherCostLabel: string;
  managerOtherCostAmount: string;
  fullLegalName: string;
  dateOfBirth: string;
  ssn: string;
  driversLicense: string;
  /**
   * Step 4 — photo of the front / back of the applicant's driver's license or
   * ID card. Optional evidence attached alongside the ID number; gated on the
   * same "Driver's license / ID" question, so a listing that disables that
   * question (and the short-term form by default) never shows or keeps them.
   */
  idPhotoFront: ApplicationPhotoAttachment | null;
  idPhotoBack: ApplicationPhotoAttachment | null;
  phone: string;
  email: string;
  /**
   * A2P 10DLC SMS opt-in. Optional consent (never a precondition for applying)
   * for PropLane to text the applicant about their rental application and
   * account at the phone above. `smsConsentAt` is the compliance timestamp and
   * `smsConsentWordingVersion` names the consent wording shown — both are
   * SERVER-owned: the upsert route stamps them (preserving the first stamp) and
   * clears them when consent is off; any client-supplied values are overwritten.
   * NOT application questions — screening, charges, and the manager review
   * ignore them. Optional on the type so existing snapshots and literal
   * constructions stay valid; the wizard's initial state seeds
   * `smsConsent: false` so the control is unchecked.
   */
  smsConsent?: boolean;
  smsConsentAt?: string;
  smsConsentWordingVersion?: string;
  currentStreet: string;
  currentCity: string;
  currentState: string;
  currentZip: string;
  currentLandlordName: string;
  currentLandlordPhone: string;
  currentMoveIn: string;
  currentMoveOut: string;
  currentReasonLeaving: string;
  noPreviousAddress: boolean;
  prevStreet: string;
  prevCity: string;
  prevState: string;
  prevZip: string;
  prevLandlordName: string;
  prevLandlordPhone: string;
  prevMoveIn: string;
  prevMoveOut: string;
  prevReasonLeaving: string;
  notEmployed: boolean;
  employer: string;
  employerAddress: string;
  supervisorName: string;
  supervisorPhone: string;
  jobTitle: string;
  monthlyIncome: string;
  annualIncome: string;
  employmentStart: string;
  otherIncome: string;
  /**
   * Step 7 — proof-of-income documents (pay stub, offer letter, bank statement).
   * Optional evidence for the self-reported income figures; gated on the income
   * question, so the short-term form (which omits employment) never keeps them.
   * These images can themselves carry sensitive data, so they share the private
   * bucket + per-request authorization used for the ID photos.
   */
  incomeProofPhotos: ApplicationPhotoAttachment[];
  ref1Name: string;
  ref1Relationship: string;
  ref1Phone: string;
  ref2Name: string;
  ref2Relationship: string;
  ref2Phone: string;
  occupancyCount: string;
  pets: string;
  evictionHistory: YesNo;
  evictionDetails: string;
  bankruptcyHistory: YesNo;
  bankruptcyDetails: string;
  criminalHistory: YesNo;
  criminalDetails: string;
  consentCredit: boolean;
  consentTruth: boolean;
  digitalSignature: string;
  dateSigned: string;
  /** Step 12 — non-refundable application processing fee acknowledgement */
  applicationFeeAcknowledged: boolean;
  /**
   * Step 12 — how the applicant will satisfy the listing application fee when the listing offers multiple payment paths.
   * “stripe” uses a Stripe Checkout Session for the application fee.
   */
  applicationFeePayChannel: "ach" | "zelle" | "venmo" | "other" | "stripe";
  /** Step 12 — applicant attests they sent a manual fee payment (manager must still mark the charge paid). */
  applicationFeeZelleSentConfirmed: boolean;
  /** Step 12 — a manager-issued code the applicant entered to waive the application fee. */
  applicationFeeWaiverCode: string;
  /**
   * Step 12 — the waiver code above has been validated AND redeemed server-side
   * (`/api/public/application-fee-waiver`). Once true the applicant owes nothing
   * and Stripe checkout is skipped entirely for this application.
   */
  applicationFeeWaived: boolean;
  /** Step 9 — answers to the listing's manager-defined application questions. */
  customFieldAnswers: RentalCustomFieldAnswer[];
  /**
   * Wizard resume metadata — the step the applicant last reached and the
   * furthest step they unlocked. Persisted with the in-progress application so a
   * full page reload OR a return from an external redirect (e.g. Stripe
   * checkout) resumes exactly where they left off, not back at step 1. NOT an
   * application answer — validation, charges, and the manager view ignore it.
   */
  /** Current wizard step schema; absent rows use legacy 12-step remapping on resume. */
  wizardStepSchema?: number;
  wizardStep?: number;
  wizardMaxStepReached?: number;
};

/** Field and step-level messages (string keys so consent booleans can still surface errors). */
export type RentalWizardErrors = Record<string, string>;
