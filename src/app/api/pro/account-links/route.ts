import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  looksLikeAccountLinksMissingTable,
  type AccountLinkInviteDto,
  type AccountLinkTabKind,
  type AccountLinksPayload,
} from "@/lib/account-links";
import { findPropertyIdsNotOwnedByManager } from "@/lib/auth/co-manager-invite-scope";
import { managerPlanAllowsCoManagerInvites } from "@/lib/co-manager-plan-access.server";
import { normalizePropertyCoManagerPermissions, flatCoManagerPermissionsFromProperty, type CoManagerPermissions, type PropertyCoManagerPermissions } from "@/lib/co-manager-permissions";
import { maxAccountLinksForTier } from "@/lib/manager-access";
import { getManagerPurchaseSku } from "@/lib/manager-access-server";
import { isCrossSandboxPortalPair, CROSS_SANDBOX_PORTAL_PAIR_ERROR } from "@/lib/portal-sandbox-accounts";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { labelFromManagerPropertyRecordRow } from "@/lib/co-manager-property-label";

export const runtime = "nodejs";

export type InviteRow = {
  id: string;
  inviter_user_id: string;
  invitee_user_id: string;
  tab_kind: string;
  inviter_axis_id: string;
  invitee_axis_id: string;
  inviter_display_name: string | null;
  invitee_display_name: string | null;
  assigned_property_ids: unknown;
  payout_percent_for_manager: number;
  co_manager_permissions?: unknown;
  property_co_manager_permissions?: unknown;
  status: string;
  created_at: string;
  responded_at: string | null;
};

export function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x) => typeof x === "string") as string[];
}

export function readPropertyPermissionsFromRow(
  row: Pick<InviteRow, "assigned_property_ids" | "property_co_manager_permissions" | "co_manager_permissions">,
): PropertyCoManagerPermissions {
  const assigned = asStringArray(row.assigned_property_ids);
  const raw = row.property_co_manager_permissions ?? row.co_manager_permissions;
  return normalizePropertyCoManagerPermissions(raw, assigned);
}

export function serializeInvite(
  row: InviteRow,
  viewerId: string,
  propertyLabelsById: Record<string, string> = {},
): AccountLinkInviteDto {
  const out = row.inviter_user_id === viewerId;
  const linkedAxisId = out ? row.invitee_axis_id : row.inviter_axis_id;
  const linkedDisplayName = out ? row.invitee_display_name : row.inviter_display_name;
  const linkedUserId = out ? row.invitee_user_id : row.inviter_user_id;
  const assignedPropertyIds = asStringArray(row.assigned_property_ids);
  const propertyCoManagerPermissions = readPropertyPermissionsFromRow(row);
  const assignedPropertyLabels: Record<string, string> = {};
  for (const id of assignedPropertyIds) {
    const label = propertyLabelsById[id]?.trim();
    if (label) assignedPropertyLabels[id] = label;
  }
  return {
    id: row.id,
    tabKind: "manager",
    status:
      row.status === "accepted" ||
      row.status === "rejected" ||
      row.status === "cancelled" ||
      row.status === "pending"
        ? row.status
        : "pending",
    direction: out ? "outgoing" : "incoming",
    inviterAxisId: row.inviter_axis_id,
    inviteeAxisId: row.invitee_axis_id,
    inviterDisplayName: row.inviter_display_name,
    inviteeDisplayName: row.invitee_display_name,
    linkedAxisId,
    linkedDisplayName,
    linkedUserId,
    assignedPropertyIds,
    assignedPropertyLabels: Object.keys(assignedPropertyLabels).length > 0 ? assignedPropertyLabels : undefined,
    payoutPercentForManager: Number(row.payout_percent_for_manager),
    coManagerPermissions: flatCoManagerPermissionsFromProperty(propertyCoManagerPermissions),
    propertyCoManagerPermissions,
    createdAt: row.created_at,
    respondedAt: row.responded_at,
  };
}

async function userIsPropertyPortalManager(supabase: SupabaseClient, userId: string): Promise<boolean> {
  const asManager = await userHasPortalRole(supabase, userId, "manager");
  if (asManager) return true;
  return userHasPortalRole(supabase, userId, "owner");
}

async function userHasPortalRole(
  supabase: SupabaseClient,
  userId: string,
  role: "owner" | "manager",
): Promise<boolean> {
  const { data: pr } = await supabase
    .from("profile_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", role)
    .maybeSingle();
  if (pr?.role === role) return true;
  const { data: p } = await supabase.from("profiles").select("role").eq("id", userId).maybeSingle();
  return String((p as { role?: string } | null)?.role ?? "").toLowerCase() === role;
}

async function countParticipantLinks(
  supabase: SupabaseClient,
  userId: string,
  tabKind: AccountLinkTabKind,
): Promise<{ count: number | null; error: { message?: string } | null }> {
  const { count, error } = await supabase
    .from("account_link_invites")
    .select("id", { count: "exact", head: true })
    .eq("tab_kind", tabKind)
    .in("status", ["pending", "accepted"])
    .or(`inviter_user_id.eq.${userId},invitee_user_id.eq.${userId}`);
  return { count: count ?? 0, error };
}

export async function GET(): Promise<NextResponse<AccountLinksPayload | { error: string }>> {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }

    const { data, error } = await supabase
      .from("account_link_invites")
      .select(
        [
          "id",
          "inviter_user_id",
          "invitee_user_id",
          "tab_kind",
          "inviter_axis_id",
          "invitee_axis_id",
          "inviter_display_name",
          "invitee_display_name",
          "assigned_property_ids",
          "payout_percent_for_manager",
          "property_co_manager_permissions",
          "co_manager_permissions",
          "status",
          "created_at",
          "responded_at",
        ].join(","),
      )
      .or(`inviter_user_id.eq.${user.id},invitee_user_id.eq.${user.id}`)
      .order("created_at", { ascending: false });

    if (error) {
      if (looksLikeAccountLinksMissingTable(error)) {
        return NextResponse.json({ invites: [], migrationRequired: true });
      }
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const rows = ((data ?? []) as unknown) as InviteRow[];
    const db = createSupabaseServiceRoleClient();
    const allAssignedPropertyIds = [
      ...new Set(rows.flatMap((row) => asStringArray(row.assigned_property_ids))),
    ];
    const propertyLabelsById: Record<string, string> = {};
    if (allAssignedPropertyIds.length > 0) {
      const { data: props } = await db
        .from("manager_property_records")
        .select("id, property_data, row_data")
        .in("id", allAssignedPropertyIds);
      for (const prop of props ?? []) {
        const id = String(prop.id ?? "").trim();
        if (!id) continue;
        propertyLabelsById[id] = labelFromManagerPropertyRecordRow(prop);
      }
    }
    const { data: viewerProfile } = await db.from("profiles").select("email").eq("id", user.id).maybeSingle();
    const viewerEmail = String(viewerProfile?.email ?? user.email ?? "").trim();
    const participantIds = [
      ...new Set(
        rows.flatMap((row) => [row.inviter_user_id, row.invitee_user_id].map((id) => String(id ?? "").trim())).filter(Boolean),
      ),
    ];
    const emailByUserId = new Map<string, string>();
    if (participantIds.length > 0) {
      const { data: profiles } = await db.from("profiles").select("id, email").in("id", participantIds);
      for (const profile of profiles ?? []) {
        const id = String(profile.id ?? "").trim();
        const email = String(profile.email ?? "").trim();
        if (id && email) emailByUserId.set(id, email);
      }
    }

    const invites = rows
      .filter((row) => {
        const otherUserId = row.inviter_user_id === user.id ? row.invitee_user_id : row.inviter_user_id;
        const otherEmail = emailByUserId.get(String(otherUserId ?? "").trim()) ?? "";
        return !isCrossSandboxPortalPair(viewerEmail, otherEmail);
      })
      .map((r) => serializeInvite(r, user.id, propertyLabelsById));
    return NextResponse.json({ invites });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }

    const body = (await req.json().catch(() => null)) as {
      inviteeAxisId?: string;
      tabKind?: string;
      assignedPropertyIds?: unknown;
      payoutPercentForManager?: number;
      coManagerPermissions?: unknown;
      propertyCoManagerPermissions?: unknown;
    } | null;

    const inviteeAxisId = body?.inviteeAxisId?.trim() ?? "";
    const tabKind = "manager" satisfies AccountLinkTabKind;
    void body?.tabKind;
    const assignedPropertyIds = asStringArray(body?.assignedPropertyIds);
    const payoutPercentForManager = Math.min(
      100,
      Math.max(0, Math.round(Number(body?.payoutPercentForManager ?? 15) * 10) / 10),
    );
    const propertyCoManagerPermissions = normalizePropertyCoManagerPermissions(
      body?.propertyCoManagerPermissions ?? body?.coManagerPermissions,
      assignedPropertyIds,
    );
    const coManagerPermissions: CoManagerPermissions = flatCoManagerPermissionsFromProperty(propertyCoManagerPermissions);

    if (!inviteeAxisId) {
      return NextResponse.json({ error: "inviteeAxisId is required." }, { status: 400 });
    }
    if (assignedPropertyIds.length === 0) {
      return NextResponse.json({ error: "Select at least one property for this invite." }, { status: 400 });
    }

    const inviterOk = await userIsPropertyPortalManager(supabase, user.id);
    if (!inviterOk) {
      return NextResponse.json(
        {
          error: "Your account doesn't support linking co-managers.",
        },
        { status: 403 },
      );
    }

    const svc = createSupabaseServiceRoleClient();

    // Security: the inviter may only delegate properties they actually own.
    // Without this, any manager could name a victim's publicly-listed property
    // id and grant themselves (via a second account) full co-manager access to
    // it. See findPropertyIdsNotOwnedByManager.
    const ownership = await findPropertyIdsNotOwnedByManager(svc, user.id, assignedPropertyIds);
    if (!ownership.ok) {
      return NextResponse.json({ error: ownership.error }, { status: 500 });
    }
    if (ownership.unowned.length > 0) {
      return NextResponse.json(
        { error: "You can only assign properties you manage." },
        { status: 403 },
      );
    }

    const { data: inviterProfile, error: inviterErr } = await svc
      .from("profiles")
      .select("manager_id, full_name, email, role")
      .eq("id", user.id)
      .maybeSingle();

    if (inviterErr || !inviterProfile?.manager_id) {
      return NextResponse.json({ error: inviterErr?.message ?? "Missing profile axis id." }, { status: 400 });
    }

    const inviterAxisId = String(inviterProfile.manager_id);

    const { data: inviteeProfile, error: inviteeErr } = await svc
      .from("profiles")
      .select("id, manager_id, full_name, email, role")
      .eq("manager_id", inviteeAxisId)
      .maybeSingle();

    if (inviteeErr) {
      if (looksLikeAccountLinksMissingTable(inviteeErr)) {
        return NextResponse.json(
          {
            error:
              "Database is missing account_link_invites. Apply supabase/migrations/20260422120000_account_link_invites.sql.",
            migrationRequired: true,
          },
          { status: 503 },
        );
      }
      return NextResponse.json({ error: inviteeErr.message }, { status: 500 });
    }
    if (!inviteeProfile?.id) {
      return NextResponse.json({ error: "No account found with this PropLane ID." }, { status: 404 });
    }

    const ir = String((inviteeProfile as { role?: string }).role ?? "").toLowerCase();
    const inviteeOk = ir === "manager" || ir === "owner";
    if (!inviteeOk) {
      return NextResponse.json(
        {
          error: "That account must be a property portal manager to link as a co-manager.",
        },
        { status: 400 },
      );
    }

    if (inviteeProfile.id === user.id) {
      return NextResponse.json({ error: "You cannot invite your own workspace." }, { status: 400 });
    }

    const inviterEmail = String(inviterProfile.email ?? user.email ?? "").trim();
    const inviteeEmail = String(inviteeProfile.email ?? "").trim();
    if (isCrossSandboxPortalPair(inviterEmail, inviteeEmail)) {
      return NextResponse.json({ error: CROSS_SANDBOX_PORTAL_PAIR_ERROR }, { status: 400 });
    }

    const { data: existingLink, error: existingErr } = await svc
      .from("account_link_invites")
      .select("id,status")
      .eq("tab_kind", tabKind)
      .in("status", ["pending", "accepted"])
      .or(
        `and(inviter_user_id.eq.${user.id},invitee_user_id.eq.${inviteeProfile.id}),and(inviter_user_id.eq.${inviteeProfile.id},invitee_user_id.eq.${user.id})`,
      )
      .limit(1)
      .maybeSingle();

    if (existingErr) {
      if (looksLikeAccountLinksMissingTable(existingErr)) {
        return NextResponse.json(
          {
            error:
              "Database is missing account_link_invites. Apply supabase/migrations/20260422120000_account_link_invites.sql.",
            migrationRequired: true,
          },
          { status: 503 },
        );
      }
      return NextResponse.json({ error: existingErr.message }, { status: 500 });
    }
    if (existingLink) {
      return NextResponse.json(
        { error: "These workspaces already have a pending or active link for this role." },
        { status: 409 },
      );
    }

    const { tier: inviterTier, billing: inviterBilling } = await getManagerPurchaseSku(user.id);
    if (!managerPlanAllowsCoManagerInvites({ tier: inviterTier })) {
      return NextResponse.json(
        { error: "Upgrade to Pro or Business before linking co-managers." },
        { status: 403 },
      );
    }
    void inviterBilling;

    const inviterLinkCap = maxAccountLinksForTier(inviterTier);
    if (inviterLinkCap != null) {
      const { count: used, error: capErr } = await countParticipantLinks(svc, user.id, tabKind);

      if (capErr) {
        if (looksLikeAccountLinksMissingTable(capErr)) {
          return NextResponse.json(
            {
              error:
                "Database is missing account_link_invites. Apply supabase/migrations/20260422120000_account_link_invites.sql.",
              migrationRequired: true,
            },
            { status: 503 },
          );
        }
        return NextResponse.json({ error: capErr.message }, { status: 500 });
      }
      if ((used ?? 0) >= inviterLinkCap) {
        return NextResponse.json(
          {
            error: `Plan limit: ${inviterLinkCap} link${inviterLinkCap === 1 ? "" : "s"} max for this link type on your plan.`,
          },
          { status: 403 },
        );
      }
    }

    const { tier: inviteeTier, billing: inviteeBilling } = await getManagerPurchaseSku(inviteeProfile.id);
    if (!managerPlanAllowsCoManagerInvites({ tier: inviteeTier })) {
      return NextResponse.json(
        {
          error: "That account must upgrade to Pro or Business before they can join as a co-manager.",
        },
        { status: 403 },
      );
    }
    void inviteeBilling;

    const inviteeLinkCap = maxAccountLinksForTier(inviteeTier);
    if (inviteeLinkCap != null) {
      const { count: inviteeUsed, error: inviteeCapErr } = await countParticipantLinks(svc, inviteeProfile.id, tabKind);

      if (inviteeCapErr) {
        if (looksLikeAccountLinksMissingTable(inviteeCapErr)) {
          return NextResponse.json(
            {
              error:
                "Database is missing account_link_invites. Apply supabase/migrations/20260422120000_account_link_invites.sql.",
              migrationRequired: true,
            },
            { status: 503 },
          );
        }
        return NextResponse.json({ error: inviteeCapErr.message }, { status: 500 });
      }

      if ((inviteeUsed ?? 0) >= inviteeLinkCap) {
        return NextResponse.json(
          {
            error: `Invitee needs to upgrade. They already have ${inviteeUsed ?? 0} of ${inviteeLinkCap} allowed links for this role.`,
          },
          { status: 403 },
        );
      }
    }

    const { data: insertRow, error: insertErr } = await svc
      .from("account_link_invites")
      .insert({
        inviter_user_id: user.id,
        invitee_user_id: inviteeProfile.id,
        tab_kind: tabKind,
        inviter_axis_id: inviterAxisId,
        invitee_axis_id: inviteeAxisId,
        inviter_display_name:
          (inviterProfile as { full_name?: string | null }).full_name?.trim() ||
          (inviterProfile as { email?: string | null }).email ||
          null,
        invitee_display_name:
          (inviteeProfile as { full_name?: string | null }).full_name?.trim() ||
          (inviteeProfile as { email?: string | null }).email ||
          null,
        assigned_property_ids: assignedPropertyIds,
        payout_percent_for_manager: payoutPercentForManager,
        property_co_manager_permissions: propertyCoManagerPermissions,
        co_manager_permissions: coManagerPermissions,
        status: "pending",
      })
      .select(
        [
          "id",
          "inviter_user_id",
          "invitee_user_id",
          "tab_kind",
          "inviter_axis_id",
          "invitee_axis_id",
          "inviter_display_name",
          "invitee_display_name",
          "assigned_property_ids",
          "payout_percent_for_manager",
          "property_co_manager_permissions",
          "co_manager_permissions",
          "status",
          "created_at",
          "responded_at",
        ].join(","),
      )
      .maybeSingle();

    if (insertErr) {
      if (looksLikeAccountLinksMissingTable(insertErr)) {
        return NextResponse.json(
          {
            error:
              "Database is missing account_link_invites. Apply supabase/migrations/20260422120000_account_link_invites.sql.",
            migrationRequired: true,
          },
          { status: 503 },
        );
      }
      const msg = insertErr.message ?? "";
      if (msg.includes("account_link_invites_unique_pending") || msg.includes("duplicate")) {
        return NextResponse.json({ error: "You already have a pending invite for this account and link role." }, { status: 409 });
      }
      return NextResponse.json({ error: insertErr.message }, { status: 500 });
    }

    const row = insertRow as InviteRow | null;
    if (!row?.id) {
      return NextResponse.json({ error: "Failed to create invite." }, { status: 500 });
    }

    void (async () => {
      try {
        const { notifyCoManagerInviteSent } = await import("@/lib/co-manager-notification.server");
        const { data: props } = await svc
          .from("manager_property_records")
          .select("id, property_data, row_data")
          .in("id", assignedPropertyIds);
        const labels = (props ?? []).map((p) => labelFromManagerPropertyRecordRow(p));
        await notifyCoManagerInviteSent({
          inviterUserId: user.id,
          inviteeUserId: inviteeProfile.id,
          inviterName:
            (inviterProfile as { full_name?: string | null }).full_name?.trim() ||
            (inviterProfile as { email?: string | null }).email ||
            "A manager",
          propertyLabels: labels.length > 0 ? labels : assignedPropertyIds,
        });
      } catch {
        /* notification failure should not block invite */
      }
    })();

    return NextResponse.json({ ok: true, invite: serializeInvite(row, user.id) });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
