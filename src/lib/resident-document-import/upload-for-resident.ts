/**
 * "Upload for resident": a filled application or lease PDF for ONE chosen resident.
 *
 * The existing parse pipeline reads the PDF; these helpers turn the chosen resident and the parsed
 * values into the normal form the manager checks, then into the import review the existing commit
 * (`commitResidentDocumentImport`) writes. There is no per-field verification: Create is the
 * confirmation. The chosen resident's identity always wins over what the PDF says, so an upload can
 * never attach itself to a different resident than the one picked.
 */
import type { DemoApplicantRow } from "@/data/demo-portal";
import { LISTING_ROOM_CHOICE_SEP } from "@/lib/rental-application/data";
import { applicantDisplayName } from "@/lib/rental-application/applicant-name";
import {
  APPLICANT_DOCUMENT_FIELD_LABELS,
  APPLICANT_DOCUMENT_FIELD_KEYS,
  type ParsedResidentDocument,
  type ResidentDocumentImportReview,
  type ResidentDocumentKind,
} from "@/lib/resident-document-import/types";

export type UploadResidentOption = {
  /** The application row id this resident is filed under. */
  id: string;
  name: string;
  email: string;
  phone: string;
  propertyId: string;
  roomId: string;
};

export function uploadResidentOptions(rows: readonly DemoApplicantRow[], managerUserId: string | null): UploadResidentOption[] {
  return rows
    .filter((row) => !row.withdrawnAt && row.email?.trim().includes("@"))
    .filter((row) => !managerUserId || !row.managerUserId || row.managerUserId === managerUserId)
    .map((row) => {
      const choice = row.assignedRoomChoice ?? row.application?.roomChoice1 ?? "";
      const [choiceProperty, choiceRoom] = choice.split(LISTING_ROOM_CHOICE_SEP);
      return {
        id: row.id,
        name: applicantDisplayName(row),
        email: row.email!.trim().toLowerCase(),
        phone: row.manualResidentDetails?.phone ?? row.application?.phone ?? "",
        propertyId: row.application?.propertyId || row.assignedPropertyId || choiceProperty || "",
        roomId: choiceRoom ?? "",
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The lease-side fields the Check step shows, in the order the normal Add lease form has them. */
export const UPLOAD_LEASE_FIELDS: Array<{ key: string; label: string; type?: "text" | "email" | "tel" | "date" }> = [
  { key: "leaseStart", label: "Lease start", type: "date" },
  { key: "leaseEnd", label: "Lease end", type: "date" },
  { key: "leaseTerm", label: "Lease term" },
  { key: "monthlyRent", label: "Monthly rent" },
  { key: "securityDeposit", label: "Security deposit" },
  { key: "monthlyUtilities", label: "Monthly utilities" },
];

export const UPLOAD_CONTACT_FIELDS: Array<{ key: string; label: string; type?: "text" | "email" | "tel" | "date" }> = [
  { key: "tenantName", label: "Name" },
  { key: "tenantEmail", label: "Email", type: "email" },
  { key: "tenantPhone", label: "Phone", type: "tel" },
];

/** The fields the normal form for this kind holds: contact + lease terms, plus what an application asks. */
export function uploadFormFields(
  kind: ResidentDocumentKind,
  values: Record<string, string>,
): Array<{ key: string; label: string; type?: "text" | "email" | "tel" | "date" }> {
  if (kind === "lease") return [...UPLOAD_CONTACT_FIELDS, ...UPLOAD_LEASE_FIELDS];
  // An application: contact, plus every applicant question the PDF actually answered.
  const answered = APPLICANT_DOCUMENT_FIELD_KEYS.filter((key) => values[key]?.trim()).map((key) => ({
    key,
    label: APPLICANT_DOCUMENT_FIELD_LABELS[key],
  }));
  return [...UPLOAD_CONTACT_FIELDS, ...answered];
}

/** The parsed values as the form's starting point; the chosen resident's identity wins. */
export function uploadForResidentFields(
  parse: Pick<ParsedResidentDocument, "fields">,
  resident: Pick<UploadResidentOption, "name" | "email" | "phone">,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of parse.fields) {
    if (field.value.trim()) out[field.key] = field.value.trim();
  }
  out.tenantName = resident.name.trim() || out.tenantName || "";
  out.tenantEmail = resident.email.trim().toLowerCase();
  if (resident.phone.trim()) out.tenantPhone = resident.phone.trim();
  return out;
}

export type UploadForResidentTarget =
  | { mode: "existing"; resident: UploadResidentOption }
  | { mode: "new" };

/** The import review the existing commit writes. Create is the confirmation: nothing is left to verify. */
export function uploadForResidentReview(args: {
  kind: ResidentDocumentKind;
  target: UploadForResidentTarget;
  parse: ParsedResidentDocument;
  file: { name: string };
  dataUrl: string;
  fields: Record<string, string>;
  propertyId: string;
  roomId: string;
}): ResidentDocumentImportReview {
  const { target, parse } = args;
  const fields = { ...args.fields };
  if (target.mode === "existing") {
    // The row is matched by email in the commit, so the picked resident's email cannot be edited away.
    fields.tenantEmail = target.resident.email;
  }
  return {
    kind: args.kind,
    fileName: args.file.name,
    dataUrl: args.dataUrl,
    fields,
    propertyId: args.propertyId,
    roomId: args.roomId,
    residentMode: target.mode,
    existingApplicationId: target.mode === "existing" ? target.resident.id : undefined,
    // A resident who already exists already has their way in; a brand-new one is told how to sign in.
    sendAccountSetup: target.mode === "new",
    leaseFullyExecuted:
      args.kind === "lease" &&
      (parse.suggestedLeaseBucket === "signed" || parse.leaseSignatures?.fullyExecuted === true),
  };
}
