import type { UploadedLeaseParse } from "@/lib/uploaded-lease-extraction";

export type ResidentDocumentKind = "application" | "lease";

export type ParsedFieldConfidence = "high" | "medium" | "low";

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
