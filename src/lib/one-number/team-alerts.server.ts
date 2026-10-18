import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { notifyPropertyScopedManagersFromAgent } from "@/lib/co-manager-notification-recipients.server";

export type TeamAlertKind = "human_request" | "emergency" | "new_lead" | "unanswered" | "vendor_approval";

const SUBJECT: Record<TeamAlertKind, string> = {
  human_request: "Human requested",
  emergency: "Emergency text",
  new_lead: "New lead",
  unanswered: "Unanswered question",
  vendor_approval: "Vendor approval",
};

export type TeamAlertInput = {
  workspaceId: string;
  /** The workspace owner. Must be the real owner of `workspaceId`, or nothing is sent. */
  ownerUserId: string;
  kind: TeamAlertKind;
  /** One short plain fact line. Goes to this workspace's people only. */
  text: string;
  urgent: boolean;
  /** The house the alert is about, when known: narrows who is told to the people who hold it. */
  propertyId?: string | null;
  /** Stable per event (e.g. the inbound MessageSid) so a webhook retry alerts once. */
  idempotencyKey?: string;
};

export type TeamAlertResult = { sent: boolean; reason?: "workspace_mismatch" | "failed" };

/**
 * Tell ONE workspace's team about something on the shared line. This is the
 * existing notice spine (`notifyPropertyScopedManagersFromAgent`): the owner's
 * Assistant notice (text + email), the owner's "also notify" numbers
 * (`workspace_work_number_recipients`), one Team chat line, and, when `urgent`,
 * each teammate who holds the house. It is pinned to `workspaceId`, so the
 * owner's other workspaces and every other team are never involved. The
 * workspace and its owner are re-checked here: a mismatched pair sends nothing.
 */
export async function alertWorkspaceTeam(db: SupabaseClient, input: TeamAlertInput): Promise<TeamAlertResult> {
  const workspaceId = input.workspaceId.trim();
  const ownerUserId = input.ownerUserId.trim();
  const text = input.text.replace(/\s+/g, " ").trim();
  if (!workspaceId || !ownerUserId || !text) return { sent: false, reason: "failed" };

  try {
    const { data, error } = await db
      .from("portal_workspaces")
      .select("id, owner_user_id")
      .eq("id", workspaceId)
      .maybeSingle();
    const owner = String((data as { owner_user_id?: unknown } | null)?.owner_user_id ?? "");
    if (error || owner !== ownerUserId) return { sent: false, reason: "workspace_mismatch" };

    const key =
      input.idempotencyKey?.trim() ||
      `one-number-alert:${input.kind}:${workspaceId}:${createHash("sha256").update(text).digest("hex").slice(0, 12)}:${Math.floor(Date.now() / 60_000)}`;
    const urgent = input.urgent || input.kind === "emergency";
    const subject = SUBJECT[input.kind];
    await notifyPropertyScopedManagersFromAgent(db, {
      ownerManagerUserId: ownerUserId,
      workspaceId,
      propertyId: input.propertyId ?? null,
      module: "inbox",
      subject,
      text,
      category: "messages",
      idempotencyKey: `${key}:${input.kind}`,
      urgent,
      eventLabel: subject,
      teamNotice: { text: `${urgent ? "Emergency · " : ""}${subject} · ${text}`.slice(0, 500), messageId: `${key}:team` },
    });
    return { sent: true };
  } catch (error) {
    // Masked: neither a number nor the body reaches a log.
    console.error("shared line team alert failed", input.kind, error instanceof Error ? error.name : "unknown");
    return { sent: false, reason: "failed" };
  }
}
