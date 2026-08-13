import type { DemoApplicantRow } from "@/data/demo-portal";
import { LISTING_ROOM_CHOICE_SEP } from "@/lib/rental-application/data";
import {
  appendManagerApplicationRow,
  readManagerApplicationRows,
  replaceManagerApplicationRowInCache,
  syncManagerApplicationsFromServer,
  upsertApplicationRowToServerAwait,
} from "@/lib/manager-applications-storage";
import {
  ensureManagerReviewLeaseForApplication,
  syncLeasePipelineFromApplications,
  syncLeasePipelineFromServer,
} from "@/lib/lease-pipeline-storage";
import { uploadAndParseLeasePdf } from "@/lib/uploaded-lease-parse.client";
import { recordApprovedApplicationCharges } from "@/lib/household-charges";
import { deliverPortalInboxMessage } from "@/lib/portal-message-delivery";
import {
  buildExistingResidentWelcomeEmailBody,
  EXISTING_RESIDENT_WELCOME_EMAIL_SUBJECT,
} from "@/lib/existing-resident-welcome-email";
import { residentAccountCreationUrl } from "@/lib/resident-welcome-email";
import type { ResidentDocumentImportReview } from "@/lib/resident-document-import/types";
import type { ParsedResidentDocument } from "@/lib/resident-document-import/types";

function parseMoney(value: string): number | undefined {
  const n = Number(value.replace(/[^\d.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function buildApplicationRow(args: {
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

export async function commitResidentDocumentImport(args: {
  parse: ParsedResidentDocument;
  review: ResidentDocumentImportReview;
  file: File | null;
  managerUserId: string | null;
  propertyLabel: string;
  managerName?: string;
}): Promise<{ ok: true; applicationId: string; leaseId?: string } | { ok: false; error: string }> {
  const row = buildApplicationRow(args);
  if (!row.email?.trim()) return { ok: false, error: "A resident email is required." };

  const isNew = args.review.residentMode === "new";
  if (isNew) {
    appendManagerApplicationRow(row, { skipServerMirror: true });
  } else {
    replaceManagerApplicationRowInCache(row);
  }

  const persisted = await upsertApplicationRowToServerAwait(row, {
    existingResidentOnboarding: { sendWelcomeEmail: false },
  });
  if (!persisted.ok) {
    return { ok: false, error: persisted.error ?? "Could not save the resident record." };
  }

  if (row.bucket === "approved") {
    recordApprovedApplicationCharges(row, args.managerUserId, true);
  }

  let leaseId: string | undefined;
  if (args.review.kind === "lease" && args.file) {
    if (args.review.leaseFullyExecuted) {
      syncLeasePipelineFromApplications(args.managerUserId);
      leaseId = `lease_app_${row.id}`;
    } else {
      const ensured = ensureManagerReviewLeaseForApplication(row.id, args.managerUserId);
      if (!ensured.ok) return { ok: false, error: ensured.error };
      leaseId = ensured.row.id;
      const uploaded = await uploadAndParseLeasePdf(ensured.row.id, args.file, args.managerUserId);
      if (!uploaded.ok) return { ok: false, error: uploaded.error ?? "Could not upload the lease PDF." };
    }
  } else if (args.review.kind === "lease") {
    syncLeasePipelineFromApplications(args.managerUserId);
    leaseId = `lease_app_${row.id}`;
  }

  if (args.review.sendAccountSetup) {
    const signupUrl = residentAccountCreationUrl(window.location.origin, row.id);
    const notice = await deliverPortalInboxMessage({
      eventCategory: "messages",
      toEmails: [row.email.trim().toLowerCase()],
      subject: EXISTING_RESIDENT_WELCOME_EMAIL_SUBJECT,
      text: buildExistingResidentWelcomeEmailBody({
        residentName: row.name,
        axisId: row.id,
        signupUrl,
        propertyLabel: row.property,
      }),
      deliverViaEmail: true,
      deliverViaSms: false,
    });
    if (!notice.ok) {
      return {
        ok: false,
        error: notice.error ?? "Resident saved, but the portal setup message could not be sent.",
      };
    }
  }

  await Promise.all([
    syncManagerApplicationsFromServer({ force: true, managerUserId: args.managerUserId ?? undefined }),
    syncLeasePipelineFromServer(args.managerUserId, { force: true }),
  ]);

  return { ok: true, applicationId: row.id, leaseId };
}
