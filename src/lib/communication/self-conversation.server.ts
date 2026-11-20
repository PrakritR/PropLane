import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeE164 } from "@/lib/phone-e164";
import type { ViewerSelfIdentity } from "@/lib/communication/self-conversation";

/**
 * The viewer's identity as the server knows it: the session user id, the session's confirmed email and the profile
 * phone ONLY when `phone_verified_at` is set. A failed read leaves the phone out, so a text thread the viewer could
 * not be proven to own stays its own row (fail open, never hide a conversation).
 */
export async function loadViewerSelfIdentity(
  db: SupabaseClient,
  user: { id: string; email?: string | null },
): Promise<ViewerSelfIdentity> {
  // `user` is the inbox scope user (`resolveInboxScopeUser`), whose email is null unless `email_confirmed_at` is set.
  const base: ViewerSelfIdentity = { userId: user.id, confirmedEmail: user.email ?? null, verifiedPhone: null };
  try {
    const { data, error } = await db.from("profiles").select("phone, phone_verified_at").eq("id", user.id).maybeSingle();
    if (error || !data?.phone_verified_at) return base;
    return { ...base, verifiedPhone: normalizeE164(String(data.phone ?? "")) };
  } catch {
    return base;
  }
}
