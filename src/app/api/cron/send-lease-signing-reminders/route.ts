import { NextResponse } from "next/server";
import { isProductionRuntime } from "@/lib/server-env";
import { canSendResidentOutboundSms, sendResidentOutboundSms } from "@/lib/resident-outbound-sms.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { residentPortalUrl } from "@/lib/claw-resident-links";
import { hasSmsTestProvenance } from "@/lib/sms/sms-test-provenance";

export const runtime = "nodejs";

/**
 * Daily lease-signing SMS reminders for leases waiting on the resident signature.
 * Uses the shared Claw agent line and opens a durable two-way thread.
 */

function isAuthorized(req: Request): boolean {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret) return !isProductionRuntime();
  return req.headers.get("authorization") === `Bearer ${cronSecret}`;
}

function needsResidentSignature(status: string): boolean {
  const s = status.trim().toLowerCase();
  if (!s) return false;
  if (s.includes("fully signed") || s.includes("complete") || s.includes("void")) return false;
  return (
    s.includes("resident signature") ||
    s.includes("awaiting resident") ||
    s.includes("resident pending") ||
    s === "sent for signing" ||
    s.includes("signature pending")
  );
}

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = createSupabaseServiceRoleClient();
  const todayKey = new Date().toISOString().slice(0, 10);
  const leaseUrl = residentPortalUrl("lease");

  const { data: leases, error } = await db
    .from("portal_lease_pipeline_records")
    .select("id, manager_user_id, resident_email, row_data")
    .limit(2000);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  let considered = 0;
  let sent = 0;
  const errors: string[] = [];

  for (const row of leases ?? []) {
    const managerUserId = String(row.manager_user_id ?? "").trim();
    const lease = (row.row_data ?? {}) as Record<string, unknown>;
    if (hasSmsTestProvenance(lease)) continue;
    const status = String(lease.status ?? "");
    if (!managerUserId || !needsResidentSignature(status)) continue;
    considered += 1;

    const residentEmail = String(row.resident_email ?? lease.residentEmail ?? lease.email ?? "")
      .trim()
      .toLowerCase();
    const residentName =
      String(lease.residentName ?? lease.name ?? "Resident").trim() || "Resident";
    if (!residentEmail.includes("@")) continue;

    const leaseId = String(row.id ?? lease.id ?? "").trim();
    if (!leaseId) continue;

    // Cadence: at most one text every 3 days, capped at 5 reminders per lease —
    // a lease parked in "sent for signing" must not text the resident forever.
    const dedupPrefix = `lease_signing_sms_${leaseId}_`;
    const { data: priorRows } = await db
      .from("portal_outbound_mail_records")
      .select("id")
      .like("id", `${dedupPrefix}%`)
      .order("id", { ascending: false })
      .limit(10);
    const prior = priorRows ?? [];
    if (prior.length >= 5) continue;
    const lastDateKey = String(prior[0]?.id ?? "").slice(dedupPrefix.length);
    const lastTs = Date.parse(lastDateKey);
    if (Number.isFinite(lastTs) && Date.now() - lastTs < 3 * 24 * 60 * 60 * 1000) continue;
    const dedupId = `${dedupPrefix}${todayKey}`;

    const { data: managerProfile } = await db
      .from("profiles")
      .select("sms_from_number, full_name, email")
      .eq("id", managerUserId)
      .maybeSingle();
    const smsFromNumber = String(managerProfile?.sms_from_number ?? "").trim();
    if (!canSendResidentOutboundSms(smsFromNumber)) continue;

    const { data: residentProfile } = await db
      .from("profiles")
      .select("id, phone")
      .eq("email", residentEmail)
      .maybeSingle();
    const residentPhone = String(residentProfile?.phone ?? "").trim();
    const residentUserId = String(residentProfile?.id ?? "").trim() || null;
    if (!residentPhone) continue;

    const managerName =
      String(managerProfile?.full_name ?? "").trim() ||
      String(managerProfile?.email ?? "").trim() ||
      "Your property manager";
    const propertyLabel = String(lease.propertyLabel ?? lease.property ?? "").trim();
    const smsBody = [
      `(Lease signing)`,
      `Hi ${residentName}, your lease${propertyLabel ? ` for ${propertyLabel}` : ""} is ready to sign.`,
      `Open: ${leaseUrl}`,
      `Reply here with questions — ${managerName}`,
    ].join("\n");

    const result = await sendResidentOutboundSms({
      to: residentPhone,
      text: smsBody,
      fromNumber: smsFromNumber,
      linkKind: null, // URL already in body
      openThread: {
        managerUserId,
        residentUserId,
        residentEmail,
        topic: "lease",
      },
    });

    if (!result.sent) {
      errors.push(`${residentEmail}: ${result.error ?? "send_failed"}`);
      continue;
    }

    await db.from("portal_outbound_mail_records").upsert(
      {
        id: dedupId,
        recipient_email: residentEmail,
        subject: "Lease signing reminder",
        channel: "sms",
        row_data: {
          id: dedupId,
          to: residentPhone,
          subject: "Lease signing reminder",
          body: smsBody,
          sentAt: new Date().toISOString(),
          smsSent: true,
          smsChannel: result.channel ?? null,
          leaseId,
        },
      },
      { onConflict: "id" },
    );
    sent += 1;
  }

  return NextResponse.json({ ok: true, considered, sent, errors: errors.slice(0, 20) });
}
