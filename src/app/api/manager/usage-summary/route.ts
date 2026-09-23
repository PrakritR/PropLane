import { NextResponse } from "next/server";
import { requireManagerRouteUser } from "@/lib/manager-route-guard.server";
import { getEffectiveManagerSkuTier } from "@/lib/manager-access-server";
import { managerTierDisplayLabel } from "@/lib/manager-access";
import { loadWorkspacePlan, loadWorkspaces } from "@/lib/workspaces/server";
import { resolveWorkspaceWorkNumbers } from "@/lib/sms/manager-workspace-role.server";
import { loadCommsWallet } from "@/lib/comms-billing/wallet.server";
import { COMMS_BILLING_RATES_CENTS } from "@/lib/comms-billing/rates";

export const runtime = "nodejs";

export type ManagerUsageSummary = {
  tier: "free" | "pro" | "business" | null;
  tierLabel: string;
  tierUnknown: boolean;
  communication: {
    /** Included + purchased credit still unspent. */
    remainingCents: number;
    /** Spent against the included monthly allowance only (never negative). */
    includedUsedCents: number;
    includedAllowanceCents: number;
    purchasedRemainingCents: number;
    resetsAt: string;
    paused: boolean;
  };
  /** @deprecated kept for older clients; Usage UI no longer shows listings. */
  listings: { used: number; max: number | null };
  workspaces: { used: number; max: number };
  residents: { used: number; max: number | null };
  /** @deprecated Usage UI no longer shows work numbers. */
  workNumbers: { used: number; max: number; perWorkspace: boolean };
  /** @deprecated Usage UI no longer shows co-managers. */
  coManagers: { used: number; max: number | null };
  monthlyBudgetCents: number | null;
  ratesCents: Record<string, number>;
};

export async function GET() {
  const auth = await requireManagerRouteUser();
  if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 403 });

  try {
    const [tierResult, workspaces, wallet, workNumbers, accountResult] = await Promise.all([
      getEffectiveManagerSkuTier(auth.userId),
      loadWorkspaces(auth.db, auth.userId),
      loadCommsWallet(auth.db, auth.userId),
      resolveWorkspaceWorkNumbers(auth.db, auth.userId),
      auth.db
        .from("manager_comms_billing_accounts")
        .select("monthly_budget_cents")
        .eq("manager_user_id", auth.userId)
        .maybeSingle(),
    ]);
    const plan = await loadWorkspacePlan(auth.db, auth.userId, workspaces);
    const tier = tierResult.ok ? tierResult.tier : null;
    const ownedNumbers = workNumbers.numbers.filter((n) => n.owned);

    const includedUsedCents = Math.max(0, wallet.allowanceCents - wallet.includedRemainingCents);

    const summary: ManagerUsageSummary = {
      tier,
      tierLabel: managerTierDisplayLabel(tier),
      tierUnknown: !tierResult.ok,
      communication: {
        remainingCents: wallet.remainingCents,
        includedUsedCents,
        includedAllowanceCents: wallet.allowanceCents,
        purchasedRemainingCents: wallet.purchasedRemainingCents,
        resetsAt: wallet.periodEnd,
        paused: wallet.paused,
      },
      listings: { used: plan.usage.properties, max: plan.propertyLimit },
      workspaces: { used: plan.usage.workspaces, max: plan.workspaceLimit },
      residents: { used: plan.usage.residents, max: plan.residentLimit },
      workNumbers: {
        used: ownedNumbers.filter((n) => Boolean(n.phoneNumber)).length,
        max: ownedNumbers.length,
        perWorkspace: ownedNumbers.length > 1,
      },
      coManagers: { used: plan.usage.team, max: plan.teamLimit },
      monthlyBudgetCents: accountResult.data?.monthly_budget_cents ?? null,
      ratesCents: COMMS_BILLING_RATES_CENTS,
    };

    return NextResponse.json(summary, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    const message = e instanceof Error ? e.message : "We couldn't load your usage. Try again.";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
