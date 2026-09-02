import { z } from "zod";
import { defineTool, defineWriteTool } from "../registry";
import type { AgentContext } from "../context";
import type { DemoApplicantRow, ManagerApplicationBucket } from "@/data/demo-portal";
import { resolveBackgroundCheckStatus } from "@/lib/application-background-check";
import { stageLabelForApplicationBucket } from "@/lib/application-review";
import { applicationStageDisplayLabel } from "@/lib/rental-application/in-progress-application";
import { backgroundCheckConfigured, checkrPackage } from "@/lib/checkr/config";
import { runBackgroundCheck } from "@/lib/checkr/background-check";
import { checkrOrderCostCents } from "@/lib/checkr/packages";
import { setResidentApprovalForManager } from "@/lib/resident-approval.server";
import { screeningConfigured, screeningCostCents } from "@/lib/screening/config";
import { orderScreeningForApplication } from "@/lib/screening/order-screening";
import { loadAllManagerRows } from "./load-manager-rows";
import { smsAccessAllowsRow } from "@/lib/sms/manager-sms-access";
import { writeAuditLog, updateAuditResult } from "../audit";

/** Server-side read of the landlord's applications, scoped by manager_user_id. */
async function loadManagerApplications(ctx: AgentContext): Promise<DemoApplicantRow[]> {
  return loadAllManagerRows(
    ctx,
    "manager_application_records",
    (rowData) => rowData as DemoApplicantRow,
  );
}

/**
 * Safe projection of an applicant. The raw `application` form (SSN, income,
 * employment, references) and the vendor `screening` report are deliberately
 * dropped — only the derived screening *status* is exposed. This is the central
 * PII guard for this domain.
 */
function summarizeApplicant(r: DemoApplicantRow) {
  return {
    id: r.id,
    name: r.name || null,
    email: (r.email || "").trim().toLowerCase() || null,
    property: r.property || null,
    stage: applicationStageDisplayLabel(r),
    bucket: r.bucket || null,
    assignedRoom: r.assignedRoomChoice || null,
    signedMonthlyRent: typeof r.signedMonthlyRent === "number" ? r.signedMonthlyRent : null,
    screeningStatus: resolveBackgroundCheckStatus(r),
    manuallyAdded: r.manuallyAdded === true,
  };
}

export const listApplicationsTool = defineTool({
  name: "list_applications",
  description:
    "List the current landlord's rental applications with applicant name, email, property, stage, status (pending/approved/rejected), and background-screening status (pending_review/passed/flagged/not_applicable). Use for 'how many applications are pending', 'which applicants are flagged in screening', etc. Sensitive application form data and raw screening reports are never returned.",
  kind: "read",
  inputSchema: z
    .object({
      bucket: z
        .enum(["pending", "approved", "rejected"])
        .optional()
        .describe("Optional filter on the application bucket."),
      screeningStatus: z
        .enum(["pending_review", "passed", "flagged", "not_applicable"])
        .optional()
        .describe("Optional filter on background-screening status."),
    })
    .strict(),
  handler: async (ctx, input) => {
    const rows = await loadManagerApplications(ctx);
    const filtered = rows
      .map((r) => ({ row: r, summary: summarizeApplicant(r) }))
      .filter(({ row, summary }) => {
        if (input.bucket && row.bucket !== input.bucket) return false;
        if (input.screeningStatus && summary.screeningStatus !== input.screeningStatus) return false;
        return true;
      })
      .map(({ summary }) => summary);
    return { count: filtered.length, applications: filtered };
  },
});

type OwnedApplicationRecord = {
  id: string;
  resident_email: string | null;
  row_data: unknown;
};

/** Server-side single-application read, always scoped by manager_user_id. */
async function loadOwnedApplicationRecord(
  ctx: AgentContext,
  applicationId: string,
): Promise<OwnedApplicationRecord | null> {
  const id = applicationId.trim();
  if (!id) return null;
  const { data, error } = await ctx.db
    .from("manager_application_records")
    .select("id, resident_email, row_data, manager_user_id")
    .eq("id", id)
    .eq("manager_user_id", ctx.landlordId)
    .limit(1);
  if (error) throw new Error(error.message);
  const rec = (((data ?? []) as (OwnedApplicationRecord & { manager_user_id?: string | null })[])[0]) ?? null;
  if (!rec) return null;
  if (
    !smsAccessAllowsRow(ctx.managerSmsAccess, {
      dataOwnerId: String(rec.manager_user_id ?? ctx.landlordId).trim() || ctx.landlordId,
      rowData: rec.row_data,
      table: "manager_application_records",
    })
  ) {
    return null;
  }
  return rec;
}

export const getApplicationDetailsTool = defineTool({
  name: "get_application_details",
  description:
    "Get one of the current landlord's applications in detail: applicant name/email, stage, bucket, desired lease dates and term, room choice, derived screening status, and Checkr check status if one was run. Pass an application id from list_applications. The raw application form (SSN, income, employment, references), screening report bodies, and uploaded documents are never returned.",
  kind: "read",
  inputSchema: z
    .object({
      applicationId: z.string().min(1).describe("The application id, from list_applications."),
    })
    .strict(),
  handler: async (ctx, input) => {
    const rec = await loadOwnedApplicationRecord(ctx, input.applicationId);
    if (!rec) return { found: false, message: "No application with that id belongs to this landlord." };
    const r = (rec.row_data ?? {}) as DemoApplicantRow;
    return {
      found: true,
      application: {
        id: rec.id,
        name: r.name || null,
        email: (r.email || rec.resident_email || "").trim().toLowerCase() || null,
        property: r.property || null,
        stage: applicationStageDisplayLabel(r),
        bucket: r.bucket || null,
        desiredLeaseStart: r.application?.leaseStart?.trim() || null,
        desiredLeaseEnd: r.application?.leaseEnd?.trim() || null,
        leaseTerm: r.application?.leaseTerm?.trim() || null,
        roomChoice: r.assignedRoomChoice || r.application?.roomChoice1 || null,
        signedMonthlyRent: typeof r.signedMonthlyRent === "number" ? r.signedMonthlyRent : null,
        screeningStatus: resolveBackgroundCheckStatus(r),
        checkr: r.backgroundCheck
          ? {
              status: r.backgroundCheck.status ?? null,
              result: r.backgroundCheck.result ?? null,
              orderedAt: r.backgroundCheck.orderedAt ?? null,
              completedAt: r.backgroundCheck.completedAt ?? null,
            }
          : null,
        manuallyAdded: r.manuallyAdded === true,
      },
    };
  },
});

const APPLICATION_BUCKETS = ["approved", "rejected", "pending"] as const;

export const updateApplicationBucketTool = defineWriteTool({
  name: "update_application_bucket",
  description:
    "Move one of the landlord's applications between the pending, approved, and rejected buckets. Pass an application id from list_applications. Approving also turns the applicant's resident portal access on (rejected/pending turns it off); it does not send the welcome email — use send_resident_welcome for that.",
  inputSchema: z
    .object({
      applicationId: z.string().min(1).describe("The application id, from list_applications."),
      bucket: z.enum(APPLICATION_BUCKETS).describe("Target bucket: approved, rejected, or pending."),
    })
    .strict(),
  preview: async (ctx, input) => {
    const rec = await loadOwnedApplicationRecord(ctx, input.applicationId);
    if (!rec) {
      throw new Error("No application with that id belongs to this landlord. Use list_applications to get valid ids.");
    }
    const r = (rec.row_data ?? {}) as DemoApplicantRow;
    if (r.bucket === input.bucket) {
      throw new Error(`This application is already ${input.bucket} — nothing to change.`);
    }
    const email = (r.email || rec.resident_email || "").trim().toLowerCase();
    const lines = [
      { label: "Applicant", value: r.name ? `${r.name}${email ? ` <${email}>` : ""}` : rec.id },
      ...(r.property ? [{ label: "Property", value: r.property }] : []),
      { label: "Status", value: `${r.bucket ?? "—"} → ${input.bucket}` },
      ...(email
        ? [
            {
              label: "Side effect",
              value: `Resident portal access turned ${input.bucket === "approved" ? "on" : "off"} for ${email}`,
            },
          ]
        : []),
    ];
    return {
      kind: "update_application_bucket",
      title: input.bucket === "approved"
            ? "Approve application"
            : input.bucket === "rejected"
              ? "Reject application"
              : "Move application to pending",
      summary: `Move ${r.name || rec.id}'s application from ${r.bucket ?? "—"} to ${input.bucket}.`,
      fields: lines,
      confirmLabel: input.bucket === "approved" ? "Approve" : input.bucket === "rejected" ? "Reject" : "Move to pending",
    };
  },
  handler: async (ctx, input) => {
    // Re-resolve the owned record at execute time; never trust stored input.
    const rec = await loadOwnedApplicationRecord(ctx, input.applicationId);
    if (!rec) throw new Error("No application with that id belongs to this landlord.");
    const rowData = (rec.row_data && typeof rec.row_data === "object" ? rec.row_data : {}) as Record<string, unknown>;
    const r = rowData as unknown as DemoApplicantRow;
    if (r.bucket === input.bucket) {
      return { reply: `This application is already ${input.bucket}.` };
    }

    // One-shot per application+bucket: re-approving after a bounce records anew
    // (different target bucket), repeating the same move returns already-done.
    const dedupeKey = `update_application_bucket:${ctx.landlordId}:${rec.id}:${input.bucket}`;
    const audit = await writeAuditLog(ctx, {
      action: "update_application_bucket",
      toolName: "update_application_bucket",
      inputSummary: { applicationId: rec.id, bucket: input.bucket },
      dedupeKey,
    });
    if (!audit.recorded) {
      if (audit.duplicate) return { reply: `This application was already moved to ${input.bucket}.` };
      throw new Error("Could not record the action; nothing was changed.");
    }

    // Read-merge-write the CURRENT row_data with the same fields the UI's
    // transitionApplicationBucket writes (bucket + stage label + owner scope).
    const bucket = input.bucket as ManagerApplicationBucket;
    const { error } = await ctx.db
      .from("manager_application_records")
      .update({
        row_data: {
          ...rowData,
          bucket,
          stage: stageLabelForApplicationBucket(bucket),
          ...(bucket === "approved" ? { managerUserId: r.managerUserId ?? ctx.landlordId } : {}),
        },
        updated_at: new Date().toISOString(),
      })
      .eq("id", rec.id)
      .eq("manager_user_id", ctx.landlordId);
    if (error) {
      await updateAuditResult(ctx, dedupeKey, { error: "update_failed" }, { clearDedupeKey: true });
      throw new Error(error.message);
    }

    // Matching the UI flow: every bucket transition syncs the resident's
    // profiles.application_approved flag (approved=true only for approved).
    const email = (r.email || rec.resident_email || "").trim().toLowerCase();
    let approvalSynced = false;
    if (email.includes("@")) {
      try {
        const approval = await setResidentApprovalForManager(
          ctx.db,
          { userId: ctx.landlordId, isAdmin: ctx.isAdmin },
          { email, approved: bucket === "approved" },
        );
        approvalSynced = approval.ok;
      } catch {
        /* keep the bucket move even if profile sync fails — matches the UI */
      }
    }

    await updateAuditResult(ctx, dedupeKey, { applicationId: rec.id, bucket, approvalSynced });
    const tail =
      bucket === "approved" && email
        ? " Their portal access is on — use send_resident_welcome to send account setup."
        : "";
    return { reply: `Moved ${r.name || rec.id}'s application to ${bucket}.${tail}`, resultSummary: { applicationId: rec.id, bucket, approvalSynced } };
  },
});

type ScreeningProviderChoice = "checkr" | "certn";

/**
 * Resolve which screening provider to use and whether it is configured on this
 * deployment. An explicit request for an unconfigured provider is an honest
 * error; with no preference, whichever provider is configured wins (Checkr
 * first — it's the per-applicant background check the Applications UI runs).
 */
function resolveScreeningProvider(requested: ScreeningProviderChoice | undefined):
  | { ok: true; provider: ScreeningProviderChoice }
  | { ok: false; error: string } {
  const checkrOk = backgroundCheckConfigured();
  const certnOk = screeningConfigured();
  if (requested === "checkr") {
    return checkrOk
      ? { ok: true, provider: "checkr" }
      : { ok: false, error: "Checkr background checks are not configured on this deployment (CHECKR_API_KEY is missing)." };
  }
  if (requested === "certn") {
    return certnOk
      ? { ok: true, provider: "certn" }
      : { ok: false, error: "Certn screening is not configured on this deployment (CERTN_API_KEY is missing)." };
  }
  if (checkrOk) return { ok: true, provider: "checkr" };
  if (certnOk) return { ok: true, provider: "certn" };
  return {
    ok: false,
    error: "Applicant screening is not configured on this deployment (neither CHECKR_API_KEY nor CERTN_API_KEY is set).",
  };
}

function screeningInProgressError(r: DemoApplicantRow, provider: ScreeningProviderChoice): string | null {
  if (provider === "checkr" && r.backgroundCheck?.status === "pending") {
    return "A background check is already in progress for this applicant.";
  }
  if (provider === "certn" && (r.screening?.status === "in_progress" || r.screening?.status === "queued")) {
    return "Screening is already in progress for this applicant.";
  }
  return null;
}

export const orderBackgroundCheckTool = defineWriteTool({
  name: "order_background_check",
  description:
    "Order a paid background/screening check (Checkr or Certn) for one of the landlord's applicants. This charges the landlord's saved payment method. Pass an application id from list_applications; the applicant must have consented to screening on their application.",
  inputSchema: z
    .object({
      applicationId: z.string().min(1).describe("The application id, from list_applications."),
      provider: z
        .enum(["checkr", "certn"])
        .optional()
        .describe("Screening provider. Omit to use whichever is configured on this deployment."),
    })
    .strict(),
  preview: async (ctx, input) => {
    // Env-gate first: an unconfigured deployment gets an honest error, never a
    // preview that cannot execute.
    const resolved = resolveScreeningProvider(input.provider);
    if (!resolved.ok) throw new Error(resolved.error);
    const provider = resolved.provider;

    const rec = await loadOwnedApplicationRecord(ctx, input.applicationId);
    if (!rec) {
      throw new Error("No application with that id belongs to this landlord. Use list_applications to get valid ids.");
    }
    const r = (rec.row_data ?? {}) as DemoApplicantRow;
    if (!r.application) {
      throw new Error("This record has no rental application on file to screen (it may be a manually added resident).");
    }
    if (r.application.consentCredit !== true) {
      throw new Error("The applicant did not authorize credit/background screening on their application, so a check cannot be ordered.");
    }
    const inProgress = screeningInProgressError(r, provider);
    if (inProgress) throw new Error(inProgress);

    const packageLabel = provider === "checkr" ? `Checkr "${checkrPackage()}"` : "Certn standard screening";
    const costCents = provider === "checkr" ? checkrOrderCostCents(checkrPackage(), []) : screeningCostCents();
    const costLabel = `$${(costCents / 100).toFixed(2)}`;
    return {
      kind: "order_background_check",
      title: "Order background check",
      summary: `Order a ${provider} background check for ${r.name || rec.id} (${costLabel}).`,
      fields: [
          { label: "Applicant", value: r.name ? `${r.name}${r.email ? ` <${(r.email || "").trim().toLowerCase()}>` : ""}` : rec.id },
          { label: "Provider", value: provider },
          { label: "Package", value: packageLabel },
          { label: "Cost", value: costLabel },
          { label: "Consent on file", value: "Yes" },
        ],
      confirmLabel: "Order check",
      warnings: [`This orders a paid screening (${costLabel}) charged to your saved payment method. It is not refundable once the vendor starts the report.`],
    };
  },
  handler: async (ctx, input) => {
    const resolved = resolveScreeningProvider(input.provider);
    if (!resolved.ok) throw new Error(resolved.error);
    const provider = resolved.provider;

    // Re-resolve ownership at execute time — the screening libs are called with
    // ctx.landlordId, and the record must be this landlord's own.
    const rec = await loadOwnedApplicationRecord(ctx, input.applicationId);
    if (!rec) throw new Error("No application with that id belongs to this landlord.");
    const r = (rec.row_data ?? {}) as DemoApplicantRow;

    // One-shot per application+provider: a money-moving order must never
    // double-charge on a repeat ask.
    const dedupeKey = `order_background_check:${ctx.landlordId}:${rec.id}:${provider}`;
    const audit = await writeAuditLog(ctx, {
      action: "order_background_check",
      toolName: "order_background_check",
      inputSummary: { applicationId: rec.id, provider },
      dedupeKey,
    });
    if (!audit.recorded) {
      if (audit.duplicate) {
        return { reply: `A ${provider} check was already ordered for this applicant.` };
      }
      throw new Error("Could not record the action; no check was ordered.");
    }

    const result =
      provider === "checkr"
        ? await runBackgroundCheck({
            db: ctx.db,
            applicationId: rec.id,
            managerUserId: ctx.landlordId,
            packageSlug: checkrPackage(),
          })
        : await orderScreeningForApplication({
            db: ctx.db,
            applicationId: rec.id,
            managerUserId: ctx.landlordId,
          });

    if (!result.ok) {
      // Order never went through (config, plan, consent, payment, or vendor
      // error): clear the dedupe key so a corrected retry can order fresh.
      await updateAuditResult(ctx, dedupeKey, { error: result.code ?? "order_failed" }, { clearDedupeKey: true });
      throw new Error(result.error);
    }

    const status = provider === "checkr"
      ? (result as { backgroundCheck: { status: string } }).backgroundCheck.status
      : (result as { screening: { status: string } }).screening.status;
    await updateAuditResult(ctx, dedupeKey, { applicationId: rec.id, provider, status });
    return { reply: `Ordered the ${provider} background check for ${r.name || rec.id} — current status: ${status}. Results will appear on the application when the report completes.`, resultSummary: { applicationId: rec.id, provider, status } };
  },
});
