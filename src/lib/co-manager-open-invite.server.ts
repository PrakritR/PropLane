import type { SupabaseClient } from "@supabase/supabase-js";
import { looksLikeAccountLinksMissingTable } from "@/lib/account-links";
import type { CoManagerPermissions, PropertyCoManagerPermissions } from "@/lib/co-manager-permissions";

type OpenInviteRow = {
  id: string;
  inviter_user_id: string;
  invitee_user_id: string | null;
  expires_at?: string | null;
  [key: string]: unknown;
};
import {
  generateCoManagerInviteToken,
  hashCoManagerInviteToken,
  coManagerOpenInviteUrl,
} from "@/lib/co-manager-invite-token";

const OPEN_INVITE_SELECT = [
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
  "expires_at",
  "invite_token_hash",
].join(",");

export async function findPendingOpenInviteByToken(
  svc: SupabaseClient,
  token: string,
): Promise<{ ok: true; row: OpenInviteRow | null } | { ok: false; error: string; missingTable?: boolean }> {
  const hash = hashCoManagerInviteToken(token);
  if (!hash || !token.trim()) return { ok: true, row: null };
  const { data, error } = await svc
    .from("account_link_invites")
    .select(OPEN_INVITE_SELECT)
    .eq("invite_token_hash", hash)
    .eq("status", "pending")
    .is("invitee_user_id", null)
    .maybeSingle();
  if (error) {
    return {
      ok: false,
      error: error.message,
      missingTable: looksLikeAccountLinksMissingTable(error),
    };
  }
  return { ok: true, row: (data as unknown as OpenInviteRow | null) ?? null };
}

export function openInviteIsExpired(row: Pick<OpenInviteRow, "expires_at">, now = Date.now()): boolean {
  const expiresAt = row.expires_at ? Date.parse(String(row.expires_at)) : Number.NaN;
  return Number.isFinite(expiresAt) && expiresAt < now;
}

export async function mintOpenCoManagerInvite(params: {
  svc: SupabaseClient;
  inviterUserId: string;
  inviterAxisId: string;
  inviterDisplayName: string | null;
  assignedPropertyIds: string[];
  payoutPercentForManager: number;
  propertyCoManagerPermissions: PropertyCoManagerPermissions;
  coManagerPermissions: CoManagerPermissions;
  tabKind: string;
  requestOrigin?: string;
  existingId?: string;
}): Promise<
  | { ok: true; row: OpenInviteRow; inviteUrl: string; token: string }
  | { ok: false; error: string; status: number }
> {
  const token = generateCoManagerInviteToken();
  const hash = hashCoManagerInviteToken(token);
  const inviteUrl = coManagerOpenInviteUrl(token, params.requestOrigin);
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  const payload = {
    inviter_user_id: params.inviterUserId,
    invitee_user_id: null,
    tab_kind: params.tabKind,
    inviter_axis_id: params.inviterAxisId,
    invitee_axis_id: null,
    inviter_display_name: params.inviterDisplayName,
    invitee_display_name: null,
    assigned_property_ids: params.assignedPropertyIds,
    payout_percent_for_manager: params.payoutPercentForManager,
    property_co_manager_permissions: params.propertyCoManagerPermissions,
    co_manager_permissions: params.coManagerPermissions,
    status: "pending",
    invite_token_hash: hash,
    invitee_plan_inherited: true,
    expires_at: expiresAt,
    responded_at: null,
  };

  if (params.existingId) {
    const { data, error } = await params.svc
      .from("account_link_invites")
      .update(payload)
      .eq("id", params.existingId)
      .eq("inviter_user_id", params.inviterUserId)
      .eq("status", "pending")
      .is("invitee_user_id", null)
      .select(OPEN_INVITE_SELECT)
      .maybeSingle();
    if (error) return { ok: false, error: error.message, status: 500 };
    if (!data) return { ok: false, error: "Invite not found.", status: 404 };
    return { ok: true, row: data as unknown as OpenInviteRow, inviteUrl, token };
  }

  const { data: existingOpen } = await params.svc
    .from("account_link_invites")
    .select("id")
    .eq("inviter_user_id", params.inviterUserId)
    .eq("tab_kind", params.tabKind)
    .eq("status", "pending")
    .is("invitee_user_id", null)
    .maybeSingle();

  if (existingOpen?.id) {
    return mintOpenCoManagerInvite({ ...params, existingId: String(existingOpen.id) });
  }

  const { data, error } = await params.svc
    .from("account_link_invites")
    .insert(payload)
    .select(OPEN_INVITE_SELECT)
    .maybeSingle();

  if (error) {
    const msg = error.message ?? "";
    if (msg.includes("account_link_invites_one_open_pending") || msg.includes("duplicate")) {
      const { data: raced } = await params.svc
        .from("account_link_invites")
        .select("id")
        .eq("inviter_user_id", params.inviterUserId)
        .eq("tab_kind", params.tabKind)
        .eq("status", "pending")
        .is("invitee_user_id", null)
        .maybeSingle();
      if (raced?.id) {
        return mintOpenCoManagerInvite({ ...params, existingId: String(raced.id) });
      }
    }
    return { ok: false, error: error.message, status: 500 };
  }
  if (!data) return { ok: false, error: "Failed to create invite.", status: 500 };
  return { ok: true, row: data as unknown as OpenInviteRow, inviteUrl, token };
}
