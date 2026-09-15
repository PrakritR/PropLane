import {
  appendManagerApplicationRow,
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
import { buildApplicationRow } from "@/lib/resident-document-import/build-application-row";

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
