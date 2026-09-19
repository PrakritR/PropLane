import "server-only";

import { captureSmsTestDelivery } from "@/lib/sms/sms-test-transport.server";
import { captureTestWorkspaceEffectForUser } from "@/lib/test-workspaces/effects.server";

type ResendEmailPayload = {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html?: string;
  reply_to?: string;
};

/**
 * Shared Resend provider boundary for agent-reachable email paths. In SMS test
 * mode it returns a provider-shaped success after recording delivery evidence;
 * all internal database mutations still run through their normal callers.
 */
type ResendDeliveryArgs = {
  apiKey: string;
  payload: ResendEmailPayload;
  effectSummary: string;
  metadata?: Record<string, string | number | boolean | null>;
  signal?: AbortSignal;
} & (
  | {
      /** Trusted actor/owner identity for ordinary portal and delayed-worker calls. */
      actorUserId: string;
      testWorkspaceAuthInvitation?: never;
    }
  | {
      /** Narrow exception used only after the operator invite helper re-verifies the new member. */
      actorUserId?: never;
      testWorkspaceAuthInvitation: true;
    }
);

export async function postResendEmail(args: ResendDeliveryArgs): Promise<Response> {
  if (captureSmsTestDelivery({
    kind: "email",
    summary: args.effectSummary,
    status: "captured",
    metadata: args.metadata,
  })) {
    return new Response(JSON.stringify({ id: "in_app_test" }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "X-PropLane-Sms-Test-Captured": "1",
      },
    });
  }
  if (args.actorUserId && (await captureTestWorkspaceEffectForUser({
    userId: args.actorUserId,
    kind: "email",
    summary: args.effectSummary,
    metadata: args.metadata,
  })).captured) {
    return new Response(JSON.stringify({ id: "test_workspace_captured" }), {
      status: 200,
      headers: { "Content-Type": "application/json", "X-PropLane-Test-Workspace-Captured": "1" },
    });
  }
  return fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${args.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(args.payload),
    signal: args.signal,
  });
}
