import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { postResendEmail } from "@/lib/resend-delivery.server";

/**
 * Narrow auth-only delivery after the account has durable workspace
 * classification. This is not a general business-message bypass.
 */
export async function deliverTestWorkspaceAuthInvitation(args: {
  db: SupabaseClient;
  workspaceId: string;
  userId: string;
  email: string;
  inviteUrl: string;
}): Promise<boolean> {
  const [{ data: member, error: memberError }, { data: profile, error: profileError }] = await Promise.all([
    args.db.from("test_workspace_members").select("id").eq("workspace_id", args.workspaceId).eq("user_id", args.userId).maybeSingle(),
    args.db.from("profiles").select("email").eq("id", args.userId).maybeSingle(),
  ]);
  if (memberError || profileError || !member || profile?.email?.trim().toLowerCase() !== args.email.trim().toLowerCase()) {
    return false;
  }
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) return false;
  const safeUrl = args.inviteUrl.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
  const response = await postResendEmail({
    apiKey,
    effectSummary: "Test workspace account invitation",
    metadata: { authInvitation: true },
    testWorkspaceAuthInvitation: true,
    payload: {
      from: process.env.RESEND_FROM?.trim() || "PropLane <onboarding@resend.dev>",
      to: [args.email],
      subject: "Your private PropLane test account",
      text: `You were invited to a private PropLane test workspace. Set up your account: ${args.inviteUrl}`,
      html: `<p>You were invited to a private PropLane test workspace.</p><p><a href="${safeUrl}">Set up your account</a></p>`,
    },
  });
  return response.ok;
}
