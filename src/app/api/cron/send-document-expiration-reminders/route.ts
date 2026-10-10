import { requireCronSecret } from "@/lib/cron-auth.server";
import { NextResponse } from "next/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { deliverPortalInboxMessage } from "@/lib/portal-inbox-delivery";
import { DOCUMENT_SELECT_COLUMNS, mapDocumentRow, type ManagerDocumentRow } from "@/lib/documents/manager-documents";
import { daysUntilExpiry } from "@/lib/documents/document-expiration";

export const runtime = "nodejs";

/** Daily cron: inbox reminder to each manager for library docs expiring within 30 days. */
export async function GET(req: Request) {
  if (!requireCronSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = createSupabaseServiceRoleClient();
  const now = new Date();
  const horizon = new Date(now);
  horizon.setUTCDate(horizon.getUTCDate() + 30);

  const { data, error } = await db
    .from("manager_documents")
    .select(DOCUMENT_SELECT_COLUMNS)
    .is("deleted_at", null)
    .not("expires_at", "is", null)
    .gte("expires_at", now.toISOString())
    .lte("expires_at", horizon.toISOString())
    .limit(2000);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  let sent = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const row of (data as ManagerDocumentRow[] | null) ?? []) {
    const doc = mapDocumentRow(row);
    const managerUserId = row.manager_user_id;
    const days = daysUntilExpiry(doc.expiresAt, now);
    if (!managerUserId || days === null || days < 0 || days > 30) {
      skipped++;
      continue;
    }

    const dedupId = `doc_expiry_reminder_${doc.id}_${doc.expiresAt?.slice(0, 10)}`;
    const { data: existing } = await db.from("portal_outbound_mail_records").select("id").eq("id", dedupId).maybeSingle();
    if (existing) {
      skipped++;
      continue;
    }

    const { data: profile } = await db
      .from("profiles")
      .select("email, full_name")
      .eq("id", managerUserId)
      .maybeSingle();

    const managerEmail = String(profile?.email ?? "").trim().toLowerCase();
    if (!managerEmail) {
      skipped++;
      continue;
    }

    const subject = `Document expiring soon: ${doc.displayName}`;
    const text = `"${doc.displayName}" expires in ${days} day${days === 1 ? "" : "s"}. Open Documents → Library to review or upload a renewal.`;

    const delivery = await deliverPortalInboxMessage(db, {
      senderUserId: managerUserId,
      senderEmail: managerEmail,
      fromName: "PropLane",
      subject,
      text,
      toUserIds: [managerUserId],
      // Inbox-only: this reminder fires DAILY per expiring doc — emailing daily
      // would spam the manager. The dashboard banner + library surface it too.
      deliverViaEmail: false,
      senderRole: "manager",
    });

    if (!delivery.ok) {
      errors.push(`${doc.id}: ${delivery.error}`);
      continue;
    }

    await db.from("portal_outbound_mail_records").upsert(
      {
        id: dedupId,
        recipient_email: managerEmail,
        subject,
        channel: "inbox",
        row_data: {
          id: dedupId,
          documentId: doc.id,
          expiresAt: doc.expiresAt,
          sentAt: new Date().toISOString(),
        },
      },
      { onConflict: "id" },
    );

    sent++;
  }

  return NextResponse.json({ ok: true, sent, skipped, errors: errors.length ? errors : undefined });
}
