import { NextResponse } from "next/server";
import {
  revokeApplicationFeeWaiverCode,
  updateApplicationFeeWaiverCode,
  waiverCodeLimitedPropertyIds,
  type UpdateWaiverCodeInput,
} from "@/lib/application-fee-waiver";
import { createWaiverGrantReader, resolveWaiverPropertiesScope } from "@/lib/application-fee-waiver-scope.server";
import { requireManagerRouteUser } from "@/lib/manager-route-guard.server";

export const runtime = "nodejs";

type PatchBody = {
  action?: string;
  appliesTo?: string;
  propertyIds?: string[];
  maxUses?: number | null;
  expiresAt?: string | null;
  label?: string | null;
};

/**
 * PATCH - `{ action: "revoke" }` disables a waiver code; `{ action: "update", ... }` edits an active one
 * (what it applies to, its property limit, use cap, expiry, label).
 *
 * A code belongs to its OWNER (`manager_user_id`), read from the stored row, never the body or the caller. The
 * caller must be that owner, or hold Applications at `edit` on EVERY property the code covers (a co-manager, or
 * PropLane staff seated on a service workspace); a portfolio-wide code is the owner's alone. Every write is
 * scoped to the owner's id by the lib, so nobody can change - or discover - a code outside that rule.
 * A property limit in an update is authorized the same way and must stay inside the code's own portfolio.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireManagerRouteUser();
  if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as PatchBody;

  const grant = createWaiverGrantReader(ctx.db, ctx.userId);

  const { data: row } = await ctx.db
    .from("manager_application_fee_waiver_codes")
    .select("manager_user_id, property_id, property_ids")
    .eq("id", id.trim())
    .maybeSingle();
  const stored = row as { manager_user_id?: string | null; property_id?: string | null; property_ids?: string[] | null } | null;
  const ownerUserId = String(stored?.manager_user_id ?? "").trim();
  if (!stored || !ownerUserId) return NextResponse.json({ error: "Code not found." }, { status: 404 });
  if (ownerUserId !== ctx.userId) {
    const covered = waiverCodeLimitedPropertyIds({ propertyId: stored.property_id, propertyIds: stored.property_ids });
    // A portfolio-wide code is the owner's own; it is not discoverable by anyone else.
    if (covered.length === 0) return NextResponse.json({ error: "Code not found." }, { status: 404 });
    // `property_ids` has no foreign key, so a DELETED house leaves a stale id. It must not block a teammate from
    // turning the code off on the houses that do exist - the same rule the POST widen gate applies.
    const access = await resolveWaiverPropertiesScope(ctx.db, ctx.userId, covered, "edit", { ignoreUnknown: true, grant });
    // Every non-owner denial is the SAME 404, so a code's existence and kind (portfolio-wide or limited) cannot be
    // told apart from "no such code"; only a failed read (5xx) keeps its own status.
    if (!access.ok) {
      if (access.status >= 500) return NextResponse.json({ error: access.error }, { status: access.status });
      return NextResponse.json({ error: "Code not found." }, { status: 404 });
    }
    // Every house it covers is gone, so no grant of theirs reaches it: an absent house authorizes nothing either.
    if (access.knownPropertyIds.length === 0) return NextResponse.json({ error: "Code not found." }, { status: 404 });
    if (access.ownerUserId !== ownerUserId) return NextResponse.json({ error: "Code not found." }, { status: 404 });
  }

  if (body.action === "revoke") {
    const result = await revokeApplicationFeeWaiverCode(ctx.db, ownerUserId, id);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 404 });
    return NextResponse.json({ ok: true });
  }

  if (body.action === "update") {
    const input: UpdateWaiverCodeInput = {};
    if ("appliesTo" in body) input.appliesTo = body.appliesTo as UpdateWaiverCodeInput["appliesTo"];
    if ("propertyIds" in body) {
      input.propertyIds = Array.isArray(body.propertyIds) ? body.propertyIds.map(String) : [];
      if (input.propertyIds.length > 0) {
        const scope = await resolveWaiverPropertiesScope(ctx.db, ctx.userId, input.propertyIds, "edit", { grant });
        if (!scope.ok) return NextResponse.json({ error: scope.error }, { status: scope.status });
        if (scope.ownerUserId !== ownerUserId) {
          return NextResponse.json({ error: "Pick properties from your own portfolio." }, { status: 400 });
        }
      } else if (ownerUserId !== ctx.userId) {
        // Dropping the limit makes the code portfolio-wide: the owner's decision.
        return NextResponse.json({ error: "Forbidden." }, { status: 403 });
      }
    }
    if ("maxUses" in body) input.maxUses = body.maxUses ?? null;
    if ("expiresAt" in body) input.expiresAt = body.expiresAt ?? null;
    if ("label" in body) input.label = body.label ?? null;
    const result = await updateApplicationFeeWaiverCode(ctx.db, ownerUserId, id, input);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ code: result.code });
  }

  return NextResponse.json({ error: "Unsupported action." }, { status: 400 });
}
