import "server-only";

/**
 * Inspection submissions on the action-event bus (PLAN-0915 phase 2).
 *
 * A report has two sides. When the resident submits theirs the manager is
 * told; when the manager reopens it the resident is told to add what is
 * missing. There is no scheduled time and no locked state in this product
 * (see `inspections/model.ts`), so these two are the whole lifecycle.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { emitActionEvent, type ActionEventAudience } from "@/lib/action-events.server";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import type { InspectionRecord } from "@/lib/inspections/model";

export function renderInspectionEvent(
  event: "submitted" | "reopened",
  audience: ActionEventAudience,
  facts: { residentName: string; propertyLabel: string; kind: string },
): { subject: string; text: string; smsText: string } | null {
  const resident = facts.residentName.trim() || "The resident";
  const kind = facts.kind === "move_out" ? "move-out" : "move-in";
  const at = facts.propertyLabel.trim() ? ` for ${facts.propertyLabel.trim()}` : "";
  let text: string | null = null;
  if (event === "submitted" && audience === "manager") text = `${resident} submitted their ${kind} photos${at}. Review them in Inspections.`;
  if (event === "reopened" && audience === "resident") text = `Your ${kind} report${at} was reopened by your property manager. Add anything that is missing.`;
  return text ? { subject: `${resident} · ${kind} inspection`, text, smsText: text } : null;
}

export async function emitInspectionSubmission(
  db: SupabaseClient,
  input: { report: InspectionRecord; submitted: boolean; actor: { userId: string; email: string; name?: string } },
): Promise<void> {
  const event = input.submitted ? "submitted" : "reopened";
  const facts = { residentName: input.report.resident_name, propertyLabel: [input.report.property_label, input.report.room_label].filter(Boolean).join(" · "), kind: input.report.kind };
  const base = resolveEmailLinkBaseUrl().replace(/\/$/, "");
  const recipients =
    event === "submitted"
      ? [{ audience: "manager" as const, userId: input.report.manager_user_id }]
      : [{ audience: "resident" as const, userId: input.report.resident_user_id ?? undefined, email: input.report.resident_email || undefined }];
  await emitActionEvent(db, {
    eventId: `${input.report.id}:${event}:${input.report.revision}`,
    domain: "inspection",
    event,
    managerUserId: input.report.manager_user_id,
    entityId: input.report.id,
    category: "leases",
    senderUserId: input.actor.userId,
    senderEmail: input.actor.email,
    senderName: input.actor.name,
    payload: { kind: input.report.kind, propertyId: input.report.property_id },
    templateContext: { residentName: facts.residentName, propertyTitle: facts.propertyLabel, kind: facts.kind, url: `${base}/${event === "submitted" ? "portal" : "resident"}/inspections` },
    recipients: recipients.flatMap((recipient) => {
      const rendered = renderInspectionEvent(event, recipient.audience, facts);
      return rendered ? [{ ...recipient, rendered: { ...rendered, text: `${rendered.text}\n\n${base}/${recipient.audience === "manager" ? "portal" : "resident"}/inspections` } }] : [];
    }),
  });
}
