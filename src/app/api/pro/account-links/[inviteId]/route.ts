import { NextResponse } from "next/server";
import { asStringArray, readPropertyPermissionsFromRow, serializeInvite, type InviteRow } from "@/lib/account-link-invite-row";
import { looksLikeAccountLinksMissingTable } from "@/lib/account-links";
import { findPropertyIdsNotOwnedByManager } from "@/lib/auth/co-manager-invite-scope";
import {
  normalizePropertyCoManagerPermissions,
  prunePropertyCoManagerPermissions,
} from "@/lib/co-manager-permissions";
import { isCrossSandboxPortalPair, CROSS_SANDBOX_PORTAL_PAIR_ERROR } from "@/lib/portal-sandbox-accounts";
import { scopedRelationshipDeletesForRevokedInvite } from "@/lib/pro-relationships";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { bestEffortFailed } from "@/lib/observability/best-effort";

export const runtime = "nodejs";

export async function PATCH(req: Request, ctx: { params: Promise<{ inviteId: string }> }) {
  try {
    const { inviteId } = await ctx.params;
    const id = inviteId?.trim() ?? "";
    if (!id) {
      return NextResponse.json({ error: "inviteId is required." }, { status: 400 });
    }

    const body = (await req.json().catch(() => null)) as {
      action?: string;
      assignedPropertyIds?: unknown;
      payoutPercentForManager?: number;
      coManagerPermissions?: unknown;
      propertyCoManagerPermissions?: unknown;
      propertyId?: string;
      permissions?: unknown;
    } | null;

    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }

    const svc = createSupabaseServiceRoleClient();

    const { data: row, error: fetchErr } = await svc.from("account_link_invites").select("*").eq("id", id).maybeSingle();

    if (fetchErr) {
      if (looksLikeAccountLinksMissingTable(fetchErr)) {
        return NextResponse.json(
          {
            error:
              "Database is missing account_link_invites. Apply supabase/migrations/20260422120000_account_link_invites.sql.",
            migrationRequired: true,
          },
          { status: 503 },
        );
      }
      return NextResponse.json({ error: fetchErr.message }, { status: 500 });
    }

    const invite = row as InviteRow | null;
    if (!invite?.id) {
      return NextResponse.json({ error: "Invite not found." }, { status: 404 });
    }

    const actionNorm = body?.action != null ? String(body.action).toLowerCase().trim() : "";
    const patchProps = body?.assignedPropertyIds !== undefined;
    const patchPay = body?.payoutPercentForManager !== undefined;
    const patchPerms =
      body?.coManagerPermissions !== undefined ||
      body?.propertyCoManagerPermissions !== undefined ||
      (body?.propertyId !== undefined && body?.permissions !== undefined);

    if (!actionNorm && !patchProps && !patchPay && !patchPerms) {
      return NextResponse.json({ error: "Provide action or fields to update." }, { status: 400 });
    }

    if (actionNorm === "revoke") {
      if (invite.status !== "accepted") {
        return NextResponse.json({ error: "Only an active link can be revoked." }, { status: 409 });
      }
      if (invite.inviter_user_id !== user.id && invite.invitee_user_id !== user.id) {
        return NextResponse.json({ error: "Forbidden." }, { status: 403 });
      }
      const { data: updated, error: upErr } = await svc
        .from("account_link_invites")
        .update({ status: "cancelled", responded_at: new Date().toISOString() })
        .eq("id", id)
        .eq("status", "accepted")
        .select("*")
        .maybeSingle();

      if (upErr) {
        return NextResponse.json({ error: upErr.message }, { status: 500 });
      }

      await svc.from("portal_pro_relationship_records").delete().eq("id", id);

      for (const scope of scopedRelationshipDeletesForRevokedInvite(invite)) {
        await svc
          .from("portal_pro_relationship_records")
          .delete()
          .eq("manager_user_id", scope.managerUserId)
          .filter("row_data->>linkedAxisId", "eq", scope.linkedAxisId);
      }

      return NextResponse.json({ ok: true, invite: serializeInvite(updated as InviteRow, user.id) });
    }

    /** Inviter can edit houses/permissions on pending or accepted links; invitee may only edit payout after accept. */
    if (!actionNorm && (patchProps || patchPay || patchPerms)) {
      if (invite.status !== "accepted" && invite.status !== "pending") {
        return NextResponse.json({ error: "Only pending or accepted links can be updated this way." }, { status: 409 });
      }
      if (invite.status === "pending" && invite.inviter_user_id !== user.id) {
        return NextResponse.json({ error: "Only the primary manager can change a pending invite." }, { status: 403 });
      }
      if (invite.status === "accepted" && invite.inviter_user_id !== user.id && invite.invitee_user_id !== user.id) {
        return NextResponse.json({ error: "Forbidden." }, { status: 403 });
      }
      if (patchPerms && invite.inviter_user_id !== user.id) {
        return NextResponse.json({ error: "Only the primary manager can change co-manager permissions." }, { status: 403 });
      }
      // Security: the property scope defines what the co-manager may reach, so
      // only the inviter may change it. Previously *either* party could, which
      // let the invitee widen their own grant to arbitrary property ids.
      if (patchProps && invite.inviter_user_id !== user.id) {
        return NextResponse.json({ error: "Only the primary manager can change the property scope." }, { status: 403 });
      }

      const nextAssigned = patchProps ? asStringArray(body?.assignedPropertyIds) : asStringArray(invite.assigned_property_ids);
      // …and only over properties the inviter actually owns.
      if (patchProps) {
        const ownership = await findPropertyIdsNotOwnedByManager(svc, invite.inviter_user_id, nextAssigned);
        if (!ownership.ok) {
          return NextResponse.json({ error: ownership.error }, { status: 500 });
        }
        if (ownership.unowned.length > 0) {
          // Same reasoning as the create route: name what failed, because the
          // usual cause is a listing that has not synced yet (PRP-210).
          return NextResponse.json(
            {
              error: `${ownership.unowned.length === 1 ? "One selected property isn't" : `${ownership.unowned.length} selected properties aren't`} on your account yet (${ownership.unowned.join(", ")}). Open Properties to let them finish saving, then try again.`,
              unownedPropertyIds: ownership.unowned,
            },
            { status: 403 },
          );
        }
      }

      const nextPayout = patchPay
        ? Math.min(100, Math.max(0, Math.round(Number(body?.payoutPercentForManager) * 10) / 10))
        : Number(invite.payout_percent_for_manager);

      let nextPropertyPerms = readPropertyPermissionsFromRow(invite);
      if (patchPerms) {
        if (body?.propertyId && body?.permissions !== undefined) {
          const propertyId = String(body.propertyId).trim();
          if (!nextAssigned.includes(propertyId)) {
            return NextResponse.json({ error: "Property is not in this link." }, { status: 400 });
          }
          nextPropertyPerms = {
            ...nextPropertyPerms,
            [propertyId]: normalizePropertyCoManagerPermissions(
              { [propertyId]: body.permissions },
              [propertyId],
            )[propertyId],
          };
        } else {
          nextPropertyPerms = normalizePropertyCoManagerPermissions(
            body?.propertyCoManagerPermissions ?? body?.coManagerPermissions,
            nextAssigned,
          );
        }
      }
      nextPropertyPerms = prunePropertyCoManagerPermissions(nextPropertyPerms, nextAssigned);

      const { data: updated, error: upErr } = await svc
        .from("account_link_invites")
        .update({
          assigned_property_ids: nextAssigned,
          payout_percent_for_manager: nextPayout,
          property_co_manager_permissions: nextPropertyPerms,
        })
        .eq("id", id)
        .eq("status", invite.status)
        .select("*")
        .maybeSingle();

      if (upErr) {
        return NextResponse.json({ error: upErr.message }, { status: 500 });
      }

      // Keep relationship mirrors in lockstep with the invite so unlink shrinks
      // stick for both workspaces (residents / leases / charges scope).
      if (patchProps || patchPerms) {
        const updatedInvite = updated as InviteRow;
        const { data: mirrors } = await svc
          .from("portal_pro_relationship_records")
          .select("id, row_data")
          .eq("id", id);
        for (const mirror of mirrors ?? []) {
          const rowData =
            mirror.row_data && typeof mirror.row_data === "object"
              ? { ...(mirror.row_data as Record<string, unknown>) }
              : {};
          await svc
            .from("portal_pro_relationship_records")
            .update({
              row_data: {
                ...rowData,
                assignedPropertyIds: nextAssigned,
                propertyCoManagerPermissions: nextPropertyPerms,
                payoutPercentForManager: nextPayout,
              },
              updated_at: new Date().toISOString(),
            })
            .eq("id", String((mirror as { id?: unknown }).id ?? id));
        }
        for (const scope of scopedRelationshipDeletesForRevokedInvite(updatedInvite)) {
          const { data: scopedRows } = await svc
            .from("portal_pro_relationship_records")
            .select("id, row_data")
            .eq("manager_user_id", scope.managerUserId)
            .filter("row_data->>linkedAxisId", "eq", scope.linkedAxisId);
          for (const scoped of scopedRows ?? []) {
            const scopedId = String((scoped as { id?: unknown }).id ?? "").trim();
            if (!scopedId || scopedId === id) continue;
            const rowData =
              scoped.row_data && typeof scoped.row_data === "object"
                ? { ...(scoped.row_data as Record<string, unknown>) }
                : {};
            await svc
              .from("portal_pro_relationship_records")
              .update({
                row_data: {
                  ...rowData,
                  assignedPropertyIds: nextAssigned,
                  propertyCoManagerPermissions: nextPropertyPerms,
                  payoutPercentForManager: nextPayout,
                },
                updated_at: new Date().toISOString(),
              })
              .eq("id", scopedId);
          }
        }
      }

      return NextResponse.json({ ok: true, invite: serializeInvite(updated as InviteRow, user.id) });
    }

    if (actionNorm !== "accept" && actionNorm !== "reject" && actionNorm !== "cancel") {
      return NextResponse.json({ error: "action must be accept, reject, or cancel." }, { status: 400 });
    }

    if (invite.status !== "pending") {
      return NextResponse.json({ error: "This invite is no longer pending." }, { status: 409 });
    }

    // A pending invite used to be acceptable forever. Combined with one that was
    // never delivered — so never chased, and forgotten by the manager who sent
    // it — that is a stale, invisible grant of module access to the assigned
    // properties (PRP-205). Cancelling is still allowed past the date, so the
    // inviter can tidy up what lapsed.
    const expiresAt = invite.expires_at ? Date.parse(String(invite.expires_at)) : Number.NaN;
    if (actionNorm === "accept" && Number.isFinite(expiresAt) && expiresAt < Date.now()) {
      return NextResponse.json(
        { error: "This invite has expired. Ask the manager to send a new one." },
        { status: 409 },
      );
    }

    if (actionNorm === "cancel") {
      if (invite.inviter_user_id !== user.id) {
        return NextResponse.json({ error: "Only the inviter can cancel." }, { status: 403 });
      }
      const { data: updated, error: upErr } = await svc
        .from("account_link_invites")
        .update({ status: "cancelled", responded_at: new Date().toISOString() })
        .eq("id", id)
        .eq("status", "pending")
        .select("*")
        .maybeSingle();

      if (upErr) {
        return NextResponse.json({ error: upErr.message }, { status: 500 });
      }
      return NextResponse.json({ ok: true, invite: serializeInvite(updated as InviteRow, user.id) });
    }

    if (invite.invitee_user_id !== user.id) {
      return NextResponse.json({ error: "Only the invitee can accept or reject." }, { status: 403 });
    }

    if (actionNorm === "accept") {
      const { data: participantProfiles } = await svc
        .from("profiles")
        .select("id, email")
        .in("id", [invite.inviter_user_id, invite.invitee_user_id]);
      const emailByUserId = new Map(
        (participantProfiles ?? []).map((row) => [String(row.id ?? "").trim(), String(row.email ?? "").trim()] as const),
      );
      const inviterEmail = emailByUserId.get(invite.inviter_user_id) ?? "";
      const inviteeEmail = emailByUserId.get(invite.invitee_user_id) ?? "";
      if (isCrossSandboxPortalPair(inviterEmail, inviteeEmail)) {
        return NextResponse.json({ error: CROSS_SANDBOX_PORTAL_PAIR_ERROR }, { status: 400 });
      }

      // The ownership gate on create only covers rows written after it shipped.
      // A link forged earlier — naming a property harvested from the public
      // listing feed — is still pending and accepting it would grant full
      // co-manager access, so re-derive ownership here. Reject outright rather
      // than narrowing the list: a silent partial grant is the failure mode.
      const ownership = await findPropertyIdsNotOwnedByManager(
        svc,
        invite.inviter_user_id,
        asStringArray(invite.assigned_property_ids),
      );
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
    }

    const nextStatus = actionNorm === "accept" ? "accepted" : "rejected";
    const { data: updated, error: upErr } = await svc
      .from("account_link_invites")
      .update({ status: nextStatus, responded_at: new Date().toISOString() })
      .eq("id", id)
      .eq("status", "pending")
      .select("*")
      .maybeSingle();

    if (upErr) {
      return NextResponse.json({ error: upErr.message }, { status: 500 });
    }

    if (actionNorm === "accept") {
      void (async () => {
        try {
          const { notifyCoManagerInviteAccepted } = await import("@/lib/co-manager-notification.server");
          const inviteeName =
            invite.invitee_display_name?.trim() ||
            (await svc.from("profiles").select("full_name, email").eq("id", invite.invitee_user_id).maybeSingle()).data
              ?.full_name?.trim() ||
            "Your co-manager";
          await notifyCoManagerInviteAccepted({
            inviterUserId: invite.inviter_user_id,
            inviteeUserId: user.id,
            inviteeName,
          });
        } catch (error) {
          bestEffortFailed("co-manager invite-accepted notification", {
            invite: invite.id,
          })(error);
        }
      })();
    }

    return NextResponse.json({ ok: true, invite: serializeInvite(updated as InviteRow, user.id) });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
