import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolvePropertyScopedManagerRecipientIds } from "@/lib/co-manager-notification-recipients.server";
import { usableProfilePhone } from "@/lib/one-number/house-digest-recipients";
import { resolveWorkspaceNoticeRecipients } from "@/lib/workspace-team-recipients.server";

/**
 * The PropLane accounts on one house for the 7 AM check-in / check-out text: the owner of record
 * (`manager_property_records.manager_user_id`) first, then every teammate whose role and grants put them on that house's
 * CALENDAR notices. Two existing answers, unioned so neither path's people are lost:
 *   - `resolveWorkspaceNoticeRecipients` (the workspace Team roster and its role matrix: an admin / full seat hears every
 *     house, a property manager only the houses they hold, a bookkeeper or maintenance seat never a calendar notice);
 *   - `resolvePropertyScopedManagerRecipientIds` (a co-manager link that assigns THIS house with calendar notification).
 * A Property owner (investor) link is never on either list. An unreadable roster narrows to the owner, never wider.
 */
export async function resolveHouseManagerUserIds(
  db: SupabaseClient,
  input: { ownerUserId: string; workspaceId?: string | null; propertyId: string },
): Promise<string[]> {
  const ownerId = input.ownerUserId.trim();
  if (!ownerId) return [];
  const ids = new Set<string>([ownerId]);
  const [roster, scoped] = await Promise.all([
    resolveWorkspaceNoticeRecipients(db, {
      ownerUserId: ownerId,
      workspaceId: input.workspaceId?.trim() || null,
      module: "calendar",
      propertyId: input.propertyId,
    }).catch(() => []),
    resolvePropertyScopedManagerRecipientIds(db as never, {
      ownerManagerUserId: ownerId,
      propertyId: input.propertyId,
      channel: "calendar",
    }).catch(() => []),
  ]);
  for (const r of roster) if (r.userId?.trim()) ids.add(r.userId.trim());
  for (const id of scoped) if (id?.trim()) ids.add(id.trim());
  return [...ids];
}

/**
 * Each account's usable phone (verified, forwarding not off), read in one query. `skipped` counts the accounts with no
 * usable phone; only the count is ever logged, never an id or a number.
 */
export async function loadUsableManagerPhones(
  db: SupabaseClient,
  userIds: readonly string[],
): Promise<{ phones: Map<string, string>; skipped: number }> {
  const ids = [...new Set(userIds.map((id) => id.trim()).filter(Boolean))];
  const phones = new Map<string, string>();
  if (ids.length === 0) return { phones, skipped: 0 };
  const { data, error } = await db.from("profiles").select("id, phone, phone_verified_at, sms_forward_inbound").in("id", ids);
  if (error) return { phones, skipped: ids.length };
  for (const row of (data ?? []) as Array<{ id?: unknown; phone?: unknown; phone_verified_at?: unknown; sms_forward_inbound?: unknown }>) {
    const id = String(row.id ?? "").trim();
    const phone = usableProfilePhone(row);
    if (id && phone) phones.set(id, phone);
  }
  return { phones, skipped: ids.filter((id) => !phones.has(id)).length };
}
