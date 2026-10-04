import { NextResponse } from "next/server";
import { authorizeResidentRole } from "@/lib/auth/resident-role-access";
import { redeemLeaseFeeWaiverCode } from "@/lib/lease-fee-waiver.server";
import { rateLimit } from "@/lib/rate-limit";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

type Body = { leaseId?: string; code?: string };

/**
 * POST - the resident enters a waive code on the pay-before-signing step. A valid lease (or both) code
 * cancels the lease fee exactly like the manager's per-lease waiver. Everything that matters is decided
 * server-side by `redeemLeaseFeeWaiverCode`: the caller must be on the lease, the code must be the lease
 * manager's own and apply to the lease fee on that property, the fee must not be paid, and the use is
 * spent atomically. The body carries only the lease id and the typed code - never a manager id, property
 * id or amount. Rate-limited per resident to slow down code guessing.
 */
export async function POST(req: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user?.id) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const db = createSupabaseServiceRoleClient();
    const { data: profile } = await db.from("profiles").select("email, role").eq("id", user.id).maybeSingle();
    const isResident = await authorizeResidentRole(db, { userId: user.id, legacyRole: profile?.role });
    if (!isResident) return NextResponse.json({ error: "Residents only." }, { status: 403 });
    const email = (profile?.email ?? user.email ?? "").trim().toLowerCase();
    if (!email) return NextResponse.json({ error: "No email on file." }, { status: 400 });

    if (!(await rateLimit(`lease-fee-waiver-code:${user.id}`, 10, 60_000)).ok) {
      return NextResponse.json({ error: "Too many tries. Please wait a minute." }, { status: 429 });
    }

    const body = (await req.json().catch(() => ({}))) as Body;
    const leaseId = typeof body.leaseId === "string" ? body.leaseId.trim() : "";
    const code = typeof body.code === "string" ? body.code.trim() : "";
    if (!leaseId || !code) {
      return NextResponse.json({ error: "leaseId and code are required." }, { status: 400 });
    }

    const result = await redeemLeaseFeeWaiverCode(db, {
      residentUserId: user.id,
      residentEmail: email,
      leaseId,
      code,
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error, code: result.reason }, { status: result.status });
    }
    return NextResponse.json({
      ok: true,
      waived: true,
      alreadyWaived: result.alreadyWaived,
      cancelledChargeIds: result.cancelledChargeIds,
    });
  } catch (e) {
    console.error("[lease-fee-waiver-code] failed", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "We couldn't apply that code just now. Please try again in a moment." }, { status: 500 });
  }
}
