import { NextResponse } from "next/server";
import {
  type CreateWaiverCodeInput,
  createApplicationFeeWaiverCode,
  isValidWaiverCodeFormat,
  listApplicationFeeWaiverCodes,
  listApplicationFeeWaiverRedemptions,
  normalizeWaiverAppliesTo,
  normalizeWaiverCode,
  updateApplicationFeeWaiverCode,
  waiverCodeCoversProperty,
  type ApplicationFeeWaiverCode,
} from "@/lib/application-fee-waiver";
import { resolveWaiverCodeScope, resolveWaiverPropertiesScope } from "@/lib/application-fee-waiver-scope.server";
import { requireManagerRouteUser } from "@/lib/manager-route-guard.server";

export const runtime = "nodejs";

/**
 * GET - list waiver codes and redemption history. Without `?propertyId=` these are the signed-in manager's OWN
 * (the Settings list). With it, the codes belong to that property's OWNER and are filtered to the ones covering
 * it, for the owner or a teammate holding Applications at `read` on it (a co-manager, or PropLane staff seated on
 * a service workspace). Never another manager's codes for a property the caller has no grant on.
 */
export async function GET(req: Request) {
  const ctx = await requireManagerRouteUser({ fast: true });
  if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  try {
    const propertyId = new URL(req.url).searchParams.get("propertyId")?.trim() ?? "";
    if (!propertyId) {
      const [codes, redemptions] = await Promise.all([
        listApplicationFeeWaiverCodes(ctx.db, ctx.userId),
        listApplicationFeeWaiverRedemptions(ctx.db, ctx.userId),
      ]);
      return NextResponse.json({ codes, redemptions });
    }
    const scope = await resolveWaiverCodeScope(ctx.db, ctx.userId, propertyId, "read");
    if (!scope.ok) return NextResponse.json({ error: scope.error }, { status: scope.status });
    const [all, allRedemptions] = await Promise.all([
      listApplicationFeeWaiverCodes(ctx.db, scope.ownerUserId),
      listApplicationFeeWaiverRedemptions(ctx.db, scope.ownerUserId),
    ]);
    const codes = all.filter((c) => waiverCodeCoversProperty(c, propertyId));
    const ids = new Set(codes.map((c) => c.id));
    return NextResponse.json({ codes, redemptions: allRedemptions.filter((r) => ids.has(r.codeId)) });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not load waiver codes.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

type CreateBody = {
  code?: string;
  label?: string;
  maxUses?: number | null;
  expiresAt?: string | null;
  /** application (default) | lease | both. */
  appliesTo?: string | null;
  /** Limit the code to these properties; omitted/empty = every property. */
  propertyIds?: string[] | null;
};

/** Properties a stored code is limited to (the list, else the legacy single id); empty = portfolio-wide. */
function limitedPropertyIds(code: ApplicationFeeWaiverCode): string[] {
  if (code.propertyIds.length > 0) return code.propertyIds;
  return code.propertyId ? [code.propertyId] : [];
}

/**
 * POST - create a waiver code. A code belongs to the PROPERTY'S OWNER (redemption looks codes up under the owner),
 * so a property limit is resolved from the database, never the body: every property must belong to one owner, and
 * the caller must be that owner or hold Applications at `edit` on each (a co-manager, or PropLane staff seated on a
 * service workspace - the seat IS that grant). A code with no property limit stays the caller's own portfolio-wide
 * code. Adding text the owner already has is idempotent: an active property-limited code gains this property,
 * a portfolio-wide one already covers it, and a turned-off / expired / used-up one is a 409, never revived.
 */
export async function POST(req: Request) {
  const ctx = await requireManagerRouteUser();
  if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as CreateBody;
  let propertyIds: string[] | null = null;
  if (Array.isArray(body.propertyIds)) {
    propertyIds = body.propertyIds.map(String);
  } else if (body.propertyIds != null) {
    return NextResponse.json({ error: "propertyIds must be a list." }, { status: 400 });
  }
  let ownerUserId = ctx.userId;
  if (propertyIds && propertyIds.length > 0) {
    const scope = await resolveWaiverPropertiesScope(ctx.db, ctx.userId, propertyIds, "edit");
    if (!scope.ok) return NextResponse.json({ error: scope.error }, { status: scope.status });
    ownerUserId = scope.ownerUserId;

    const text = body.code?.trim() ? normalizeWaiverCode(body.code) : "";
    if (text && isValidWaiverCodeFormat(text)) {
      const existing = (await listApplicationFeeWaiverCodes(ctx.db, ownerUserId)).find((c) => normalizeWaiverCode(c.code) === text);
      if (existing) {
        const asked = normalizeWaiverAppliesTo(body.appliesTo);
        const spent = existing.maxUses != null && existing.usedCount >= existing.maxUses;
        const expired = existing.expiresAt != null && Date.parse(existing.expiresAt) <= Date.now();
        if (existing.status !== "active" || spent || expired) {
          const why = existing.status !== "active" ? "turned off" : expired ? "expired" : "used up";
          return NextResponse.json({ error: `That code was ${why}. Pick a different code.` }, { status: 409 });
        }
        if (existing.appliesTo !== "both" && existing.appliesTo !== asked) {
          return NextResponse.json({ error: "That code already exists for a different fee. Pick a different code." }, { status: 409 });
        }
        const current = limitedPropertyIds(existing);
        const wanted = [...new Set(propertyIds.map((id) => id.trim()).filter(Boolean))];
        if (wanted.every((id) => waiverCodeCoversProperty(existing, id))) {
          return NextResponse.json({ code: existing });
        }
        // Widening a code also widens what it waives on its other houses: a teammate may only do that when they
        // hold Applications at edit on every house it already covers.
        const widen = await resolveWaiverPropertiesScope(ctx.db, ctx.userId, current, "edit");
        if (!widen.ok || widen.ownerUserId !== ownerUserId) {
          return NextResponse.json({ error: widen.ok ? "Forbidden." : widen.error }, { status: widen.ok ? 403 : widen.status });
        }
        const updated = await updateApplicationFeeWaiverCode(ctx.db, ownerUserId, existing.id, {
          propertyIds: [...new Set([...current, ...wanted])],
        });
        if (!updated.ok) return NextResponse.json({ error: updated.error }, { status: updated.status });
        return NextResponse.json({ code: updated.code });
      }
    }
  }
  const result = await createApplicationFeeWaiverCode(ctx.db, ownerUserId, {
    code: body.code,
    label: body.label,
    maxUses: body.maxUses ?? null,
    expiresAt: body.expiresAt ?? null,
    appliesTo: (body.appliesTo ?? null) as CreateWaiverCodeInput["appliesTo"],
    propertyIds,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ code: result.code });
}
