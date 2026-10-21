import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * A person's display name: `profiles.full_name`, else the name they typed at signup (auth metadata), which older
 * accounts kept only there. The fallback is also written back to the profile so the next read needs no lookup.
 * `userId` always comes from the session, never a request body. Returns "" when there is no name anywhere.
 */
export async function resolveProfileFullName(
  db: SupabaseClient,
  userId: string,
  profileName: string | null | undefined,
): Promise<string> {
  const own = String(profileName ?? "").trim();
  if (own) return own;
  try {
    const { data } = await db.auth.admin.getUserById(userId);
    const meta = (data?.user?.user_metadata ?? {}) as Record<string, unknown>;
    const raw = typeof meta.full_name === "string" ? meta.full_name : typeof meta.name === "string" ? meta.name : "";
    const name = raw.trim().slice(0, 200);
    if (name) await db.from("profiles").update({ full_name: name }).eq("id", userId).is("full_name", null);
    return name;
  } catch {
    return "";
  }
}
