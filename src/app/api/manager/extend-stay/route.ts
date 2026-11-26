import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveAuthenticatedBusinessAccess } from "@/lib/test-workspaces/index.server";
import { refuseOwnerOnly } from "@/lib/property-owner/route-auth.server";
import { prepareStayExtension, completeStayExtension, StayExtensionError, type StayExtension } from "@/lib/lease-stay-extension.server";
export const runtime = "nodejs";
async function handle(req: NextRequest, commit: boolean) {
  try {
    const client = await createSupabaseServerClient();
    const { data: { user } } = await client.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const db = createSupabaseServiceRoleClient();
    const ownerRefusal = await refuseOwnerOnly(db, user.id);
    if (ownerRefusal) return ownerRefusal;
    if ((await resolveAuthenticatedBusinessAccess(user.id, db)).kind === "denied") return NextResponse.json({ error: "Account access unavailable." }, { status: 403 });
    const roles = await db.from("profile_roles").select("role").eq("user_id", user.id);
    if (roles.error || !roles.data.some((r) => r.role === "manager" || r.role === "admin")) return NextResponse.json({ error: "Managers only." }, { status: 403 });
    const body = await req.json();
    if (typeof body.leaseId !== "string" || typeof body.checkout !== "string") return NextResponse.json({ error: "Provide a lease and checkout date." }, { status: 400 });
    const prepared = await prepareStayExtension(db, user.id, body.leaseId, body.checkout);
    if (!commit) return NextResponse.json(prepared.existing ? { extension: prepared.existing, saved: true } : { extension: prepared.extension, token: prepared.token });
    let extension = prepared.existing;
    if (!extension) {
      if (!body.token || body.token !== prepared.token) return NextResponse.json({ error: "The quote changed. Review the extension again." }, { status: 409 });
      const result = await db.rpc("commit_stay_extension", { p_owner: prepared.record.manager_user_id, p_actor: user.id, p_property: prepared.record.property_id, p_revision: prepared.revision, p_application_id: prepared.applicationRecord!.id, p_expected_application: prepared.applicationRecord!.row_data, p_lease_id: prepared.record.id, p_expected_lease: prepared.record.row_data, p_extension: prepared.extension, p_expected_charges: prepared.expectedCharges, p_charges: prepared.charges });
      if (result.error) throw new StayExtensionError(result.error.message);
      extension = result.data as StayExtension;
    }
    try {
      const notification = await completeStayExtension(db, prepared.record, extension, user);
      return NextResponse.json({ ok: true, extension, notification });
    } catch {
      return NextResponse.json({ ok: true, extension, warning: "Stay and charges saved. Retry to finish ledger reconciliation and the resident notice.", retryDelivery: true }, { status: 202 });
    }
  } catch (error) {
    return NextResponse.json({ error: error instanceof StayExtensionError ? error.message : "Could not verify or save the extension. Try again." }, { status: error instanceof StayExtensionError ? error.status : 503 });
  }
}
export const PUT = (req: NextRequest) => handle(req, false);
export const POST = (req: NextRequest) => handle(req, true);
