import "server-only";

/**
 * What happens automatically when a resident writes in (PLAN-0915 phase 3).
 *
 * 1. Emergency keywords ("flooding", "gas", "no heat"…) — the manager is
 *    told at once, quiet hours or not, and the resident is told it was flagged.
 * 2. After hours — the first message on a thread inside the manager's quiet
 *    window gets one acknowledgement saying when to expect a reply. Once per
 *    thread per night, so a back-and-forth never spams.
 *
 * Both are best-effort and deferred by the caller: the resident's message is
 * already delivered when this runs. Both are rows in Settings → Communication
 * → Messages sent automatically, so they can be switched off or reworded.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { emitActionEvent } from "@/lib/action-events.server";
import { inferMaintenancePriority } from "@/lib/claw-maintenance-detect";
import { loadReminderSettings } from "@/lib/reminders/settings.server";
import { isQuietHour, losAngelesHour } from "@/lib/reminders/rules";
import { deliverPortalInboxMessage } from "@/lib/portal-inbox-delivery";
import { loadAutomatedMessageSettings } from "@/lib/automated-messages-settings.server";
import { applyAutomatedMessageSetting } from "@/lib/automated-messages-settings";

function hourLabel(hour: number): string {
  return `${((hour + 11) % 12) + 1}:00 ${hour < 12 ? "AM" : "PM"}`;
}

export async function runInboundMessageAutomation(
  db: SupabaseClient,
  input: { managerUserId: string; residentEmail: string; residentUserId?: string | null; residentName: string; text: string; threadId?: string | null; now?: Date },
): Promise<void> {
  const now = input.now ?? new Date();
  const text = input.text.trim();
  if (!text || !input.managerUserId) return;
  const { data: manager } = await db.from("profiles").select("email, full_name, sms_from_number").eq("id", input.managerUserId).maybeSingle();
  const managerEmail = String(manager?.email ?? "").trim().toLowerCase();
  if (!managerEmail) return;
  const managerName = String(manager?.full_name ?? "").trim() || "Your property manager";
  const excerpt = text.length > 160 ? `${text.slice(0, 157)}…` : text;

  // 1. Emergency: bypasses quiet hours by being marked urgent on the bus.
  if (inferMaintenancePriority(text) === "Emergency") {
    await emitActionEvent(db, {
      eventId: `message:${input.managerUserId}:${input.residentEmail}:emergency:${now.toISOString().slice(0, 16)}`,
      domain: "message",
      event: "emergency_flagged",
      managerUserId: input.managerUserId,
      entityId: input.threadId ?? input.residentEmail,
      category: "maintenance",
      senderUserId: input.managerUserId,
      senderEmail: managerEmail,
      senderName: managerName,
      urgent: true,
      payload: { emergency: true },
      templateContext: { residentName: input.residentName, excerpt },
      recipients: [
        {
          audience: "manager",
          userId: input.managerUserId,
          rendered: { subject: `URGENT · ${input.residentName}`, text: `URGENT from ${input.residentName}: “${excerpt}”`, smsText: `URGENT from ${input.residentName}: “${excerpt}”` },
        },
        {
          audience: "resident",
          userId: input.residentUserId ?? undefined,
          email: input.residentEmail,
          rendered: { subject: "We flagged this as urgent", text: "We flagged this as urgent and alerted your property manager.", smsText: "We flagged this as urgent and alerted your property manager." },
        },
      ],
      now,
    }).catch(() => undefined);
    return;
  }

  // 2. After hours: one acknowledgement per thread per night.
  const settings = await loadReminderSettings(db, input.managerUserId).catch(() => null);
  if (!settings?.quietHours.enabled || !isQuietHour(settings.quietHours, losAngelesHour(now))) return;
  const automated = await loadAutomatedMessageSettings(db, input.managerUserId).catch(() => null);
  const resumeLabel = hourLabel(settings.quietHours.endHour);
  const emergencyPhone = String(manager?.sms_from_number ?? "").trim();
  const rendered = applyAutomatedMessageSetting(automated, {
    domain: "message",
    event: "after_hours_ack",
    audience: "resident",
    rendered: {
      subject: "Thanks — we’ll reply in the morning",
      text: `Thanks — we are offline until ${resumeLabel} and will reply then.${emergencyPhone ? ` Emergency? Call ${emergencyPhone}.` : ""}`,
    },
    context: { residentName: input.residentName, resumeLabel, emergencyPhone },
  });
  if (!rendered) return;
  const dayKey = now.toISOString().slice(0, 10);
  // Dedupe on the deterministic message id: a second inbound the same night is a no-op append.
  await deliverPortalInboxMessage(db, {
    senderUserId: input.managerUserId,
    senderEmail: managerEmail,
    fromName: managerName,
    subject: rendered.subject,
    text: rendered.text,
    ...(input.residentUserId ? { toUserIds: [input.residentUserId] } : { toEmails: [input.residentEmail] }),
    eventCategory: "messages",
    senderRole: "manager",
    messageId: `after-hours:${input.managerUserId}:${input.residentEmail}:${dayKey}`,
  }).catch(() => undefined);
}
