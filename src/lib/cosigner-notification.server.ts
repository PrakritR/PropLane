/**
 * Notify property manager when a co-signer submits.
 */

import { formatPacificDateTime } from "@/lib/pacific-time";
import { buildPortalApplicationOpenHref } from "@/lib/manager-applications-storage";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { postResendEmail } from "@/lib/resend-delivery.server";

const MANAGER_INBOX_SCOPE = "axis_portal_inbox_manager_v1";

type Db = ReturnType<typeof import("@/lib/supabase/service").createSupabaseServiceRoleClient>;

async function deliverEmail(to: string[], subject: string, text: string, actorUserId: string): Promise<void> {
  const recipients = to.map((e) => e.trim().toLowerCase()).filter((e) => e.includes("@"));
  if (recipients.length === 0) return;
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) return;
  const from = process.env.RESEND_FROM?.trim() || "PropLane <onboarding@resend.dev>";
  await postResendEmail({
    apiKey,
    actorUserId,
    payload: { from, to: recipients, subject, text },
    effectSummary: "Cosigner submission email captured for the test workspace.",
  }).catch(() => undefined);
}

async function upsertManagerInbox(
  db: Db,
  managerUserId: string,
  input: { subject: string; body: string; fromName: string; fromEmail: string },
): Promise<void> {
  const threadId = `cosigner-${Date.now().toString(36)}`;
  const now = formatPacificDateTime(new Date());
  await db.from("portal_inbox_thread_records").upsert(
    {
      id: threadId,
      scope: MANAGER_INBOX_SCOPE,
      owner_user_id: managerUserId,
      participant_email: input.fromEmail,
      row_data: {
        id: threadId,
        folder: "inbox",
        from: input.fromName,
        email: input.fromEmail,
        subject: input.subject,
        preview: input.body.slice(0, 100),
        body: input.body,
        time: now,
        unread: true,
      },
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  );
}

export async function notifyManagerCosignerSubmitted(input: {
  managerUserId: string | null;
  signerAppId: string;
  primaryApplicantName?: string;
  propertyTitle?: string;
  cosignerName: string;
  cosignerEmail: string;
}): Promise<void> {
  if (!input.managerUserId) return;
  const db = (await import("@/lib/supabase/service")).createSupabaseServiceRoleClient();
  const { data: profile } = await db.from("profiles").select("email, full_name").eq("id", input.managerUserId).maybeSingle();
  const managerEmail = (profile?.email ?? "").trim().toLowerCase();
  if (!managerEmail.includes("@")) return;

  const origin = resolveEmailLinkBaseUrl();
  const appHref = `${origin}${buildPortalApplicationOpenHref(input.signerAppId)}`;
  const primary = input.primaryApplicantName?.trim() || "Primary applicant";
  const property = input.propertyTitle?.trim() ? ` for ${input.propertyTitle.trim()}` : "";
  const subject = `Co-signer submitted — ${input.signerAppId}`;
  const body = [
    `A co-signer form was submitted for application ${input.signerAppId}.`,
    "",
    `Primary applicant: ${primary}${property}`,
    `Co-signer: ${input.cosignerName} (${input.cosignerEmail})`,
    "",
    `Review in your portal: ${appHref}`,
    "",
    "— PropLane",
  ].join("\n");

  await deliverEmail([managerEmail], subject, body, input.managerUserId);
  await upsertManagerInbox(db, input.managerUserId, {
    subject,
    body,
    fromName: input.cosignerName,
    fromEmail: input.cosignerEmail,
  });
}
