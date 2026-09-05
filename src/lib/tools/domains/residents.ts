import { sealApplicantRow } from "@/lib/security/applicant-identity";
import { z } from "zod";
import { defineTool, defineWriteTool } from "../registry";
import type { AgentContext } from "../context";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { managerOwnsResident } from "@/lib/auth/resident-relationship";
import {
  revokeResidentAccessForManager,
  setResidentApprovalForManager,
} from "@/lib/resident-approval.server";
import {
  RESIDENT_WELCOME_EMAIL_RE,
  deliverResidentWelcome,
  residentWelcomeEmailConfigured,
  resolveResidentWelcomeTarget,
} from "@/lib/resident-welcome.server";
import { loadAllManagerRows } from "./load-manager-rows";
import { smsAccessAllowsRow } from "@/lib/sms/manager-sms-access";
import { writeAuditLog, updateAuditResult, auditDayBucket } from "../audit";

/**
 * Residents are approved applicants. They live in the same
 * `manager_application_records` table as applications, distinguished by
 * `bucket === "approved"`. Shared with the write tools that must resolve a
 * model-supplied resident email against the landlord's own residents.
 */
export async function loadManagerApplications(ctx: AgentContext): Promise<DemoApplicantRow[]> {
  return loadAllManagerRows(
    ctx,
    "manager_application_records",
    (rowData) => rowData as DemoApplicantRow,
  );
}

/** Safe projection of a resident (no application form / screening payloads). */
function summarizeResident(r: DemoApplicantRow) {
  return {
    id: r.id,
    name: r.name || null,
    email: (r.email || "").trim().toLowerCase() || null,
    property: r.property || null,
    assignedRoom: r.assignedRoomChoice || null,
    monthlyRent: typeof r.signedMonthlyRent === "number" ? r.signedMonthlyRent : null,
    moveInInstructions: r.moveInInstructions || null,
    manuallyAdded: r.manuallyAdded === true,
  };
}

export const listResidentsTool = defineTool({
  name: "list_residents",
  description:
    "List the current landlord's active residents (approved applicants) with name, email, property, room, and monthly rent. Use to answer 'who are my tenants', 'which residents live at a property', etc. Sensitive application and screening data is never returned.",
  kind: "read",
  inputSchema: z
    .object({
      property: z
        .string()
        .optional()
        .describe("Optional case-insensitive filter on the property label."),
    })
    .strict(),
  handler: async (ctx, input) => {
    const wantProperty = input.property?.trim().toLowerCase();
    const residents = (await loadManagerApplications(ctx))
      .filter((r) => r.bucket === "approved")
      .filter((r) => !wantProperty || String(r.property ?? "").toLowerCase().includes(wantProperty))
      .map(summarizeResident);
    return { count: residents.length, residents };
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

/**
 * Resident profile lookup for previews: name + current approval flag. Reads
 * only display-safe columns. Returns null when no resident account exists yet.
 */
async function loadResidentProfile(
  ctx: AgentContext,
  email: string,
): Promise<{ full_name: string | null; application_approved: boolean | null } | null> {
  const { data, error } = await ctx.db
    .from("profiles")
    .select("full_name, application_approved")
    .eq("role", "resident")
    .eq("email", email)
    .limit(1);
  if (error) throw new Error(error.message);
  return (((data ?? []) as { full_name: string | null; application_approved: boolean | null }[])[0]) ?? null;
}

/** Non-admin managers may only act on residents tied to their own portfolio. */
async function assertResidentInPortfolio(ctx: AgentContext, email: string): Promise<string | null> {
  if (ctx.isAdmin) return null;
  const related = await managerOwnsResident(ctx.db, ctx.landlordId, { email });
  if (related) return null;
  return `No resident with email ${email} is linked to your portfolio (applications, charges, or leases). Use list_residents to find valid resident emails.`;
}

export const setResidentApprovalTool = defineWriteTool({
  name: "set_resident_approval",
  description:
    "Turn a resident's portal access on or off by setting their application-approved flag. Pass the resident's email from list_residents. approved=true grants resident portal access; approved=false suspends it without deleting anything.",
  inputSchema: z
    .object({
      residentEmail: z.string().min(3).describe("The resident's email, from list_residents."),
      approved: z.boolean().describe("true to grant portal access, false to suspend it."),
    })
    .strict(),
  preview: async (ctx, input) => {
    const email = input.residentEmail.trim().toLowerCase();
    if (!email.includes("@")) throw new Error("A valid resident email is required.");
    const ownershipError = await assertResidentInPortfolio(ctx, email);
    if (ownershipError) throw new Error(ownershipError);
    const profile = await loadResidentProfile(ctx, email);
    if (!profile) {
      throw new Error(`No resident account exists for ${email} — they may not have signed up yet.`);
    }
    const currently = profile.application_approved === true;
    if (currently === input.approved) {
      throw new Error(`${email} is already ${input.approved ? "approved" : "not approved"} — nothing to change.`);
    }
    return {
      confirmedInput: { ...input, residentEmail: email },
      kind: "set_resident_approval",
      title: input.approved ? "Approve resident access" : "Suspend resident access",
      summary: `${input.approved ? "Turn on" : "Turn off"} resident portal access for ${profile.full_name || email}.`,
      fields: [
          { label: "Resident", value: profile.full_name ? `${profile.full_name} <${email}>` : email },
          { label: "Approval", value: `${currently ? "Approved" : "Not approved"} → ${input.approved ? "Approved" : "Not approved"}` },
          { label: "Effect", value: `Resident portal access turned ${input.approved ? "on" : "off"}` },
        ],
      confirmLabel: input.approved ? "Approve" : "Suspend",
    };
  },
  handler: async (ctx, input) => {
    const email = input.residentEmail.trim().toLowerCase();
    if (!email.includes("@")) throw new Error("A valid resident email is required.");

    // One-shot per email+value: repeating the same toggle returns already-done.
    const dedupeKey = `set_resident_approval:${ctx.landlordId}:${email}:${input.approved}`;
    const audit = await writeAuditLog(ctx, {
      action: "set_resident_approval",
      toolName: "set_resident_approval",
      inputSummary: { approved: input.approved },
      resultSummary: { residentEmail: email },
      dedupeKey,
    });
    if (!audit.recorded) {
      if (audit.duplicate) {
        return { reply: `${email} was already set to ${input.approved ? "approved" : "not approved"}.` };
      }
      throw new Error("Could not record the action; nothing was changed.");
    }

    // The lib re-checks portfolio ownership server-side before touching profiles.
    const result = await setResidentApprovalForManager(
      ctx.db,
      { userId: ctx.landlordId, isAdmin: ctx.isAdmin },
      { email, approved: input.approved },
    );
    if (!result.ok) {
      await updateAuditResult(ctx, dedupeKey, { error: "update_failed" }, { clearDedupeKey: true });
      throw new Error(result.error);
    }

    await updateAuditResult(ctx, dedupeKey, { residentEmail: email, approved: input.approved });
    return { reply: `${input.approved ? "Approved" : "Suspended"} resident portal access for ${email}.`, resultSummary: { approved: input.approved } };
  },
});

export const sendResidentWelcomeTool = defineWriteTool({
  name: "send_resident_welcome",
  description:
    "Send the resident welcome / account-setup email (with their Axis ID and portal signup link) for an approved application. Pass the application id from list_applications or list_residents — the recipient email and Axis ID are resolved from the stored record, never from input.",
  inputSchema: z
    .object({
      applicationId: z.string().min(1).describe("The application id, from list_applications or list_residents."),
    })
    .strict(),
  preview: async (ctx, input) => {
    const target = await resolveResidentWelcomeTarget(ctx.db, ctx.landlordId, input.applicationId);
    if (!target) {
      throw new Error("No application with that id belongs to this landlord. Use list_applications to get valid ids.");
    }
    if (!target.to || !RESIDENT_WELCOME_EMAIL_RE.test(target.to)) {
      throw new Error("This application has no valid resident email on file, so a welcome email can't be sent.");
    }
    const skipExternalEmail = target.to.endsWith("@axis.local") || target.to === ctx.email;
    if (!skipExternalEmail && !residentWelcomeEmailConfigured()) {
      throw new Error("Email delivery is not configured on this deployment (set RESEND_API_KEY), so the welcome email cannot be sent.");
    }
    return {
      kind: "send_resident_welcome",
      title: "Send resident welcome email",
      summary: `Send the account-setup welcome email to ${target.residentName || target.to}.`,
      fields: [
          { label: "To", value: target.residentName ? `${target.residentName} <${target.to}>` : target.to },
          { label: "Axis ID", value: target.axisId },
          {
            label: "Delivery",
            value: skipExternalEmail
              ? "Portal inbox record only (demo/self address — no external email)"
              : "Email + portal inbox record",
          },
        ],
      confirmLabel: "Send welcome",
    };
  },
  handler: async (ctx, input) => {
    // Re-resolve the recipient from the landlord's own record at execute time.
    const target = await resolveResidentWelcomeTarget(ctx.db, ctx.landlordId, input.applicationId);
    if (!target) throw new Error("No application with that id belongs to this landlord.");
    if (!target.to || !RESIDENT_WELCOME_EMAIL_RE.test(target.to)) {
      throw new Error("This application has no valid resident email on file.");
    }

    // Idempotent per application per day — repeat asks don't re-email.
    const dedupeKey = `send_resident_welcome:${ctx.landlordId}:${target.applicationId}:${auditDayBucket()}`;
    const audit = await writeAuditLog(ctx, {
      action: "send_resident_welcome",
      toolName: "send_resident_welcome",
      inputSummary: { applicationId: target.applicationId },
      resultSummary: { residentEmail: target.to },
      dedupeKey,
    });
    if (!audit.recorded) {
      if (audit.duplicate) return { reply: `A welcome email was already sent to ${target.to} today.` };
      throw new Error("Could not record the action; no email was sent.");
    }

    const result = await deliverResidentWelcome(
      ctx.db,
      { userId: ctx.userId, email: ctx.email },
      { to: target.to, residentName: target.residentName || undefined, axisId: target.axisId },
    );
    if (!result.ok) {
      // Hard failure (not configured / Resend error): clear the dedupe key so a
      // retry after fixing the config can record a fresh attempt.
      await updateAuditResult(ctx, dedupeKey, { error: "send_failed" }, { clearDedupeKey: true });
      throw new Error(result.error);
    }

    const delivery = result.skipped ? "portal_only" : "emailed";
    await updateAuditResult(ctx, dedupeKey, { residentEmail: target.to, delivery });
    return { reply: result.skipped
        ? `Recorded the welcome message for ${target.to} in the portal (demo/self address — no external email sent).`
        : `Sent the welcome email with PropLane ID ${target.axisId} to ${target.to}.`, resultSummary: { applicationId: target.applicationId, delivery } };
  },
});

export const revokeResidentAccessTool = defineWriteTool({
  name: "revoke_resident_access",
  description:
    "Permanently remove a resident's portal sign-in access. Their application, lease, payment, and message records are kept — only the login is removed. Pass the resident's email from list_residents.",
  destructive: true,
  inputSchema: z
    .object({
      residentEmail: z.string().min(3).describe("The resident's email, from list_residents."),
    })
    .strict(),
  preview: async (ctx, input) => {
    const email = input.residentEmail.trim().toLowerCase();
    if (!email.includes("@")) throw new Error("A valid resident email is required.");
    const ownershipError = await assertResidentInPortfolio(ctx, email);
    if (ownershipError) throw new Error(ownershipError);
    const profile = await loadResidentProfile(ctx, email);
    if (!profile) {
      throw new Error(`No resident account exists for ${email} — there is no portal access to revoke.`);
    }
    return {
      confirmedInput: { ...input, residentEmail: email },
      kind: "revoke_resident_access",
      title: "Revoke resident portal access",
      summary: `Remove resident portal sign-in access for ${profile.full_name || email}.`,
      fields: [
          { label: "Resident", value: profile.full_name ? `${profile.full_name} <${email}>` : email },
          { label: "Removed", value: "Resident portal sign-in (login deleted entirely if resident is their only role)" },
          { label: "Kept", value: "Application, lease, payment, and message records" },
        ],
      confirmLabel: "Revoke access",
      warnings: ["This permanently removes the resident's sign-in. If resident is their only portal role, their entire Axis login is deleted and they would have to be re-invited. Their data is NOT deleted — to purge data too, delete the application from the Applications page."],
    };
  },
  handler: async (ctx, input) => {
    const email = input.residentEmail.trim().toLowerCase();
    if (!email.includes("@")) throw new Error("A valid resident email is required.");

    // One-shot state transition: revoking twice returns already-done.
    const dedupeKey = `revoke_resident_access:${ctx.landlordId}:${email}`;
    const audit = await writeAuditLog(ctx, {
      action: "revoke_resident_access",
      toolName: "revoke_resident_access",
      inputSummary: {},
      resultSummary: { residentEmail: email },
      dedupeKey,
    });
    if (!audit.recorded) {
      if (audit.duplicate) return { reply: `Portal access for ${email} was already revoked.` };
      throw new Error("Could not record the action; nothing was revoked.");
    }

    // The lib re-checks portfolio ownership server-side before removing access.
    const result = await revokeResidentAccessForManager(
      ctx.db,
      { userId: ctx.landlordId, isAdmin: ctx.isAdmin },
      { email },
    );
    if (!result.ok) {
      await updateAuditResult(ctx, dedupeKey, { error: "revoke_failed" }, { clearDedupeKey: true });
      throw new Error(result.error);
    }

    await updateAuditResult(ctx, dedupeKey, { residentEmail: email, mode: result.mode });
    const reply =
      result.mode === "deleted_auth_user"
        ? `Removed ${email}'s Axis login entirely (resident was their only portal role). Their records are kept.`
        : result.mode === "revoked_role"
          ? `Removed ${email}'s resident portal access; their other portal roles remain. Their records are kept.`
          : `${email} had no active resident access — nothing further to remove.`;
    return { reply, resultSummary: { mode: result.mode } };
  },
});

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export const recordMoveOutTool = defineWriteTool({
  name: "record_move_out",
  description:
    "Record a resident's move-out date on their application record (bookkeeping only). Pass the application id from list_residents. This updates the stored move-out/lease-end fields the portal displays; it does NOT amend a signed lease.",
  inputSchema: z
    .object({
      applicationId: z.string().min(1).describe("The resident's application id, from list_residents."),
      moveOutDate: z
        .string()
        .regex(ISO_DATE_RE, "Must be YYYY-MM-DD")
        .describe("The move-out date in YYYY-MM-DD format."),
    })
    .strict(),
  preview: async (ctx, input) => {
    const rec = await loadOwnedApplicationRecord(ctx, input.applicationId);
    if (!rec) {
      throw new Error("No application with that id belongs to this landlord. Use list_residents to get valid ids.");
    }
    const row = (rec.row_data ?? {}) as DemoApplicantRow;
    const currentEnd = row.application?.leaseEnd?.trim() || row.manualResidentDetails?.moveOutDate?.trim() || "not set";
    return {
      kind: "record_move_out",
      title: "Record move-out date",
      summary: `Record ${input.moveOutDate} as the move-out date for ${row.name || rec.id}.`,
      fields: [
          { label: "Resident", value: row.name ? `${row.name}${row.email ? ` <${row.email.trim().toLowerCase()}>` : ""}` : rec.id },
          ...(row.property ? [{ label: "Property", value: row.property }] : []),
          { label: "Move-out date", value: `${currentEnd} → ${input.moveOutDate}` },
        ],
      confirmLabel: "Record move-out",
      warnings: ["Does not amend a signed lease — use amend_lease for that."],
    };
  },
  handler: async (ctx, input) => {
    // Re-resolve the owned record at execute time; never trust stored input.
    const rec = await loadOwnedApplicationRecord(ctx, input.applicationId);
    if (!rec) throw new Error("No application with that id belongs to this landlord.");

    const dedupeKey = `record_move_out:${ctx.landlordId}:${rec.id}:${input.moveOutDate}`;
    const audit = await writeAuditLog(ctx, {
      action: "record_move_out",
      toolName: "record_move_out",
      inputSummary: { applicationId: rec.id, moveOutDate: input.moveOutDate },
      dedupeKey,
    });
    if (!audit.recorded) {
      if (audit.duplicate) return { reply: `${input.moveOutDate} was already recorded as the move-out date.` };
      throw new Error("Could not record the action; nothing was changed.");
    }

    // Read-merge-write the exact fields syncApplicationLeaseDates
    // (src/lib/lease-amendment.server.ts) writes, on the CURRENT row_data.
    const rowData = asObject(rec.row_data) ?? {};
    const application = asObject(rowData.application) ?? {};
    const manual = asObject(rowData.manualResidentDetails) ?? {};
    const { error } = await ctx.db
      .from("manager_application_records")
      .update({
        row_data: sealApplicantRow({
          ...rowData,
          application: { ...application, leaseEnd: input.moveOutDate },
          manualResidentDetails: { ...manual, moveOutDate: input.moveOutDate },
        }, rec.id, ctx.landlordId),
        updated_at: new Date().toISOString(),
      })
      .eq("id", rec.id)
      .eq("manager_user_id", ctx.landlordId);
    if (error) {
      await updateAuditResult(ctx, dedupeKey, { error: "update_failed" }, { clearDedupeKey: true });
      throw new Error(error.message);
    }

    await updateAuditResult(ctx, dedupeKey, { applicationId: rec.id, moveOutDate: input.moveOutDate });
    const row = rowData as unknown as DemoApplicantRow;
    return { reply: `Recorded ${input.moveOutDate} as the move-out date for ${row.name || rec.id}. This does not amend a signed lease — use amend_lease for that.`, resultSummary: { applicationId: rec.id, moveOutDate: input.moveOutDate } };
  },
});
