import { NextResponse } from "next/server";
import { requireAdminRoute } from "@/lib/admin/admin-route-guard.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { loadAdminPayouts } from "@/lib/managed-finance/admin-payouts.server";
import { financeErrorResponse, stripeOrNull } from "@/lib/managed-finance/routes.server";
import {
  createSplitRule, endSplitRule, listEligiblePayees, placePayoutHold, releasePayoutHold, setBillApprovalThreshold, writePayoutAudit,
} from "@/lib/managed-finance/splits.server";
import { reconcileWithdrawals } from "@/lib/managed-finance/withdrawals.server";
import type { SplitRuleDraft } from "@/lib/managed-finance/splits";

export const runtime = "nodejs";

/** GET: every PropLane-held balance, split rules per managed workspace, held / failed payouts with reasons, the audit. Platform admin only. */
export async function GET(req: Request) {
  const guard = await requireAdminRoute();
  if (!guard.ok) return guard.response;
  try {
    const db = createSupabaseServiceRoleClient();
    // `?payees=<workspace>`: who a split rule on that workspace may pay (the editor's choices; the server re-checks on save).
    const payeesFor = new URL(req.url).searchParams.get("payees")?.trim();
    if (payeesFor) return NextResponse.json({ payees: await listEligiblePayees(db, payeesFor) }, { headers: { "cache-control": "private, no-store" } });
    return NextResponse.json(await loadAdminPayouts(db), { headers: { "cache-control": "private, no-store" } });
  } catch (e) {
    return financeErrorResponse(e, "Could not load payouts.");
  }
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const intOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) ? v : null);

/**
 * POST { action, ... }: staff actions, each with its audit row written BEFORE the change.
 *  - rule_create { workspaceId, propertyId?, ruleKind, appliesTo[], payeeKind, payeeUserId, bps? | fixedCents? }
 *  - rule_end { workspaceId, ruleId }
 *  - hold { partyId, workspaceId?, reason }   - release { holdId, note? }
 *  - retry_check { }   re-runs the withdrawal reconciler (finishes landed transfers' payouts; never creates a withdrawal for anyone)
 *  - threshold { workspaceId, cents }
 * Every id is a name, never a grant: the workspace, payee, house and party are re-derived server-side.
 */
export async function POST(req: Request) {
  const guard = await requireAdminRoute();
  if (!guard.ok) return guard.response;
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const db = createSupabaseServiceRoleClient();
  const actorUserId = guard.userId;
  try {
    switch (body.action) {
      case "rule_create": {
        const draft: SplitRuleDraft = {
          propertyId: str(body.propertyId) || null,
          ruleKind: body.ruleKind === "fixed" ? "fixed" : "percent",
          appliesTo: Array.isArray(body.appliesTo) ? (body.appliesTo as unknown[]).map(str).filter(Boolean) : [],
          payeeKind: body.payeeKind === "vendor" ? "vendor" : "member",
          payeeUserId: str(body.payeeUserId),
          bps: intOrNull(body.bps),
          fixedCents: intOrNull(body.fixedCents),
        };
        const rule = await createSplitRule(db, { actorUserId, workspaceId: str(body.workspaceId), draft });
        return NextResponse.json({ ok: true, rule });
      }
      case "rule_end":
        await endSplitRule(db, { actorUserId, workspaceId: str(body.workspaceId), ruleId: str(body.ruleId) });
        return NextResponse.json({ ok: true });
      case "hold": {
        const hold = await placePayoutHold(db, { actorUserId, partyId: str(body.partyId), workspaceId: str(body.workspaceId) || null, reason: str(body.reason) });
        return NextResponse.json({ ok: true, holdId: hold.id });
      }
      case "release":
        await releasePayoutHold(db, { actorUserId, holdId: str(body.holdId), note: str(body.note) || undefined });
        return NextResponse.json({ ok: true });
      case "threshold":
        await setBillApprovalThreshold(db, { actorUserId, workspaceId: str(body.workspaceId), cents: intOrNull(body.cents) ?? NaN });
        return NextResponse.json({ ok: true });
      case "retry_check": {
        const stripe = stripeOrNull();
        if (!stripe) return NextResponse.json({ error: "Stripe is not configured." }, { status: 503 });
        await writePayoutAudit(db, { actor: actorUserId, action: "retry_check" });
        return NextResponse.json({ ok: true, ...(await reconcileWithdrawals(stripe, db)) });
      }
      default:
        return NextResponse.json({ error: "Unknown action." }, { status: 400 });
    }
  } catch (e) {
    return financeErrorResponse(e, "That did not go through.");
  }
}
