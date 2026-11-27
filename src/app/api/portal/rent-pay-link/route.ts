import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveManagerWorkspaceRowScope, rowInWorkspaceScope } from "@/lib/auth/co-manager-module-scope";
import { managerHasCoManagerPermissionForProperty } from "@/lib/auth/manager-lease-scope";
import { mintResidentRentPayLink } from "@/lib/payments/rent-reminder-links.server";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };

const ERRORS: Record<string, { status: number; error: string }> = {
  charge_not_found: { status: 404, error: "Charge not found." },
  not_yours: { status: 404, error: "Charge not found." },
  not_payable: { status: 409, error: "This charge is already paid or closed." },
  mixed_charges: { status: 422, error: "Choose charges for one resident in one home." },
  no_phone_on_file: { status: 422, error: "Add the resident's phone to their lease first." },
  rate_limited: { status: 429, error: "Too many links for this number. Try again in an hour." },
  links_unavailable: { status: 503, error: "Links are unavailable for this workspace right now." },
};

/**
 * The resident's phone-bound pay link for one open charge (or a few of one resident's), for a reminder the manager
 * texts from the work number. Mints the link only; sends nothing. Works for a resident with no PropLane login: the
 * link is bound to the phone on their lease. The answer names only the last four digits of that phone.
 */
export async function POST(req: Request) {
  try {
    const auth = await createSupabaseServerClient();
    const { data: { user } } = await auth.auth.getUser();
    if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401, headers: NO_STORE });
    const body = (await req.json().catch(() => null)) as { chargeId?: unknown; chargeIds?: unknown } | null;
    const raw = Array.isArray(body?.chargeIds) ? body!.chargeIds : [body?.chargeId];
    const chargeIds = raw.filter((id): id is string => typeof id === "string" && id.trim().length > 0).map((id) => id.trim());
    if (chargeIds.length === 0 || chargeIds.length > 10) {
      return NextResponse.json({ error: "Choose a charge." }, { status: 400, headers: NO_STORE });
    }

    const db = createSupabaseServiceRoleClient();
    const scope = await resolveManagerWorkspaceRowScope(db, user.id);
    let owner = "";
    for (const id of chargeIds) {
      const { data: row, error } = await db
        .from("portal_household_charge_records")
        .select("manager_user_id, property_id")
        .eq("id", id)
        .maybeSingle();
      if (error) throw error;
      const rowOwner = String(row?.manager_user_id ?? "");
      const property = row?.property_id ? String(row.property_id) : null;
      // Same rule as taking a payment: the payee, or a teammate with Payments at edit on this house, in this workspace.
      const canCollect = rowOwner === user.id ||
        Boolean(property && await managerHasCoManagerPermissionForProperty(db, user.id, property, "payments", "edit"));
      if (!row || !rowOwner || !canCollect || !rowInWorkspaceScope(property, scope) || (owner && owner !== rowOwner)) {
        return NextResponse.json({ error: "Charge not found." }, { status: 404, headers: NO_STORE });
      }
      owner = rowOwner;
    }

    const minted = await mintResidentRentPayLink(db, { chargeIds, ownerUserId: owner, createdBy: user.id });
    if (!minted.ok) {
      const mapped = ERRORS[minted.error] ?? ERRORS.links_unavailable!;
      return NextResponse.json({ error: mapped.error, code: minted.error }, { status: mapped.status, headers: NO_STORE });
    }
    return NextResponse.json(minted, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: "Could not make the link." }, { status: 500, headers: NO_STORE });
  }
}
