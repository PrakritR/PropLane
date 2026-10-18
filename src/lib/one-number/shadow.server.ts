import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutingDecision, SharedLineInbound } from "@/lib/one-number/contracts";
import { routeSharedLineInbound } from "@/lib/one-number/router.server";

/** Does the router's would-be decision match who really owned the text? Null when it cannot say. */
export function shadowAgreement(
  decision: RoutingDecision,
  actual: { ownerUserId: string | null; workspaceId: string | null },
): boolean | null {
  if (decision.kind === "unassigned") return false;
  if (decision.kind === "routed") {
    if (actual.workspaceId) return decision.workspaceId === actual.workspaceId;
    return actual.ownerUserId ? decision.ownerUserId === actual.ownerUserId : null;
  }
  // Ambiguous: it would have asked. Not a disagreement when the real workspace is one of the options.
  const inOptions = decision.candidates.some((c) =>
    actual.workspaceId ? c.workspaceId === actual.workspaceId : c.ownerUserId === actual.ownerUserId,
  );
  return inOptions ? null : false;
}

/**
 * Shadow mode: on a normal work-number inbound, ask the router what it WOULD
 * have decided (read-only: no session write, no lead) and store it next to the
 * real owner. This must never change the real path, so it never throws and is
 * meant to run after the response (`after()`).
 */
export async function recordShadowDecision(
  db: SupabaseClient,
  input: {
    inbound: SharedLineInbound;
    actualOwnerUserId: string | null;
    actualWorkspaceId: string | null;
  },
): Promise<{ recorded: boolean }> {
  try {
    const decision = await routeSharedLineInbound(db, input.inbound, null, { dryRun: true });
    const { error } = await db.from("sms_line_shadow_decisions").upsert(
      {
        message_sid: input.inbound.messageSid,
        phone_key: input.inbound.phoneKey,
        decision,
        actual_owner_user_id: input.actualOwnerUserId,
        actual_workspace_id: input.actualWorkspaceId,
        agrees: shadowAgreement(decision, { ownerUserId: input.actualOwnerUserId, workspaceId: input.actualWorkspaceId }),
      },
      { onConflict: "message_sid", ignoreDuplicates: true },
    );
    return { recorded: !error };
  } catch (error) {
    console.error("shared line shadow decision failed", error instanceof Error ? error.name : "unknown");
    return { recorded: false };
  }
}
