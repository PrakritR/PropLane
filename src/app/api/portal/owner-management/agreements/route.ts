import { NextResponse } from "next/server";
import { getReportsAuthContext } from "@/lib/reports/auth";
import {
  AgreementError,
  actorMayManageAgreement,
  createDraftAgreement,
  listOwnerCandidates,
  loadCurrentAgreementForProperty,
  loadPropertyOwnerOfRecord,
  type AgreementActor,
} from "@/lib/owner-management/agreements.server";
import {
  agreementErrorResponse,
  ownerPayoutReady,
  parseTermsBody,
  presentAgreement,
} from "@/lib/owner-management/agreements-api.server";

export const runtime = "nodejs";

async function actorFor(): Promise<{ actor: AgreementActor; db: NonNullable<Awaited<ReturnType<typeof getReportsAuthContext>>>["db"] } | NextResponse> {
  const auth = await getReportsAuthContext({ preferRole: "manager" });
  if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  if (auth.role !== "manager" && auth.role !== "admin") return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  return { actor: { role: auth.role, userId: auth.userId }, db: auth.db };
}

/** GET ?propertyId= : the house's current agreement plus the people who can be named as its owner. */
export async function GET(req: Request) {
  const ctx = await actorFor();
  if (ctx instanceof NextResponse) return ctx;
  const propertyId = new URL(req.url).searchParams.get("propertyId")?.trim() ?? "";
  if (!propertyId) return NextResponse.json({ error: "propertyId is required." }, { status: 400 });
  try {
    const property = await loadPropertyOwnerOfRecord(ctx.db, propertyId);
    if (!property || !actorMayManageAgreement(ctx.actor, property.managerUserId)) return NextResponse.json({ error: "Not found." }, { status: 404 });
    const [row, candidates] = await Promise.all([
      loadCurrentAgreementForProperty(ctx.db, property.id),
      listOwnerCandidates(ctx.db, property.managerUserId, property.id),
    ]);
    const owner = row ? candidates.find((c) => c.userId === row.ownerUserId) : null;
    let ownerName = owner?.name ?? "";
    if (row && !ownerName) {
      const { data } = await ctx.db.from("profiles").select("full_name, email").eq("id", row.ownerUserId).maybeSingle();
      ownerName = String((data as { full_name?: string; email?: string } | null)?.full_name || (data as { email?: string } | null)?.email || "Owner");
    }
    return NextResponse.json({
      agreement: row ? presentAgreement(row, ownerName, await ownerPayoutReady(ctx.db, row.ownerUserId)) : null,
      candidates,
    });
  } catch (e) {
    return agreementErrorResponse(e, "Could not load the agreement.");
  }
}

/** POST { propertyId, ownerUserId, startsOn, endsOn?, ...terms } : draft an agreement. */
export async function POST(req: Request) {
  const ctx = await actorFor();
  if (ctx instanceof NextResponse) return ctx;
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const terms = parseTermsBody(body);
  if (!terms) return NextResponse.json({ error: "Check the fee amounts." }, { status: 400 });
  try {
    const row = await createDraftAgreement(ctx.db, ctx.actor, {
      propertyId: String(body.propertyId ?? "").trim(),
      ownerUserId: String(body.ownerUserId ?? "").trim(),
      terms,
      startsOn: String(body.startsOn ?? "").trim(),
      endsOn: body.endsOn ? String(body.endsOn).trim() : null,
    });
    return NextResponse.json({ agreement: presentAgreement(row, "", null) }, { status: 201 });
  } catch (e) {
    if (e instanceof AgreementError) return agreementErrorResponse(e, "Could not save the agreement.");
    return agreementErrorResponse(e, "Could not save the agreement.");
  }
}
