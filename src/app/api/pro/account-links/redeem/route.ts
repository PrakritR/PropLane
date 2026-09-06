import { NextResponse } from "next/server";
import {
  asStringArray,
  serializeInvite,
  type InviteRow,
} from "@/lib/account-link-invite-row";
import { looksLikeAccountLinksMissingTable } from "@/lib/account-links";
import { findPropertyIdsNotOwnedByManager } from "@/lib/auth/co-manager-invite-scope";
import { ensureProfileRoleRow } from "@/lib/auth/profile-role-row";
import { findPendingOpenInviteByToken, openInviteIsExpired } from "@/lib/co-manager-open-invite.server";
import { managerPlanAllowsCoManagerInvites } from "@/lib/co-manager-plan-access.server";
import { hashCoManagerInviteToken } from "@/lib/co-manager-invite-token";
import { maxAccountLinksForTier } from "@/lib/manager-access";
import { ensureProfileProplaneId, getManagerPurchaseSku } from "@/lib/manager-access-server";
import { isCrossSandboxPortalPair, CROSS_SANDBOX_PORTAL_PAIR_ERROR } from "@/lib/portal-sandbox-accounts";
import { labelFromManagerPropertyRecordRow } from "@/lib/co-manager-property-label";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { bestEffortFailed } from "@/lib/observability/best-effort";

export const runtime = "nodejs";

function missingTableResponse() {
  return NextResponse.json(
    {
      error:
        "Database is missing account_link_invites. Apply supabase/migrations/20260422120000_account_link_invites.sql.",
      migrationRequired: true,
    },
    { status: 503 },
  );
}

async function previewOpenInvite(token: string) {
  const svc = createSupabaseServiceRoleClient();
  const found = await findPendingOpenInviteByToken(svc, token);
  if (!found.ok) {
    if (found.missingTable) return missingTableResponse();
    return NextResponse.json({ error: found.error }, { status: 500 });
  }
  const row = found.row;
  if (!row?.id || openInviteIsExpired(row)) {
    return NextResponse.json({ error: "This invite link is invalid or has expired." }, { status: 404 });
  }

  const assignedPropertyIds = asStringArray(row.assigned_property_ids);
  const propertyLabels: string[] = [];
  if (assignedPropertyIds.length > 0) {
    const { data: props } = await svc
      .from("manager_property_records")
      .select("id, property_data, row_data")
      .in("id", assignedPropertyIds);
    for (const prop of props ?? []) {
      propertyLabels.push(labelFromManagerPropertyRecordRow(prop));
    }
  }

  return NextResponse.json({
    ok: true,
    inviterDisplayName: String(row.inviter_display_name ?? "").trim() || "A property manager",
    propertyLabels,
    expiresAt: row.expires_at ?? null,
  });
}

export async function GET(req: Request) {
  try {
    const token = new URL(req.url).searchParams.get("token")?.trim() ?? "";
    if (!token) {
      return NextResponse.json({ error: "Invite token is required." }, { status: 400 });
    }
    return await previewOpenInvite(token);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as { token?: string } | null;
    const token = body?.token?.trim() ?? "";
    if (!token) {
      return NextResponse.json({ error: "Invite token is required." }, { status: 400 });
    }

    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Sign in to join this team." }, { status: 401 });
    }

    const svc = createSupabaseServiceRoleClient();
    const found = await findPendingOpenInviteByToken(svc, token);
    if (!found.ok) {
      if (found.missingTable) return missingTableResponse();
      return NextResponse.json({ error: found.error }, { status: 500 });
    }
    const row = found.row as InviteRow | null;
    if (!row?.id || openInviteIsExpired(row)) {
      return NextResponse.json({ error: "This invite link is invalid or has expired." }, { status: 404 });
    }

    if (row.inviter_user_id === user.id) {
      return NextResponse.json({ error: "You cannot join your own invite." }, { status: 400 });
    }

    const inviterSku = await getManagerPurchaseSku(row.inviter_user_id);
    if (inviterSku.readFailed || !managerPlanAllowsCoManagerInvites(inviterSku)) {
      return NextResponse.json({ error: "The inviting manager needs an active Pro or Business plan." }, { status: 403 });
    }

    const assignedPropertyIds = asStringArray(row.assigned_property_ids);
    const ownership = await findPropertyIdsNotOwnedByManager(svc, row.inviter_user_id, assignedPropertyIds);
    if (!ownership.ok) {
      return NextResponse.json({ error: ownership.error }, { status: 500 });
    }
    if (ownership.unowned.length > 0) {
      return NextResponse.json(
        {
          error:
            "This link assigns a property the inviting manager does not manage. Ask them to send a new invite.",
        },
        { status: 403 },
      );
    }

    const inviteeResolved = await ensureProfileProplaneId(svc, user.id);
    if (!inviteeResolved.ok) {
      return NextResponse.json({ error: inviteeResolved.error }, { status: 400 });
    }

    const { data: participantProfiles, error: profilesError } = await svc
      .from("profiles")
      .select("id, email")
      .in("id", [row.inviter_user_id, user.id]);
    if (profilesError || participantProfiles?.length !== 2) {
      return NextResponse.json({ error: "Unable to verify team participants." }, { status: 503 });
    }
    const emailByUserId = new Map(
      (participantProfiles ?? []).map((p) => [String(p.id ?? "").trim(), String(p.email ?? "").trim()] as const),
    );
    if (isCrossSandboxPortalPair(emailByUserId.get(row.inviter_user_id) ?? "", emailByUserId.get(user.id) ?? "")) {
      return NextResponse.json({ error: CROSS_SANDBOX_PORTAL_PAIR_ERROR }, { status: 400 });
    }

    const { data: existingLink, error: existingErr } = await svc
      .from("account_link_invites")
      .select("id,status")
      .eq("tab_kind", row.tab_kind)
      .in("status", ["pending", "accepted"])
      .or(
        `and(inviter_user_id.eq.${row.inviter_user_id},invitee_user_id.eq.${user.id}),and(inviter_user_id.eq.${user.id},invitee_user_id.eq.${row.inviter_user_id})`,
      )
      .limit(1)
      .maybeSingle();
    if (existingErr) {
      if (looksLikeAccountLinksMissingTable(existingErr)) return missingTableResponse();
      return NextResponse.json({ error: existingErr.message }, { status: 500 });
    }
    if (existingLink) {
      return NextResponse.json(
        { error: "These workspaces already have a pending or active link for this role." },
        { status: 409 },
      );
    }

    const { tier: inviteeTier, readFailed: inviteePlanReadFailed } = await getManagerPurchaseSku(user.id);
    if (inviteePlanReadFailed) {
      return NextResponse.json({ error: "Unable to verify your plan." }, { status: 503 });
    }
    const inviteeLinkCap = maxAccountLinksForTier(inviteeTier);
    if (inviteeLinkCap != null) {
      const { count: inviteeUsed, error: capErr } = await svc
        .from("account_link_invites")
        .select("id", { count: "exact", head: true })
        .eq("tab_kind", row.tab_kind)
        .in("status", ["pending", "accepted"])
        .or(`inviter_user_id.eq.${user.id},invitee_user_id.eq.${user.id}`);
      if (capErr) {
        if (looksLikeAccountLinksMissingTable(capErr)) return missingTableResponse();
        return NextResponse.json({ error: capErr.message }, { status: 500 });
      }
      if ((inviteeUsed ?? 0) >= inviteeLinkCap) {
        return NextResponse.json(
          {
            error: `You already have ${inviteeUsed ?? 0} of ${inviteeLinkCap} allowed team links. Upgrade to join another team.`,
          },
          { status: 403 },
        );
      }
    }

    await ensureProfileRoleRow(svc, user.id, "manager");

    const { data: updated, error: claimErr } = await svc
      .from("account_link_invites")
      .update({
        invitee_user_id: user.id,
        invitee_axis_id: inviteeResolved.proplaneId,
        invitee_display_name: inviteeResolved.fullName?.trim() || inviteeResolved.email || null,
        status: "accepted",
        responded_at: new Date().toISOString(),
        invite_token_hash: null,
      })
      .eq("id", row.id)
      // Reject rotation and scope changes since ownership was checked above.
      .eq("invite_token_hash", hashCoManagerInviteToken(token))
      .eq("assigned_property_ids", JSON.stringify(row.assigned_property_ids))
      .eq("status", "pending")
      .is("invitee_user_id", null)
      .select("*")
      .maybeSingle();

    if (claimErr) {
      if (looksLikeAccountLinksMissingTable(claimErr)) return missingTableResponse();
      return NextResponse.json({ error: claimErr.message }, { status: 500 });
    }
    if (!updated) {
      return NextResponse.json({ error: "This invite link is no longer available." }, { status: 409 });
    }

    void (async () => {
      try {
        const { notifyCoManagerInviteAccepted } = await import("@/lib/co-manager-notification.server");
        await notifyCoManagerInviteAccepted({
          inviterUserId: row.inviter_user_id,
          inviteeUserId: user.id,
          inviteeName: inviteeResolved.fullName?.trim() || inviteeResolved.email || "Your co-manager",
        });
      } catch (error) {
        bestEffortFailed("co-manager open-invite accepted notification", { invite: row.id })(error);
      }
    })();

    return NextResponse.json({ ok: true, invite: serializeInvite(updated as InviteRow, user.id) });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
