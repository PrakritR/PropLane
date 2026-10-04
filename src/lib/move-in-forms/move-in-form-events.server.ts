import "server-only";

/**
 * Move-in form moments on the action-event bus (docs/agents/automated-communication.md).
 *
 *  - `sent`      resident hears a form is waiting (as the manager).
 *  - `reminder`  resident is nudged by the manager (as the manager, so it lands from the
 *                work inbox the way every cross-party copy does).
 *  - `submitted` manager hears the resident finished (an Assistant notice; the property's
 *                "Tell me when a resident submits" choice may add an email, see
 *                `emailManagerOfMoveInFormSubmission`).
 *
 * All three are best-effort callers' business: the row is already saved before any of these run.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { emitActionEvent, type ActionEventAudience } from "@/lib/action-events.server";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { sharedPortalFromAddress } from "@/lib/manager-outbound-identity.server";
import { shouldSkipOutboundEmail } from "@/lib/portal-sandbox-accounts";
import { postResendEmail } from "@/lib/resend-delivery.server";

export type MoveInFormEvent = "sent" | "reminder" | "submitted";
type EventRow = {
  id: string;
  manager_user_id: string;
  property_id: string;
  property_label: string;
  room_label: string;
  resident_name: string;
  resident_email: string;
  resident_user_id: string | null;
  form_name: string;
  due_at: string | null;
};

function dueLabel(dueAt: string | null): string {
  if (!dueAt) return "";
  const date = new Date(dueAt);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Los_Angeles" });
}

export function renderMoveInFormEvent(
  event: MoveInFormEvent,
  audience: ActionEventAudience,
  facts: { residentName: string; formName: string; placeLabel: string; dueLabel: string },
): { subject: string; text: string; smsText: string } | null {
  const resident = facts.residentName.trim() || "The resident";
  const form = facts.formName.trim() || "move-in form";
  const at = facts.placeLabel.trim() ? ` for ${facts.placeLabel.trim()}` : "";
  const due = facts.dueLabel ? ` Please finish it by ${facts.dueLabel}.` : "";
  let text: string | null = null;
  if (event === "submitted" && audience === "manager") text = `${resident} submitted the ${form}${at}. Review it in Move-in.`;
  if (event === "sent" && audience === "resident") text = `Your property manager sent you a form to complete before you move in: ${form}${at}.${due}`;
  if (event === "reminder" && audience === "resident") text = `Reminder: your ${form}${at} is still waiting for you.${due}`;
  return text ? { subject: event === "submitted" ? `${resident} · ${form}` : form, text, smsText: text } : null;
}

async function managerSender(db: SupabaseClient, managerUserId: string) {
  const { data } = await db.from("profiles").select("email, full_name").eq("id", managerUserId).maybeSingle();
  return {
    userId: managerUserId,
    email: String(data?.email ?? "").trim().toLowerCase(),
    name: String(data?.full_name ?? "").trim() || undefined,
  };
}

export async function emitMoveInFormEvent(
  db: SupabaseClient,
  input: {
    row: EventRow;
    event: MoveInFormEvent;
    /** Distinguishes repeated reminders; ignored for the one-shot events. */
    nonce?: string;
  },
): Promise<void> {
  const { row, event } = input;
  const facts = {
    residentName: row.resident_name,
    formName: row.form_name,
    placeLabel: [row.property_label, row.room_label].filter(Boolean).join(" · "),
    dueLabel: dueLabel(row.due_at),
  };
  // The manager is always the sender. For `submitted` that makes the manager's copy an Assistant
  // notice (the bus never self-sends a manager their own event), which is what "Assistant notice"
  // promises: no email unless the property also asks for one.
  const sender = await managerSender(db, row.manager_user_id);
  if (!sender?.email) return;
  const base = resolveEmailLinkBaseUrl().replace(/\/$/, "");
  const recipient = event === "submitted"
    ? { audience: "manager" as const, userId: row.manager_user_id }
    : { audience: "resident" as const, userId: row.resident_user_id ?? undefined, email: row.resident_email || undefined };
  const rendered = renderMoveInFormEvent(event, recipient.audience, facts);
  if (!rendered) return;
  // The resident lands on the Forms tab itself (My home › Forms), the one tab open before a lease is signed.
  const link = `${base}/${recipient.audience === "manager" ? "portal/move-in" : "resident/move-in/forms"}`;
  await emitActionEvent(db, {
    eventId: `${row.id}:${event}${event === "reminder" ? `:${input.nonce ?? Date.now()}` : ""}`,
    domain: "move_in_form",
    event,
    managerUserId: row.manager_user_id,
    entityId: row.id,
    category: "leases",
    senderUserId: sender.userId,
    senderEmail: sender.email,
    senderName: sender.name,
    payload: { propertyId: row.property_id },
    templateContext: { residentName: facts.residentName, formName: facts.formName, propertyTitle: facts.placeLabel, url: link },
    recipients: [{ ...recipient, rendered: { ...rendered, text: `${rendered.text}\n\n${link}` } }],
  });
}

/**
 * The "Assistant notice and email" choice: the same news, also in the manager's mailbox. Sent from
 * the shared PropLane sender to the manager's own profile email (alerts to a manager never leave
 * on a work address). Best-effort and called once per submission, after the row is saved.
 */
export async function emailManagerOfMoveInFormSubmission(
  db: SupabaseClient,
  row: EventRow,
): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) return false;
  const { data } = await db.from("profiles").select("email").eq("id", row.manager_user_id).maybeSingle();
  const to = String(data?.email ?? "").trim().toLowerCase();
  if (!to.includes("@") || shouldSkipOutboundEmail(to)) return false;
  const rendered = renderMoveInFormEvent("submitted", "manager", {
    residentName: row.resident_name,
    formName: row.form_name,
    placeLabel: [row.property_label, row.room_label].filter(Boolean).join(" · "),
    dueLabel: "",
  });
  if (!rendered) return false;
  const link = `${resolveEmailLinkBaseUrl().replace(/\/$/, "")}/portal/move-in`;
  const text = `${rendered.text}\n\n${link}`;
  // Quotes too: this value also lands inside an `href="…"`, where an unescaped double quote would
  // close the attribute and let the rest of it become new markup.
  const escape = (value: string) =>
    value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  const response = await postResendEmail({
    apiKey,
    actorUserId: row.manager_user_id,
    payload: {
      from: sharedPortalFromAddress(),
      to: [to],
      subject: rendered.subject,
      text,
      html: `<p>${escape(rendered.text)}</p><p><a href="${escape(link)}">Open Move-in</a></p>`,
    },
    effectSummary: "Move-in form submission email captured for the test workspace.",
    metadata: { formRecordId: row.id },
  });
  return response.ok;
}
