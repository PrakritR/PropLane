import { z } from "zod";
import { defineTool } from "../registry";
import { withoutOwnerLinks } from "@/lib/co-manager-team-roles";

/**
 * Accepted co-manager account link (account_link_invites). Mirrors the fields
 * serializeInvite in /api/pro/account-links projects, reduced to the safe
 * name/email/assigned-properties surface the agent needs.
 */
type AccountLinkRow = {
  id: string;
  inviter_user_id: string;
  invitee_user_id: string;
  inviter_display_name: string | null;
  invitee_display_name: string | null;
  assigned_property_ids: unknown;
  created_at: string | null;
  responded_at: string | null;
};

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

export const listCoManagersTool = defineTool({
  name: "list_co_managers",
  description:
    "List the co-managers linked to the current landlord's workspace — accepted account links plus legacy pro-relationship links — with name, email, link direction, and assigned property ids. Read-only: co-manager invites and permission changes are made in Settings → Team in the portal, not through the assistant.",
  kind: "read",
  inputSchema: z.object({}).strict(),
  handler: async (ctx) => {
    // Accepted account links where this landlord is either side of the link.
    const { data, error } = withoutOwnerLinks(await ctx.db
      .from("account_link_invites")
      .select(
        "id, inviter_user_id, invitee_user_id, inviter_display_name, invitee_display_name, assigned_property_ids, created_at, responded_at, team_role",
      )
      .eq("status", "accepted")
      .or(`inviter_user_id.eq.${ctx.landlordId},invitee_user_id.eq.${ctx.landlordId}`));
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as AccountLinkRow[];

    // One profiles read resolves every counterpart's email.
    const otherIds = [
      ...new Set(
        rows
          .map((r) => (r.inviter_user_id === ctx.landlordId ? r.invitee_user_id : r.inviter_user_id))
          .map((id) => String(id ?? "").trim())
          .filter(Boolean),
      ),
    ];
    const emailByUserId = new Map<string, string>();
    if (otherIds.length > 0) {
      const { data: profiles, error: profilesError } = await ctx.db
        .from("profiles")
        .select("id, email")
        .in("id", otherIds);
      if (profilesError) throw new Error(profilesError.message);
      for (const profile of (profiles ?? []) as { id: unknown; email: unknown }[]) {
        const id = String(profile.id ?? "").trim();
        const email = String(profile.email ?? "").trim().toLowerCase();
        if (id && email) emailByUserId.set(id, email);
      }
    }

    const coManagers = rows.map((r) => {
      const outgoing = r.inviter_user_id === ctx.landlordId;
      const linkedUserId = String((outgoing ? r.invitee_user_id : r.inviter_user_id) ?? "").trim();
      return {
        name: (outgoing ? r.invitee_display_name : r.inviter_display_name)?.trim() || null,
        email: emailByUserId.get(linkedUserId) ?? null,
        /** "outgoing" = this landlord invited them; "incoming" = they invited this landlord. */
        direction: outgoing ? ("outgoing" as const) : ("incoming" as const),
        assignedPropertyIds: asStringArray(r.assigned_property_ids),
        linkedSince: r.responded_at ?? r.created_at ?? null,
        source: "account_link" as const,
      };
    });

    // Legacy pro-relationship links owned by this landlord (pre-account-links).
    const { data: legacyData, error: legacyError } = await ctx.db
      .from("portal_pro_relationship_records")
      .select("related_email, row_data")
      .eq("manager_user_id", ctx.landlordId);
    if (legacyError) throw new Error(legacyError.message);
    const legacy = ((legacyData ?? []) as { related_email: unknown; row_data: unknown }[]).map((rec) => {
      const row = (rec.row_data ?? {}) as {
        linkedDisplayName?: unknown;
        assignedPropertyIds?: unknown;
        createdAt?: unknown;
      };
      return {
        name: typeof row.linkedDisplayName === "string" && row.linkedDisplayName.trim() ? row.linkedDisplayName.trim() : null,
        email: String(rec.related_email ?? "").trim().toLowerCase() || null,
        direction: "outgoing" as const,
        assignedPropertyIds: asStringArray(row.assignedPropertyIds),
        linkedSince: typeof row.createdAt === "string" ? row.createdAt : null,
        source: "legacy_link" as const,
      };
    });

    const all = [...coManagers, ...legacy];
    return { count: all.length, coManagers: all };
  },
});
