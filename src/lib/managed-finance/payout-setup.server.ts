import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { sendManagerNoticeEmail } from "@/lib/manager-notice-email.server";
import { portalSignInHref } from "@/lib/one-number/link-destinations.server";
import { resolveManagedPayee } from "@/lib/managed-finance/payee.server";
import { loadServiceStaffWorkspaces } from "@/lib/service/service-mode.server";
import { retrieveManagerConnectAccountOrNull } from "@/lib/stripe-connect";
import { resolvePayoutsReadiness } from "@/lib/stripe-payouts-readiness.server";
import { WORKSPACE_COOKIE } from "@/lib/workspaces/types";

/**
 * Payout setup in a PropLane-managed workspace belongs to its OWNER of record. PropLane staff never onboard, verify or
 * add a bank as the owner (Stripe requires the external account to belong to the account holder, and the identity is
 * the owner's own): they read the owner's status and send the owner a link to finish it as themselves.
 * docs/agents/owner-management.md § Owner payout setup.
 */

export const STAFF_MANAGED_PAYOUT_MESSAGE =
  "This workspace's payouts are set up by its owner, signed in as themselves. Send them a setup link instead.";

export type ManagedPayoutStaffContext =
  | { staff: false }
  | { staff: true; workspaceId: string; workspaceName: string; ownerUserId: string | null };

/**
 * Is this viewer PropLane staff acting in a managed (`is_service`) workspace that is not theirs to be paid from?
 * `workspaceId` is the active workspace (the request's cookie). Throws when a read fails: callers refuse rather than
 * fall through to the viewer's own Connect account.
 */
export async function resolveManagedPayoutStaffContext(
  db: SupabaseClient,
  userId: string,
  workspaceId: string | null | undefined,
): Promise<ManagedPayoutStaffContext> {
  const ws = (workspaceId ?? "").trim();
  if (!ws) return { staff: false };
  const { data, error } = await db.from("portal_workspaces").select("id, name, is_service").eq("id", ws).maybeSingle();
  if (error) throw new Error("Could not read the workspace.");
  const row = data as { id?: string; name?: string; is_service?: boolean } | null;
  if (!row || row.is_service !== true) return { staff: false };
  const ownerUserId = await resolveManagedPayee(db, ws);
  if (ownerUserId === userId) return { staff: false };
  const staff = await loadServiceStaffWorkspaces(db, userId);
  if (!staff.some((w) => w.id === ws)) return { staff: false };
  return { staff: true, workspaceId: ws, workspaceName: String(row.name ?? "").trim() || "This workspace", ownerUserId };
}

/** The active workspace id from the request cookie; null outside a request (a job, a unit test). */
export async function activeWorkspaceIdFromCookie(): Promise<string | null> {
  try {
    const { cookies } = await import("next/headers");
    return (await cookies()).get(WORKSPACE_COOKIE)?.value?.trim() || null;
  } catch {
    return null;
  }
}

export type OwnerPayoutStatus = {
  state: "no_owner" | "not_set_up" | "pending" | "active";
  ownerName: string | null;
  bank: { bankName: string | null; last4: string | null; status: string | null } | null;
};

/** The owner's payout state, read from Stripe on every call. A bank number is never stored here, only masked fields shown. */
export async function readOwnerPayoutStatus(stripe: Stripe, db: SupabaseClient, ownerUserId: string | null): Promise<OwnerPayoutStatus> {
  if (!ownerUserId) return { state: "no_owner", ownerName: null, bank: null };
  const { data } = await db.from("profiles").select("stripe_connect_account_id, full_name").eq("id", ownerUserId).maybeSingle();
  const profile = (data ?? {}) as { stripe_connect_account_id?: string | null; full_name?: string | null };
  const ownerName = profile.full_name?.trim() || null;
  const accountId = String(profile.stripe_connect_account_id ?? "").trim();
  if (!accountId) return { state: "not_set_up", ownerName, bank: null };
  const account = await retrieveManagerConnectAccountOrNull(stripe, accountId);
  if (!account) return { state: "not_set_up", ownerName, bank: null };
  const banks = await stripe.accounts.listExternalAccounts(accountId, { object: "bank_account", limit: 5 });
  const list = banks.data as Stripe.BankAccount[];
  const chosen = list.find((b) => b.default_for_currency) ?? list[0] ?? null;
  const ready = resolvePayoutsReadiness(account).ready;
  return {
    state: ready ? "active" : "pending",
    ownerName,
    bank: chosen ? { bankName: chosen.bank_name ?? null, last4: chosen.last4 ?? null, status: chosen.status ?? null } : null,
  };
}

/**
 * Email the owner of record a link to THEIR OWN payout setup. The link carries no credential: the owner signs in as
 * themselves, and the setup acts on their session. Texting is left to the owner line's own consent-gated senders.
 */
export async function sendOwnerPayoutSetupLink(
  db: SupabaseClient,
  input: { workspaceId: string; workspaceName: string; ownerUserId: string; staffUserId: string },
): Promise<{ ok: boolean; status: string }> {
  const { data: ws } = await db.from("portal_workspaces").select("owner_user_id").eq("id", input.workspaceId).maybeSingle();
  const managerOwner = String((ws as { owner_user_id?: string } | null)?.owner_user_id ?? "");
  if (!managerOwner) return { ok: false, status: "no_workspace_owner" };
  const path = `/portal/profile?tab=payments&workspace=${encodeURIComponent(input.workspaceId)}`;
  const day = new Date().toISOString().slice(0, 10);
  const r = await sendManagerNoticeEmail(db, {
    recipientUserId: input.ownerUserId,
    ownerUserId: managerOwner,
    workspaceId: input.workspaceId,
    subject: `Set up your payouts for ${input.workspaceName}`,
    text: `Set up where your payouts go for ${input.workspaceName}. Sign in as yourself, open Balance & payouts, and add your bank account. Stripe collects your identity and tax details.\n${resolveEmailLinkBaseUrl()}${portalSignInHref(path)}`,
    url: portalSignInHref(path),
    idempotencyKey: `owner-payout-setup:${input.workspaceId}:${day}`,
  }).catch(() => ({ status: "failed" as const }));
  return { ok: r.status === "sent", status: r.status };
}
