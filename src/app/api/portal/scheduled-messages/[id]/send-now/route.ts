import { NextResponse } from "next/server";
import {
  combineScheduledPaymentMessages,
  parseCombinedScheduledMessageListId,
  paymentReminderDedupPlan,
  scheduledPaymentMessageChargeIds,
} from "@/lib/combined-payment-reminders";
import {
  loadManagerPendingCharges,
  loadManagerScheduledMessages,
  parseScheduledMessageListId,
} from "@/lib/payment-automation-server";
import { loadManagerAutomationSettings } from "@/lib/payment-automation-settings";
import { decodeScheduledMessagePathId } from "@/lib/scheduled-message-path-id";
import { deliverPaymentReminder, reminderHtmlFromText } from "@/lib/payment-reminder-delivery";
import { managerOutboundFromHeader } from "@/lib/manager-outbound-identity.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import {
  loadPaymentReminderChargeForActor,
  resolvePaymentReminderCapability,
} from "@/lib/payment-reminder-capability.server";
import { paymentReminderSnapshotMatches } from "@/lib/payment-reminder-workspace";

export const runtime = "nodejs";

async function requireManager() {
  const supabaseAuth = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabaseAuth.auth.getUser();
  if (!user?.id) return null;

  const db = createSupabaseServiceRoleClient();
  const { data: roles } = await db.from("profile_roles").select("role").eq("user_id", user.id);
  const roleList = (roles ?? []).map((r) => String(r.role).toLowerCase());
  const isManager = roleList.includes("manager") || roleList.includes("admin");
  if (!isManager) return null;
  return { db, userId: user.id, admin: roleList.includes("admin") };
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

    const chargeIdsInPath = bundled?.chargeIds ?? (parsed ? [parsed.chargeId] : []);
    const contexts = await Promise.all(chargeIdsInPath.map((chargeId) =>
      loadPaymentReminderChargeForActor(auth.db, auth.userId, chargeId, auth.admin),
    ));
    if (!contexts.length || contexts.some((context) => !context)) {
      return NextResponse.json({ error: "Scheduled message not found." }, { status: 404 });
    }
    const ownerUserId = contexts[0]!.ownerUserId;
    if (contexts.some((context) => context!.ownerUserId !== ownerUserId)) {
      return NextResponse.json({ error: "Scheduled message cannot span workspaces." }, { status: 409 });
    }

    const { messages } = await loadManagerScheduledMessages(auth.db, ownerUserId, { includeHidden: true });
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

    const charges = await loadManagerPendingCharges(auth.db, ownerUserId);
    const chargeIds = scheduledPaymentMessageChargeIds(message);
    const outstanding = chargeIds
      .map((id) => charges.find((c) => c.id === id))
      .filter((c): c is NonNullable<typeof c> => Boolean(c));
    if (outstanding.length !== chargeIds.length) {
      return NextResponse.json({ error: "The charge balance changed. Refresh this reminder before sending." }, { status: 409 });
    }
    const charge = outstanding[0]!;

    const automationSettings = await loadManagerAutomationSettings(auth.db, ownerUserId);
    const deliverViaEmail = message.deliverViaEmail ?? automationSettings.paymentReminderDeliverViaEmail;
    const deliverViaSms = message.deliverViaSms ?? automationSettings.paymentReminderDeliverViaSms;
    let managerSmsFromNumber = "";
    if (deliverViaEmail || deliverViaSms) {
      for (const context of contexts) {
        const capability = await resolvePaymentReminderCapability(auth.db, context!);
        if (deliverViaEmail && !capability.email.available) {
          return NextResponse.json({ error: capability.email.reason ?? "Email is unavailable for this resident." }, { status: 409 });
        }
        if (deliverViaSms && !capability.sms.available) {
          return NextResponse.json({ error: capability.sms.reason ?? "Text delivery is unavailable for this resident." }, { status: 409 });
        }
        if (deliverViaSms) managerSmsFromNumber = capability.sms.fromNumber ?? "";
      }
    }

    const { data: profile } = await auth.db
      .from("profiles")
      .select("full_name, email")
      .eq("id", ownerUserId)
      .maybeSingle();
    const managerName = profile?.full_name?.trim() || profile?.email?.trim() || "Your property manager";
    const apiKey = process.env.RESEND_API_KEY?.trim() ?? "";
    const from = await managerOutboundFromHeader(auth.db, auth.userId);
    const todayKey = new Date().toISOString().slice(0, 10);

    const dedupPlan = paymentReminderDedupPlan({
      kind: message.kind,
      daysBeforeDue: message.daysBeforeDue,
      chargeIds,
      primaryChargeId: charge.id,
      todayKey,
    });
    if (!dedupPlan) {
      return NextResponse.json({ error: "Could not send reminder." }, { status: 400 });
    }

    const current = await Promise.all(chargeIds.map((id) =>
      loadPaymentReminderChargeForActor(auth.db, auth.userId, id, auth.admin),
    ));
    if (current.some((context, index) =>
      !context || context.ownerUserId !== ownerUserId ||
      !paymentReminderSnapshotMatches(outstanding[index]!, context.charge),
    )) {
      return NextResponse.json({ error: "The charge balance changed. Refresh this reminder before sending." }, { status: 409 });
    }

    const result = await deliverPaymentReminder({
      db: auth.db,
      charge: current[0]!.charge,
      managerId: ownerUserId,
      dedupId: dedupPlan.dedupId,
      bundledDedupEntries: dedupPlan.bundledDedupEntries,
      managerName,
      managerSmsFromNumber,
      apiKey,
      from,
      subject: message.subject,
      text: message.body,
      html: reminderHtmlFromText(message.body),
      slotLabel: message.typeLabel,
      managerDeliverViaEmail: message.deliverViaEmail ?? automationSettings.paymentReminderDeliverViaEmail,
      managerDeliverViaSms: message.deliverViaSms ?? automationSettings.paymentReminderDeliverViaSms,
      managerDeliverViaInbox: automationSettings.paymentReminderDeliverViaInbox,
    });

    if (!result.sent) {
      // These are internal reason codes, not copy — a manager shown the literal
      // "no_channel_enabled" learns nothing and cannot act on it.
      const REASON_MESSAGES: Record<string, string> = {
        no_channel_enabled:
          "No delivery channel is switched on for payment reminders. Turn on PropLane, email or SMS in Settings.",
        no_channel_delivered: "The reminder could not be delivered on any channel. Please try again.",
        email_failed_no_other_channel:
          "The email could not be sent, and no other channel is available for this resident.",
        charge_paid: "That charge has already been paid.",
      };
      const reason = result.error ?? "";
      return NextResponse.json(
        { error: REASON_MESSAGES[reason] ?? "Could not send reminder." },
        { status: 400 },
      );
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
