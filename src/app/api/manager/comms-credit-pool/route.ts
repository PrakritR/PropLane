import { NextResponse } from "next/server";
import { requireManagerRouteUser } from "@/lib/manager-route-guard.server";
import { isCommsCreditPoolEnabled } from "@/lib/comms-billing/rates";
import {
  loadCommsPoolSnapshot,
  loadFunderWorkspaceRows,
  setFunderFundingScope,
  setFunderWorkspaceMonthlyLimit,
} from "@/lib/comms-billing/pool.server";

export const runtime = "nodejs";

export type CommsCreditPoolSummary = {
  poolEnabled: boolean;
  tier: string;
  allowanceCents: number;
  includedRemainingCents: number;
  purchasedRemainingCents: number;
  remainingCents: number;
  sharedAcrossWorkspaces: boolean;
  rollsOver: boolean;
  periodStart: string;
  periodEnd: string;
  paused: boolean;
  usedThisMonthCents: number;
  fundsAllWorkspaces: boolean;
  pinnedWorkspaceId: string | null;
  workspaces: {
    workspaceId: string;
    name: string;
    owned: boolean;
    ownerName?: string;
    enabled: boolean;
    monthlyLimitCents: number | null;
    usedThisMonthCents: number;
  }[];
};

/**
 * The messaging-credit pool summary for the SIGNED-IN funder (never a
 * caller-named user). The whole endpoint is only meaningful behind
 * `COMMS_CREDIT_POOL_ENABLED`; with it off it still answers (so a stray
 * fetch never 404s) but callers should gate the UI on `poolEnabled`.
 */
export async function GET() {
  const auth = await requireManagerRouteUser();
  if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 403 });
  try {
    const [snapshot, workspaces] = await Promise.all([
      loadCommsPoolSnapshot(auth.db, auth.userId),
      loadFunderWorkspaceRows(auth.db, auth.userId),
    ]);
    const enabledWorkspaces = workspaces.filter((w) => w.enabled);
    const fundsAllWorkspaces = enabledWorkspaces.length === workspaces.length && workspaces.length > 0;
    const pinnedWorkspaceId = !fundsAllWorkspaces && enabledWorkspaces.length === 1 ? enabledWorkspaces[0]!.workspaceId : null;
    const summary: CommsCreditPoolSummary = {
      poolEnabled: isCommsCreditPoolEnabled(),
      tier: snapshot.tier,
      allowanceCents: snapshot.allowanceCents,
      includedRemainingCents: snapshot.includedRemainingCents,
      purchasedRemainingCents: snapshot.purchasedRemainingCents,
      remainingCents: snapshot.remainingCents,
      sharedAcrossWorkspaces: snapshot.sharedAcrossWorkspaces,
      rollsOver: snapshot.rollsOver,
      periodStart: snapshot.periodStart,
      periodEnd: snapshot.periodEnd,
      paused: snapshot.paused,
      usedThisMonthCents: enabledWorkspaces.reduce((sum, w) => sum + w.usedThisMonthCents, 0),
      fundsAllWorkspaces,
      pinnedWorkspaceId,
      workspaces,
    };
    return NextResponse.json(summary, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "We couldn't load your messaging credit. Try again." },
      { status: 503 },
    );
  }
}

/**
 * `{ scope: "all" }` or `{ scope: "one", workspaceId }` rewrites which
 * workspaces this funder's pool pays for; `{ workspaceId, monthlyLimitCents }`
 * (dollars-or-null) sets that one workspace's cap. Every workspace named is
 * re-derived against this manager's own accessible workspaces server-side —
 * a body can never grant funding authority over a workspace they cannot see.
 */
export async function PATCH(req: Request) {
  const auth = await requireManagerRouteUser();
  if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 403 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  try {
    if (body.scope === "all") {
      await setFunderFundingScope(auth.db, auth.userId, { kind: "all" });
    } else if (body.scope === "one") {
      if (typeof body.workspaceId !== "string" || !body.workspaceId.trim()) {
        return NextResponse.json({ error: "Choose a workspace." }, { status: 400 });
      }
      await setFunderFundingScope(auth.db, auth.userId, { kind: "one", workspaceId: body.workspaceId });
    } else if (typeof body.workspaceId === "string" && "monthlyLimitCents" in body) {
      const raw = body.monthlyLimitCents;
      const monthlyLimitCents = raw === null ? null : Number(raw);
      if (monthlyLimitCents !== null && (!Number.isSafeInteger(monthlyLimitCents) || monthlyLimitCents < 0 || monthlyLimitCents > 100_000)) {
        return NextResponse.json({ error: "Enter a whole-dollar monthly limit, or none." }, { status: 400 });
      }
      await setFunderWorkspaceMonthlyLimit(auth.db, auth.userId, body.workspaceId, monthlyLimitCents);
    } else {
      return NextResponse.json({ error: "Provide scope, or workspaceId + monthlyLimitCents." }, { status: 400 });
    }
    const [snapshot, workspaces] = await Promise.all([
      loadCommsPoolSnapshot(auth.db, auth.userId),
      loadFunderWorkspaceRows(auth.db, auth.userId),
    ]);
    return NextResponse.json({ ok: true, snapshot, workspaces });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Could not update your messaging credit funding." },
      { status: 400 },
    );
  }
}
