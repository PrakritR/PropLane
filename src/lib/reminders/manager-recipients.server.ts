import type { SupabaseClient } from "@supabase/supabase-js";

export type ManagerReminderRecipient = {
  email: string;
  name: string | null;
};

/** Load manager reminder destinations once per sweep, never once per subject. */
export async function loadManagerReminderRecipients(
  db: SupabaseClient,
  managerUserIds: readonly string[],
): Promise<Map<string, ManagerReminderRecipient>> {
  const ids = [...new Set(managerUserIds.map((id) => id.trim()).filter(Boolean))];
  const out = new Map<string, ManagerReminderRecipient>();
  if (ids.length === 0) return out;

  const { data, error } = await db
    .from("profiles")
    .select("id, email, full_name")
    .in("id", ids);
  if (error) throw error;

  for (const row of data ?? []) {
    const id = String((row as { id?: unknown }).id ?? "").trim();
    const email = String((row as { email?: unknown }).email ?? "").trim().toLowerCase();
    if (!id || !email.includes("@")) continue;
    const name = String((row as { full_name?: unknown }).full_name ?? "").trim();
    out.set(id, { email, name: name || null });
  }
  return out;
}
