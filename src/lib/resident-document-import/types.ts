import type { UploadedLeaseParse } from "@/lib/uploaded-lease-extraction";

export type ResidentDocumentKind = "application" | "lease";

export type ParsedFieldConfidence = "high" | "medium" | "low";

/**
 * Application-PDF fields the AI pass may return beyond the contact/lease set.
 * Each key is the applicant wizard's own form key (`RentalWizardFormState`),
 * so the Add resident wizard maps them 1:1 into the Application step. SSN is
 * deliberately absent: it is never extracted from a document.
 */
export const APPLICANT_DOCUMENT_FIELD_KEYS = [
  "dateOfBirth",
  "driversLicense",
  "employer",
  "employerAddress",
  "jobTitle",
  "employmentStart",
  "monthlyIncome",
  "annualIncome",
  "otherIncome",
  "supervisorName",
  "supervisorPhone",
  "currentStreet",
  "currentCity",
  "currentState",
  "currentZip",
  "currentLandlordName",
  "currentLandlordPhone",
  "currentMoveIn",
  "currentMoveOut",
  "currentReasonLeaving",
  "prevStreet",
  "prevCity",
  "prevState",
  "prevZip",
  "prevLandlordName",
  "prevLandlordPhone",
  "prevMoveIn",
  "prevMoveOut",
  "prevReasonLeaving",
  "ref1Name",
  "ref1Relationship",
  "ref1Phone",
  "ref2Name",
  "ref2Relationship",
  "ref2Phone",
  "occupancyCount",
  "pets",
  "vehicles",
  "evictionHistory",
  "bankruptcyHistory",
  "criminalHistory",
] as const;

export type ApplicantDocumentFieldKey = (typeof APPLICANT_DOCUMENT_FIELD_KEYS)[number];

export const APPLICANT_DOCUMENT_FIELD_LABELS: Record<ApplicantDocumentFieldKey, string> = {
  dateOfBirth: "Date of birth",
  driversLicense: "Driver's license / ID",
  employer: "Employer",
  employerAddress: "Employer address",
  jobTitle: "Job title",
  employmentStart: "Employed since",
  monthlyIncome: "Monthly income",
  annualIncome: "Annual income",
  otherIncome: "Other income",
  supervisorName: "Supervisor",
  supervisorPhone: "Supervisor phone",
  currentStreet: "Current street",
  currentCity: "Current city",
  currentState: "Current state",
  currentZip: "Current ZIP",
  currentLandlordName: "Current landlord",
  currentLandlordPhone: "Current landlord phone",
  currentMoveIn: "Current address from",
  currentMoveOut: "Current address to",
  currentReasonLeaving: "Reason for leaving",
  prevStreet: "Previous street",
  prevCity: "Previous city",
  prevState: "Previous state",
  prevZip: "Previous ZIP",
  prevLandlordName: "Previous landlord",
  prevLandlordPhone: "Previous landlord phone",
  prevMoveIn: "Previous address from",
  prevMoveOut: "Previous address to",
  prevReasonLeaving: "Previous reason for leaving",
  ref1Name: "Reference 1",
  ref1Relationship: "Reference 1 relationship",
  ref1Phone: "Reference 1 phone",
  ref2Name: "Reference 2",
  ref2Relationship: "Reference 2 relationship",
  ref2Phone: "Reference 2 phone",
  occupancyCount: "Occupants",
  pets: "Pets",
  vehicles: "Vehicles",
  evictionHistory: "Prior eviction",
  bankruptcyHistory: "Bankruptcy",
  criminalHistory: "Criminal history",
};

export type ParsedResidentDocumentField = {
  key: string;
  label: string;
  value: string;
  confidence: ParsedFieldConfidence;
  source: "regex" | "deterministic" | "ai";
};

export type ResidentDocumentMatch =
  | {
      kind: "existing";
      applicationId: string;
      residentName: string;
      residentEmail: string;
    }
  | { kind: "new" };

export type PropertyDocumentMatch = {
  propertyId: string;
  propertyLabel: string;
  roomId?: string;
  roomLabel?: string;
  confidence: ParsedFieldConfidence;
};

export type LeaseSignatureAssessment = {
  managerSigned: boolean;
  residentSigned: boolean;
  fullyExecuted: boolean;
  notes?: string;
};

export type ParsedResidentDocument = {
  kind: ResidentDocumentKind;
  fileName: string;
  extractedCharacterCount: number;
  fields: ParsedResidentDocumentField[];
  residentMatch: ResidentDocumentMatch;
  propertyMatch: PropertyDocumentMatch | null;
  leaseSignatures?: LeaseSignatureAssessment;
  /** Suggested pipeline placement after import. */
  suggestedApplicationBucket: "pending" | "approved";
  suggestedLeaseBucket: "manager" | "resident" | "signed";
  leaseParse?: UploadedLeaseParse | null;
  warnings: string[];
};

export type ResidentDocumentImportReview = {
  kind: ResidentDocumentKind;
  fileName: string;
  dataUrl: string;
  fields: Record<string, string>;
  propertyId: string;
  roomId: string;
  residentMode: "existing" | "new";
  existingApplicationId?: string;
  sendAccountSetup: boolean;
  leaseFullyExecuted: boolean;
};
