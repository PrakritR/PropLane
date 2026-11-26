import type Stripe from "stripe";

/**
 * Changing the bank an owner is paid to.
 *
 * A NEW account is application-collected (`stripe_dashboard.type: "none"`): its bank is PropLane's own in-app sheet
 * (`AddBankFlow`), nothing hosted exists. A legacy Express account (`stripe_dashboard.type: "express"`, Stripe collects
 * requirements) has no embedded flow PropLane may open (`createAccountSession` refuses it), so the person changes the
 * external account in Stripe's own hosted pages: the Express dashboard (`createLoginLink`) or an Account Link. Which
 * one is the account's own decision, never the client's. The server tries the attempts in order and reports the last
 * Stripe error as a real message.
 */

export type BankChangeAttempt =
  | { kind: "login_link" }
  | { kind: "account_link"; type: "account_update" | "account_onboarding" };

export type BankChangePlan = { mode: "in_app" } | { mode: "hosted"; attempts: BankChangeAttempt[] };

type AccountShape = Pick<Stripe.Account, "details_submitted"> & { controller?: Partial<Stripe.Account.Controller> | null };

export function planBankChange(account: AccountShape): BankChangePlan {
  if (account.controller?.stripe_dashboard?.type === "none") return { mode: "in_app" };
  if (!account.details_submitted) {
    // Stripe refuses a login link until onboarding finished: the hosted onboarding is the only door.
    return { mode: "hosted", attempts: [{ kind: "account_link", type: "account_onboarding" }] };
  }
  if (account.controller?.stripe_dashboard?.type === "express") {
    // The Express dashboard is where an external account is edited. `account_update` only lists requirements that
    // are currently due, so it is the fallback, not the first choice.
    return { mode: "hosted", attempts: [{ kind: "login_link" }, { kind: "account_link", type: "account_update" }] };
  }
  return {
    mode: "hosted",
    attempts: [{ kind: "account_link", type: "account_update" }, { kind: "account_link", type: "account_onboarding" }],
  };
}

export type BankChangeReturn = "returned" | "refresh";

/**
 * The page Stripe sends the person back to. `origin` is the canonical origin the request resolved (`resolveAppOrigin`:
 * the request's own origin on localhost, the canonical public origin otherwise) - never a client-supplied value. The
 * `bank` marker tells the card to re-read the external account; `refresh` means the link expired or was reopened.
 */
export function bankChangeReturnUrl(origin: string, outcome: BankChangeReturn, workspaceId?: string | null): string {
  const base = origin.trim().replace(/\/+$/, "");
  const url = new URL("/portal/profile", base);
  url.searchParams.set("tab", "payments");
  const ws = workspaceId?.trim();
  if (ws) url.searchParams.set("workspace", ws);
  url.searchParams.set("bank", outcome);
  return url.toString();
}

export function bankChangeAccountLinkParams(
  accountId: string,
  type: "account_update" | "account_onboarding",
  origin: string,
  workspaceId?: string | null,
): Stripe.AccountLinkCreateParams {
  return {
    account: accountId,
    type,
    return_url: bankChangeReturnUrl(origin, "returned", workspaceId),
    refresh_url: bankChangeReturnUrl(origin, "refresh", workspaceId),
  };
}

/** A real sentence for a Stripe failure; never a blank, never a stack. */
export function bankChangeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : "";
  const lower = raw.toLowerCase();
  if (lower.includes("signed up for connect")) {
    return "Stripe Connect is not activated for this PropLane account yet. Contact support.";
  }
  if (lower.includes("login link") && lower.includes("onboarding")) {
    return "Finish Stripe onboarding before changing the bank account.";
  }
  if (lower.includes("does not have access to account") || lower.includes("that account does not exist")) {
    return "We couldn't reach your saved Stripe account. Reconnect it from Payout method.";
  }
  if (lower.includes("url") && lower.includes("https")) {
    return "Stripe would not return to this address. Open PropLane at its public address and try again.";
  }
  return raw.trim() ? `Stripe could not open the bank change: ${raw.trim()}` : "Stripe could not open the bank change. Try again shortly.";
}

export type BankChangeResponse =
  | { mode: "in_app" }
  | { mode: "redirect"; url: string; via: "login_link" | "account_update" | "account_onboarding" };
