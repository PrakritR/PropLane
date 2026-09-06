import { NextResponse } from "next/server";
import {
  asStringArray,
  serializeInvite,
  type InviteRow,
} from "@/lib/account-link-invite-row";
import { looksLikeAccountLinksMissingTable } from "@/lib/account-links";
import { findPropertyIdsNotOwnedByManager } from "@/lib/auth/co-manager-invite-scope";
import { getManagerPurchaseSku } from "@/lib/manager-access-server";
import { managerPlanAllowsCoManagerInvites } from "@/lib/co-manager-plan-access.server";
import { mintOpenCoManagerInvite } from "@/lib/co-manager-open-invite.server";
import { flatCoManagerPermissionsFromProperty, normalizePropertyCoManagerPermissions } from "@/lib/co-manager-permissions";
import { resolveRequestOrigin } from "@/lib/app-url";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

/** Rotate the shareable token on a pending open invite and return a fresh URL. */
export async function POST(req: Request, ctx: { params: Promise<{ inviteId: string }> }) {
  try {
    const { inviteId } = await ctx.params;
    const id = inviteId?.trim() ?? "";
    if (!id) {
      return NextResponse.json({ error: "inviteId is required." }, { status: 400 });
    }

    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }

    const svc = createSupabaseServiceRoleClient();
    const { data, error } = await svc.from("account_link_invites").select("*").eq("id", id).maybeSingle();
    if (error) {
      if (looksLikeAccountLinksMissingTable(error)) {
        return NextResponse.json(
          {
            error:
              "Database is missing account_link_invites. Apply supabase/migrations/20260422120000_account_link_invites.sql.",
            migrationRequired: true,
          },
          { status: 503 },
        );
      }
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const invite = data as InviteRow | null;
    if (!invite?.id) {
      return NextResponse.json({ error: "Invite not found." }, { status: 404 });
    }
    if (invite.inviter_user_id !== user.id) {
      return NextResponse.json({ error: "Only the inviter can copy this link." }, { status: 403 });
    }
    if (invite.status !== "pending" || invite.invitee_user_id) {
      return NextResponse.json({ error: "Only an unused invite link can be refreshed." }, { status: 409 });
    }

    const assignedPropertyIds = asStringArray(invite.assigned_property_ids);
    const sku = await getManagerPurchaseSku(user.id);
    if (sku.readFailed || !managerPlanAllowsCoManagerInvites(sku)) {
      return NextResponse.json({ error: "Upgrade to Pro or Business before linking co-managers." }, { status: 403 });
    }
    const ownership = await findPropertyIdsNotOwnedByManager(svc, user.id, assignedPropertyIds);
    if (!ownership.ok) return NextResponse.json({ error: ownership.error }, { status: 500 });
    if (ownership.unowned.length > 0) {
      return NextResponse.json({ error: "Update this invite to include only properties you manage." }, { status: 403 });
    }
    const propertyCoManagerPermissions = normalizePropertyCoManagerPermissions(
      invite.property_co_manager_permissions ?? invite.co_manager_permissions,
      assignedPropertyIds,
    );

    const minted = await mintOpenCoManagerInvite({
      svc,
      existingId: invite.id,
      inviterUserId: user.id,
      inviterAxisId: invite.inviter_axis_id,
      inviterDisplayName: invite.inviter_display_name,
      assignedPropertyIds,
      payoutPercentForManager: Number(invite.payout_percent_for_manager),
      propertyCoManagerPermissions,
      coManagerPermissions: flatCoManagerPermissionsFromProperty(propertyCoManagerPermissions),
      tabKind: invite.tab_kind,
      requestOrigin: resolveRequestOrigin(req),
    });
    if (!minted.ok) {
      return NextResponse.json({ error: minted.error }, { status: minted.status });
    }

    return NextResponse.json({
      ok: true,
      invite: serializeInvite(minted.row as InviteRow, user.id),
      inviteUrl: minted.inviteUrl,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
