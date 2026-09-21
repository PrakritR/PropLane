import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  captureSmsTestDelivery,
  type SmsTestCapturedEffect,
} from "@/lib/sms/sms-test-transport.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveTestWorkspaceClassification } from "@/lib/test-workspaces/index.server";

type EffectKind = SmsTestCapturedEffect["kind"] | "payment" | "provisioning";

/** A provider operation was deliberately refused for a durable test identity. */
export class TestWorkspaceProviderDisabledError extends Error {
  constructor() {
    super("This provider operation is unavailable for test accounts.");
  }
}

/**
 * Last server-side guard before an external effect. Classification is checked
 * even when the feature switch is off or membership is suspended: those states
 * revoke access, but can never turn a dedicated test identity into a customer.
 *
 * An SMS test turn records evidence in its request-local result. Ordinary
 * portal routes and delayed workers have no chat session, so they retain the
 * same evidence in audit_log instead of inventing a fake conversation.
 */
export async function captureTestWorkspaceEffectForUser(args: {
  userId: string;
  kind: EffectKind;
  summary: string;
  metadata?: Record<string, string | number | boolean | null>;
  db?: SupabaseClient;
}): Promise<{ captured: false } | { captured: true; workspaceId: string }> {
  const db = args.db ?? createSupabaseServiceRoleClient();
  const classification = await resolveTestWorkspaceClassification(args.userId, db);
  if (classification.kind === "normal") return { captured: false };

  const effect: SmsTestCapturedEffect = {
    kind: args.kind === "payment" || args.kind === "provisioning" ? "webhook" : args.kind,
    status: args.kind === "payment" || args.kind === "provisioning" ? "refused" : "captured",
    summary: args.summary,
    metadata: {
      ...(args.metadata ?? {}),
      workspaceEffectKind: args.kind,
    },
    workspaceId: classification.workspaceId,
  };
  const recordedInTurn = captureSmsTestDelivery(effect);
  if (!recordedInTurn) {
    const { error } = await db.from("audit_log").insert({
      landlord_id: args.userId,
      actor_user_id: args.userId,
      action: "test_workspace_effect_captured",
      tool_name: "test_workspace_effect_boundary",
      input_summary: { kind: args.kind },
      result_summary: { outcome: effect.status, summary: args.summary },
      test_workspace_id: classification.workspaceId,
    });
    if (error) throw new Error("Could not retain test workspace effect evidence.");
  }
  return { captured: true, workspaceId: classification.workspaceId };
}

/**
 * Last boundary before an ordinary external provider call. This is independent
 * of request-local SMS state, so OAuth callbacks and delayed workers cannot
 * turn classified accounts into customer-provider callers.
 */
export async function assertTestWorkspaceProviderEffectAllowed(args: {
  userId: string;
  kind: EffectKind;
  summary: string;
  metadata?: Record<string, string | number | boolean | null>;
  db?: SupabaseClient;
}): Promise<void> {
  if (await captureTestWorkspaceEffectForUser(args).then((result) => result.captured)) {
    throw new TestWorkspaceProviderDisabledError();
  }
}
