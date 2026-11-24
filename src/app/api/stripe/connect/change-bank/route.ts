import { NextResponse } from "next/server";
import { assertCoManagerBankAccountAccess } from "@/lib/auth/co-manager-bank-account-access";
import {
  resolveStripePayoutContext,
  stripePayoutContextStatus,
  stripePayoutContextError,
} from "@/lib/auth/manager-stripe-payout-access.server";
import { resolveAppOrigin } from "@/lib/app-url";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";
import {
  activeWorkspaceIdFromCookie,
  resolveManagedPayoutStaffContext,
  sendOwnerPayoutSetupLink,
} from "@/lib/managed-finance/payout-setup.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { getStripe } from "@/lib/stripe";
import { resolveManagerConnectAccountId } from "@/lib/stripe-connect";
import {
  bankChangeAccountLinkParams,
  bankChangeErrorMessage,
  planBankChange,
  type BankChangeResponse,
} from "@/lib/stripe-connect-bank-change";
import { assertOwnedPayoutAccount } from "@/lib/stripe-external-accounts.server";

export const runtime = "nodejs";

/**
 * Change the bank the signed-in owner is paid to — the ACCOUNT HOLDER only.
 *
 * Application-collected accounts answer `{ mode: "in_app" }` and the client opens PropLane's own add-bank sheet. A
 * legacy Express account answers `{ mode: "redirect", url }`: Stripe's own hosted page (Express dashboard login link,
 * else an Account Link) where the person changes the external account, returning to Payout method. The owner is
 * re-derived from the session; nothing in the body picks an account, and PropLane staff in a managed workspace
 * resolve to no payout account at all (`staff_managed_workspace`). Only the redirect URL leaves the server: no bank
 * number is read or stored here. Every failure is a real message with a status, never an empty body.
 *
 * Nobody but the owner gets past the gate below, co-manager bank-account grant or not. An Express dashboard login
 * link is a sign-in to the owner's WHOLE Stripe dashboard (payout history, balance, tax and account settings), a
 * hosted Account Link re-onboards their account, and the in-app sheet redirects where their money lands - none of
 * which a delegated permission may hand to somebody else, and Stripe wants the account holder for a bank change
 * anyway. Staff on a managed workspace already have the same answer on Owner payouts ("Send link to change bank"),
 * and that one emailer is what runs here too, so the refusal tells the truth about what was sent.
 */
export async function POST(req: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const service = createSupabaseServiceRoleClient();
    const payout = await resolveStripePayoutContext(service, user.id);
    if (!payout.payoutOwnerUserId) {
      return NextResponse.json(
        { error: stripePayoutContextError(payout.unresolvedReason) },
        { status: stripePayoutContextStatus(payout.unresolvedReason) },
      );
    }
    const access = await assertCoManagerBankAccountAccess(service, user.id, payout.payoutOwnerUserId, "edit");
    if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
    if (user.id !== payout.payoutOwnerUserId) {
      const emailed = await emailTheOwnerInstead(service, payout.payoutOwnerUserId, user.id);
      return NextResponse.json(
        {
          code: "OWNER_ONLY",
          error: emailed
            ? "Only the account owner can change the payout bank. We emailed them a link."
            : "Only the account owner can change the payout bank. Send them a link from Owner payouts.",
        },
        { status: 403 },
      );
    }
    const limit = await rateLimit(`connect-change-bank:${user.id}:${clientIpFrom(req)}`, 10, 10 * 60_000);
    if (!limit.ok) return NextResponse.json({ error: "Try again in a few minutes." }, { status: 429 });

    let stripe;
    try {
      stripe = getStripe();
    } catch {
      return NextResponse.json({ code: "STRIPE_NOT_CONFIGURED", error: "Stripe is not configured." }, { status: 503 });
    }

    const accountId = await resolveManagerConnectAccountId(service, payout.payoutOwnerUserId);
    if (!accountId) {
      return NextResponse.json({ code: "NO_ACCOUNT", error: "Set up payouts first, then you can change the bank." }, { status: 422 });
    }

    try {
      const account = await assertOwnedPayoutAccount(stripe, accountId, payout.payoutOwnerUserId);
      const plan = planBankChange(account);
      if (plan.mode === "in_app") return NextResponse.json({ mode: "in_app" } satisfies BankChangeResponse);

      const origin = resolveAppOrigin(req);
      const workspaceId = await activeWorkspaceIdFromCookie();
      let lastError: unknown = null;
      for (const attempt of plan.attempts) {
        try {
          if (attempt.kind === "login_link") {
            const link = await stripe.accounts.createLoginLink(accountId);
            return NextResponse.json({ mode: "redirect", url: link.url, via: "login_link" } satisfies BankChangeResponse);
          }
          const link = await stripe.accountLinks.create(bankChangeAccountLinkParams(accountId, attempt.type, origin, workspaceId));
          return NextResponse.json({ mode: "redirect", url: link.url, via: attempt.type } satisfies BankChangeResponse);
        } catch (e) {
          lastError = e;
          console.error("[stripe/connect/change-bank]", attempt.kind, e instanceof Error ? e.message : "error");
        }
      }
      return NextResponse.json({ code: "BANK_CHANGE_UNAVAILABLE", error: bankChangeErrorMessage(lastError) }, { status: 502 });
    } catch (e) {
      console.error("[stripe/connect/change-bank]", e instanceof Error ? e.message : "error");
      return NextResponse.json({ code: "BANK_CHANGE_UNAVAILABLE", error: bankChangeErrorMessage(e) }, { status: 502 });
    }
  } catch (e) {
    console.error("[stripe/connect/change-bank]", e instanceof Error ? e.message : "error");
    return NextResponse.json({ error: "Could not start the bank change. Try again." }, { status: 500 });
  }
}

/**
 * Send the owner the link to do it themselves, through the one emailer that already exists for this
 * (`sendOwnerPayoutSetupLink`, a sign-in link that carries no credential). It resolves only for PropLane staff on a
 * managed workspace; for anyone else there is nothing to send and the refusal says so instead of claiming an email.
 */
async function emailTheOwnerInstead(
  service: ReturnType<typeof createSupabaseServiceRoleClient>,
  ownerUserId: string,
  actorUserId: string,
): Promise<boolean> {
  try {
    const ctx = await resolveManagedPayoutStaffContext(service, actorUserId, await activeWorkspaceIdFromCookie());
    if (!ctx.staff || !ctx.ownerUserId) return false;
    const sent = await sendOwnerPayoutSetupLink(service, {
      workspaceId: ctx.workspaceId,
      workspaceName: ctx.workspaceName,
      ownerUserId,
      staffUserId: actorUserId,
    });
    return sent.ok;
  } catch {
    return false;
  }
}
