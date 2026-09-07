import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import {
  listResidentInviteClaims,
  resolveResidentInviteClaim,
} from "@/lib/invite-links/invite-links.server";

export const runtime = "nodejs";

async function sessionUserId(): Promise<string | null> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user?.id ?? null;
}

/**
 * People who opened a resident invite link and said they live at one of the
 * manager's properties.
 *
 * Owner-scoped in the query, not by a filter the caller supplies: a claim id is
 * not authority, and a manager may only ever see claims filed against their own
 * link.
 */
export async function GET(req: Request) {
  const userId = await sessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const raw = searchParams.get("status")?.trim();
  // Allowlist: an unrecognised status reads as `pending`, the state that grants
  // nothing, rather than widening the listing.
  const status = raw === "approved" ? "approved" : raw === "rejected" ? "rejected" : "pending";

  const claims = await listResidentInviteClaims(createSupabaseServiceRoleClient(), userId, status);
  return NextResponse.json({ claims });
}

/**
 * Approve a claim onto a resident record, or dismiss it.
 *
 * Approving REQUIRES the manager to name the resident record — there is no
 * server-side matching of a claimant's self-asserted email against
 * `manager_application_records.resident_email`, because that address comes from
 * an account created moments earlier by whoever the link reached. The manager
 * looking at the name, the property and the room is the check.
 */
export async function PATCH(req: Request) {
  const userId = await sessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as {
    claimId?: string;
    status?: string;
    linkedApplicationId?: string;
  };

  const claimId = body.claimId?.trim() ?? "";
  if (!claimId) return NextResponse.json({ error: "claimId required" }, { status: 400 });
  if (body.status !== "approved" && body.status !== "rejected") {
    return NextResponse.json({ error: "status must be approved or rejected" }, { status: 400 });
  }

  const result = await resolveResidentInviteClaim(createSupabaseServiceRoleClient(), {
    ownerUserId: userId,
    claimId,
    status: body.status,
    linkedApplicationId: body.linkedApplicationId ?? null,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

  // Every onboarding path ends with a create-account link, and this one is no
  // exception: the claimant proved an email, the manager confirmed the tenancy,
  // so the account-setup mail goes out on the same action rather than leaving
  // the manager to remember a second step.
  //
  // Sent, not returned. The setup token is a claim capability — whoever holds
  // it becomes that resident — so it leaves only by email to the address on the
  // record, exactly as `api/auth/resident-setup-link` does. It never reaches
  // this response, and a failure to send does not undo the approval the manager
  // already made.
  let setupLinkSent = false;
  if (body.status === "approved") {
    try {
      const res = await fetch(new URL("/api/auth/resident-setup-link", req.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: result.claim.claimantEmail }),
      });
      const sent = (await res.json().catch(() => ({}))) as { sent?: boolean };
      setupLinkSent = res.ok && sent.sent === true;
    } catch {
      /* The approval stands; the manager can resend the setup link. */
    }
  }

  return NextResponse.json({ claim: result.claim, setupLinkSent });
}
