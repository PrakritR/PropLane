import { NextResponse } from "next/server";
import { getReportsAuthContext } from "@/lib/reports/auth";
import {
  endAgreement,
  loadAgreement,
  sendAgreementForSignature,
  updateDraftAgreement,
  type AgreementActor,
} from "@/lib/owner-management/agreements.server";
import { agreementErrorResponse, parseTermsBody, presentAgreement } from "@/lib/owner-management/agreements-api.server";

export const runtime = "nodejs";

/**
 * PATCH { action: "update" | "send" | "end", ...fields }. The manager is the property's own manager (re-derived
 * inside every function); the body names the agreement and nothing about who may act.
 */
export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await getReportsAuthContext({ preferRole: "manager" });
  if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  if (auth.role !== "manager" && auth.role !== "admin") return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  const actor: AgreementActor = { role: auth.role, userId: auth.userId };
  const { id } = await context.params;
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    if (body.action === "send") {
      const result = await sendAgreementForSignature(auth.db, actor, id);
      return NextResponse.json({ agreement: presentAgreement(result.agreement, "", null), emailed: result.emailed, texted: result.texted });
    }
    if (body.action === "end") {
      const row = await endAgreement(auth.db, actor, id);
      return NextResponse.json({ agreement: presentAgreement(row, "", null) });
    }
    if (body.action === "update") {
      const current = await loadAgreement(auth.db, id);
      if (!current) return NextResponse.json({ error: "Agreement not found." }, { status: 404 });
      const terms = parseTermsBody(body, current.terms);
      if (!terms) return NextResponse.json({ error: "Check the fee amounts." }, { status: 400 });
      const row = await updateDraftAgreement(auth.db, actor, id, {
        terms,
        ...(typeof body.startsOn === "string" ? { startsOn: body.startsOn.trim() } : {}),
        ...("endsOn" in body ? { endsOn: body.endsOn ? String(body.endsOn).trim() : null } : {}),
        ...(typeof body.ownerUserId === "string" ? { ownerUserId: body.ownerUserId.trim() } : {}),
      });
      return NextResponse.json({ agreement: presentAgreement(row, "", null) });
    }
    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (e) {
    return agreementErrorResponse(e, "Could not update the agreement.");
  }
}
