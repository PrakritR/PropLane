import { NextResponse } from "next/server";
import {
  legacyPaymentReminderDedupIds,
  paymentReminderDedupId,
} from "@/lib/payment-automation-settings";
import {
  combineScheduledPaymentMessages,
  parseCombinedScheduledMessageListId,
  scheduledPaymentMessageChargeIds,
} from "@/lib/combined-payment-reminders";
import {
  loadManagerPendingCharges,
  loadManagerScheduledMessages,
  parseScheduledMessageListId,
} from "@/lib/payment-automation-server";
import { decodeScheduledMessagePathId } from "@/lib/scheduled-message-path-id";
import { deliverPaymentReminder, reminderHtmlFromText } from "@/lib/payment-reminder-delivery";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

async function requireManager() {
  const supabaseAuth = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabaseAuth.auth.getUser();
  if (!user?.id) return null;

  const db = createSupabaseServiceRoleClient();
  const [{ data: profile }, { data: roles }] = await Promise.all([
    db.from("profiles").select("role").eq("id", user.id).maybeSingle(),
    db.from("profile_roles").select("role").eq("user_id", user.id),
  ]);
  const roleList = (roles ?? []).map((r) => String(r.role).toLowerCase());
  const legacy = String(profile?.role ?? user.user_metadata?.role ?? "").toLowerCase();
  const isManager = roleList.includes("manager") || legacy === "manager" || legacy === "admin";
  if (!isManager) return null;
  return { db, userId: user.id };
}

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireManager();
    if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const { id: rawId } = await ctx.params;
    const decodedId = decodeScheduledMessagePathId(rawId);
    const bundled = parseCombinedScheduledMessageListId(decodedId);
    const parsed = bundled ? null : parseScheduledMessageListId(decodedId);
    if (!bundled && !parsed) {
      return NextResponse.json({ error: "Invalid scheduled message id." }, { status: 400 });
    }

    const { messages } = await loadManagerScheduledMessages(auth.db, auth.userId, { includeHidden: true });
    const displayMessages = combineScheduledPaymentMessages(messages);
    const message = displayMessages.find((m) => m.id === decodedId);
    if (!message) {
      return NextResponse.json({ error: "Scheduled message not found." }, { status: 404 });
    }
    if (message.status !== "scheduled") {
      return NextResponse.json({ error: "Only scheduled messages can be sent now." }, { status: 400 });
    }
    if (message.kind === "late_fee") {
      return NextResponse.json({ error: "Late fee notices cannot be sent from the schedule view." }, { status: 400 });
    }

    const charges = await loadManagerPendingCharges(auth.db, auth.userId);
    const chargeIds = scheduledPaymentMessageChargeIds(message);
    const outstanding = chargeIds
      .map((id) => charges.find((c) => c.id === id))
      .filter((c): c is NonNullable<typeof c> => Boolean(c));
    if (!outstanding.length) {
      return NextResponse.json({ error: "Charge no longer outstanding." }, { status: 400 });
    }
    const charge = outstanding[0]!;

    const { data: profile } = await auth.db
      .from("profiles")
      .select("full_name, email, sms_from_number")
      .eq("id", auth.userId)
      .maybeSingle();
    const managerName = profile?.full_name?.trim() || profile?.email?.trim() || "Your property manager";
    const managerSmsFromNumber = String(profile?.sms_from_number ?? "").trim();
    const apiKey = process.env.RESEND_API_KEY?.trim() ?? "";
    const from = process.env.RESEND_FROM?.trim() || "PropLane <onboarding@resend.dev>";
    const todayKey = new Date().toISOString().slice(0, 10);

    const dedupIds = chargeIds.flatMap((chargeId) => {
      const dedupCandidates = legacyPaymentReminderDedupIds({
        kind: message.kind,
        chargeId,
        daysBeforeDue: message.daysBeforeDue ?? undefined,
      });
      return message.kind === "overdue_daily"
        ? [paymentReminderDedupId({ kind: "overdue_daily", chargeId, todayKey })]
        : dedupCandidates;
    });

    const result = await deliverPaymentReminder({
      db: auth.db,
      charge,
      managerId: auth.userId,
      dedupId: dedupIds[0]!,
      bundledDedupEntries: dedupIds.slice(1).map((dedupId, index) => ({
        dedupId,
        chargeId: chargeIds[index + 1]!,
      })),
      managerName,
      managerSmsFromNumber,
      apiKey,
      from,
      subject: message.subject,
      text: message.body,
      html: reminderHtmlFromText(message.body),
      slotLabel: message.typeLabel,
      skipManualPaymentInstructions: chargeIds.length > 1,
    });

    if (!result.sent) {
      return NextResponse.json({ error: result.error ?? "Could not send reminder." }, { status: 400 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
