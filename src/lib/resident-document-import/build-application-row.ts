import type { DemoApplicantRow } from "@/data/demo-portal";
import { LISTING_ROOM_CHOICE_SEP } from "@/lib/rental-application/data";
import { readManagerApplicationRows } from "@/lib/manager-applications-storage";
import type { ResidentDocumentImportReview } from "@/lib/resident-document-import/types";
import type { ParsedResidentDocument } from "@/lib/resident-document-import/types";

/**
 * Moved out of `commit-import.client.ts` (isomorphic — no browser-only import
 * beyond `readManagerApplicationRows`, which is a plain in-memory cache read)
 * so a server-side caller can build the same
 * `DemoApplicantRow` shape without pulling in the client commit pipeline.
 * Behavior is unchanged from the original.
 */

function parseMoney(value: string): number | undefined {
  const n = Number(value.replace(/[^\d.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function buildApplicationRow(args: {
  parse: ParsedResidentDocument;
  review: ResidentDocumentImportReview;
  managerUserId: string | null;
  propertyLabel: string;
}): DemoApplicantRow {
  const { parse, review, managerUserId, propertyLabel } = args;
  const fields = review.fields;
  const name = fields.tenantName?.trim() || "Resident";
  const email = fields.tenantEmail?.trim() || "";
  const phone = fields.tenantPhone?.trim() || undefined;
  const rent = parseMoney(fields.monthlyRent ?? "");
  const utilities = parseMoney(fields.monthlyUtilities ?? "");
  const deposit = parseMoney(fields.securityDeposit ?? "");
  const moveInFee = parseMoney(fields.moveInFee ?? "");
  const axisId =
    review.residentMode === "existing" && review.existingApplicationId?.trim()
      ? review.existingApplicationId.trim()
      : `PROPLANE-${Date.now().toString(36).toUpperCase().slice(-8)}`;
  const bucket =
    review.kind === "application" && parse.suggestedApplicationBucket === "pending" ? "pending" : "approved";
  const hasLeasePdf = review.kind === "lease" && review.dataUrl.trim().length > 0;
  const roomChoice =
    review.propertyId && review.roomId
      ? `${review.propertyId}${LISTING_ROOM_CHOICE_SEP}${review.roomId}`
      : undefined;

  const existing = review.existingApplicationId?.trim()
    ? readManagerApplicationRows().find((row) => row.id === review.existingApplicationId)
    : review.residentMode === "existing" && review.existingApplicationId?.trim()
      ? readManagerApplicationRows().find((row) => row.id === review.existingApplicationId)
      : null;

  const base: DemoApplicantRow = existing
    ? { ...existing }
    : {
        id: axisId,
        name,
        email,
        property: args.propertyLabel || "—",
        stage: bucket === "approved" ? "Active" : "Application",
        bucket,
        detail: "",
        managerUserId: args.managerUserId ?? undefined,
      };

  return {
    ...base,
    name: name || base.name,
    email: email || base.email,
    property: args.propertyLabel || base.property,
    bucket,
    stage: bucket === "approved" ? "Active" : base.stage,
    assignedPropertyId: review.propertyId || base.assignedPropertyId,
    assignedRoomChoice: roomChoice || base.assignedRoomChoice,
    signedMonthlyRent: rent ?? base.signedMonthlyRent,
    manuallyAdded: true,
    manualResidentDetails: {
      ...(base.manualResidentDetails ?? {}),
      phone: phone ?? base.manualResidentDetails?.phone,
      moveInDate: fields.leaseStart?.trim() || base.manualResidentDetails?.moveInDate,
      moveOutDate: fields.leaseEnd?.trim() || base.manualResidentDetails?.moveOutDate,
      leaseTerm: fields.leaseTerm?.trim() || base.manualResidentDetails?.leaseTerm,
      monthlyUtilities: utilities ?? base.manualResidentDetails?.monthlyUtilities,
      securityDeposit: deposit ?? base.manualResidentDetails?.securityDeposit,
      moveInFee: moveInFee ?? base.manualResidentDetails?.moveInFee,
      ...(hasLeasePdf && review.leaseFullyExecuted
        ? {
            signedLeaseFileName: review.fileName,
            signedLeaseDataUrl: review.dataUrl,
            signedLeaseUploadedAt: new Date().toISOString(),
            externallySignedLease: true as const,
          }
        : {}),
    },
    application: {
      ...(base.application ?? {}),
      propertyId: review.propertyId || base.application?.propertyId,
      roomChoice1: roomChoice || base.application?.roomChoice1,
      leaseStart: fields.leaseStart?.trim() || base.application?.leaseStart,
      leaseEnd: fields.leaseEnd?.trim() || base.application?.leaseEnd,
      leaseTerm: fields.leaseTerm?.trim() || base.application?.leaseTerm,
      fullLegalName: name,
      email,
      phone: phone || base.application?.phone,
      managerRentOverride: rent != null ? String(rent) : base.application?.managerRentOverride,
    } as DemoApplicantRow["application"],
  };
}

/**
 * `buildApplicationRow`'s sibling for portfolio import: there is no
 * `ParsedResidentDocument`/`ResidentDocumentImportReview` pair for a rent-roll
 * row, so this builds the identical `DemoApplicantRow` shape directly from
 * plain resident fields. Kept in the same file so both builders stay in sync
 * on what an imported/manually-added resident row looks like.
 */
export function buildImportedResidentRow(args: {
  id: string;
  name: string;
  email: string;
  phone?: string | null;
  propertyId: string;
  propertyLabel: string;
  roomId: string;
  leaseStart?: string | null;
  leaseEnd?: string | null;
  rent?: number | null;
  deposit?: number | null;
  leasePdf?: { fileName: string; dataUrl: string; fullyExecuted: boolean } | null;
  managerUserId: string;
}): DemoApplicantRow {
  const roomChoice = `${args.propertyId}${LISTING_ROOM_CHOICE_SEP}${args.roomId}`;
  const hasSignedLease = Boolean(args.leasePdf?.fullyExecuted && args.leasePdf.dataUrl.trim());
  const name = args.name.trim() || "Resident";
  const phone = args.phone?.trim() || undefined;
  const leaseStart = args.leaseStart?.trim() || undefined;
  const leaseEnd = args.leaseEnd?.trim() || undefined;

  return {
    id: args.id,
    name,
    email: args.email,
    property: args.propertyLabel || "—",
    stage: "Active",
    bucket: "approved",
    detail: "",
    managerUserId: args.managerUserId,
    manuallyAdded: true,
    assignedPropertyId: args.propertyId,
    assignedRoomChoice: roomChoice,
    signedMonthlyRent: args.rent ?? null,
    manualResidentDetails: {
      phone,
      moveInDate: leaseStart,
      moveOutDate: leaseEnd,
      securityDeposit: args.deposit ?? undefined,
      ...(hasSignedLease
        ? {
            signedLeaseFileName: args.leasePdf!.fileName,
            signedLeaseDataUrl: args.leasePdf!.dataUrl,
            signedLeaseUploadedAt: new Date().toISOString(),
            externallySignedLease: true as const,
          }
        : {}),
    },
    application: {
      propertyId: args.propertyId,
      roomChoice1: roomChoice,
      leaseStart,
      leaseEnd,
      fullLegalName: name,
      email: args.email,
      phone,
      managerRentOverride: args.rent != null ? String(args.rent) : undefined,
    } as DemoApplicantRow["application"],
  };
}
