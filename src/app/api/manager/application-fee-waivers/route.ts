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
  waiverCodeLimitedPropertyIds,
  type ApplicationFeeWaiverCode,
} from "@/lib/application-fee-waiver";
import {
  createWaiverGrantReader,
  resolveWaiverCodeScope,
  resolveWaiverPropertiesScope,
  resolveWaiverWriteScope,
  waiverCodeIsReadOnly,
  type WaiverGrantReader,
} from "@/lib/application-fee-waiver-scope.server";
import { requireManagerRouteUser } from "@/lib/manager-route-guard.server";

export const runtime = "nodejs";

/**
 * GET - list waiver codes and redemption history. Without `?propertyId=` these are the signed-in manager's OWN
 * (the Settings list). With it, the codes belong to that property's OWNER and are filtered to the ones covering
 * it, for the owner or a teammate holding Applications at `read` on it (a co-manager, or PropLane staff seated on
 * a service workspace). Never another manager's codes for a property the caller has no grant on.
 *
 * The property-scoped branch answers about ONE house and nothing else. A code covering several houses (or the
 * whole portfolio) is still listed, but its redemption history is cut to THIS property: a redemption carries an
 * applicant's email, so returning the code's other houses' rows would hand a caller scoped to one house the
 * applicants of every other house the code touches.
 *
 * A code the caller may read but not write is marked `readOnly` (`waiverCodeIsReadOnly`): a portfolio-wide code,
 * which is the owner's alone, and a multi-house code covering a house the caller holds no `applications: edit`
 * on. The row still shows (it really does waive on this house) with its write controls hidden, rather than
 * offering edits that `PATCH /[id]` would come back 404 or 403 on.
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
    const grant = createWaiverGrantReader(ctx.db, ctx.userId);
    const scope = await resolveWaiverCodeScope(ctx.db, ctx.userId, propertyId, "read", grant);
    if (!scope.ok) return NextResponse.json({ error: scope.error }, { status: scope.status });
    const [all, allRedemptions] = await Promise.all([
      listApplicationFeeWaiverCodes(ctx.db, scope.ownerUserId),
      listApplicationFeeWaiverRedemptions(ctx.db, scope.ownerUserId),
    ]);
    const covering = all.filter((c) => waiverCodeCoversProperty(c, propertyId));
    const ids = new Set(covering.map((c) => c.id));
    const codes = scope.callerIsOwner ? covering : await markReadOnly(ctx, scope.ownerUserId, covering, grant);
    return NextResponse.json({
      codes,
      redemptions: allRedemptions.filter((r) => ids.has(r.codeId) && r.propertyId === propertyId),
    });
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

/**
 * Stamp `readOnly` on every code in `codes` the caller may not write, from the request's one grant read.
 * The owner never needs this and never calls it.
 */
async function markReadOnly(
  ctx: { db: Parameters<typeof resolveWaiverWriteScope>[0]; userId: string },
  ownerUserId: string,
  codes: ApplicationFeeWaiverCode[],
  grant: WaiverGrantReader,
): Promise<ApplicationFeeWaiverCode[]> {
  const write = await resolveWaiverWriteScope(
    ctx.db,
    ctx.userId,
    ownerUserId,
    codes.flatMap((c) => waiverCodeLimitedPropertyIds(c)),
    grant,
  );
  return codes.map((c) => (waiverCodeIsReadOnly(c, write) ? { ...c, readOnly: true } : c));
}

/**
 * Terms the request asks for that the code the owner already holds does NOT have. Extending an existing code can
 * only widen WHERE it works - its cap, expiry and label stay whatever the owner set - so a request carrying a
 * different one is a conflict to report, never a term to silently drop on the floor.
 *
 * Only a value actually supplied counts: the Settings row always sends `maxUses: null` / `expiresAt: null` for
 * "no cap" and "never expires", which asks for nothing and must not read as a demand to clear the owner's terms.
 */
function conflictingTerm(existing: ApplicationFeeWaiverCode, body: CreateBody): boolean {
  if (body.maxUses != null && Math.round(Number(body.maxUses)) !== existing.maxUses) return true;
  const asked = typeof body.expiresAt === "string" ? Date.parse(body.expiresAt) : NaN;
  if (Number.isFinite(asked)) {
    const held = existing.expiresAt ? Date.parse(existing.expiresAt) : NaN;
    if (!Number.isFinite(held) || held !== asked) return true;
  }
  const label = body.label?.trim() ?? "";
  if (label && label !== (existing.label ?? "")) return true;
  return false;
}

/**
 * POST - create a waiver code. A code belongs to the PROPERTY'S OWNER (redemption looks codes up under the owner),
 * so a property limit is resolved from the database, never the body: every property must belong to one owner, and
 * the caller must be that owner or hold Applications at `edit` on each (a co-manager, or PropLane staff seated on a
 * service workspace - the seat IS that grant). A code with no property limit stays the caller's own portfolio-wide
 * code. Adding text the owner already has is idempotent: an active property-limited code gains this property,
 * a portfolio-wide one already covers it, and a turned-off / expired / used-up one is a 409, never revived. Such a
 * response carries `extended: true` so the screen says the code was added to an existing one rather than created.
 * A request that also asks for a DIFFERENT cap, expiry or label is a 409 instead: extending only widens where a
 * code works, so those terms would be dropped, and the manager would be told a code was created with terms it
 * does not have. An extend response carries the same `readOnly` stamp GET computes for this caller, because the
 * inline row merges it straight into its list - an unstamped copy put the dead controls back.
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
  const grant = createWaiverGrantReader(ctx.db, ctx.userId);
  if (propertyIds && propertyIds.length > 0) {
    const scope = await resolveWaiverPropertiesScope(ctx.db, ctx.userId, propertyIds, "edit", { grant });
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
        if (conflictingTerm(existing, body)) {
          return NextResponse.json({ error: "That code already exists. Edit it from Settings." }, { status: 409 });
        }
        const current = waiverCodeLimitedPropertyIds(existing);
        const wanted = [...new Set(propertyIds.map((id) => id.trim()).filter(Boolean))];
        if (wanted.every((id) => waiverCodeCoversProperty(existing, id))) {
          const [code] = ownerUserId === ctx.userId ? [existing] : await markReadOnly(ctx, ownerUserId, [existing], grant);
          return NextResponse.json({ code, extended: true });
        }
        if (ownerUserId !== ctx.userId) {
          // Widening a code also widens what it waives on its other houses: a teammate may only do that when they
          // hold Applications at edit on every house it already covers. A house that was since DELETED is dropped
          // first - a stale id in `property_ids` (the column has no foreign key) must not lock the code forever.
          const widen = await resolveWaiverPropertiesScope(ctx.db, ctx.userId, current, "edit", { ignoreUnknown: true, grant });
          if (!widen.ok) return NextResponse.json({ error: widen.error }, { status: widen.status });
          if (widen.knownPropertyIds.length > 0 && widen.ownerUserId !== ownerUserId) {
            return NextResponse.json({ error: "Forbidden." }, { status: 403 });
          }
        }
        const updated = await updateApplicationFeeWaiverCode(ctx.db, ownerUserId, existing.id, {
          propertyIds: [...new Set([...current, ...wanted])],
        });
        if (!updated.ok) return NextResponse.json({ error: updated.error }, { status: updated.status });
        const [code] = ownerUserId === ctx.userId ? [updated.code] : await markReadOnly(ctx, ownerUserId, [updated.code], grant);
        return NextResponse.json({ code, extended: true });
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
