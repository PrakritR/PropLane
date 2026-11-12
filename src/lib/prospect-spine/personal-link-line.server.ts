import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeE164 } from "@/lib/phone-e164";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * "Save this chat to your account: <link>" for a prospect reply (design-1112 section 3.1). One line, appended only when the
 * phone has no account on `sms_phone_contacts`, no `account` link was minted for it in the last 7 days (so never twice in a burst),
 * and it has not opted out. The link comes from Package B's `mintPersonalAccountLink` (guarded: a missing or failing module
 * is "no line"). Returns the text unchanged when any rule says no. Never throws.
 */
export async function withPersonalLinkLine(
  db: SupabaseClient,
  input: { text: string; phoneE164: string; workspaceId: string | null; propertyId?: string | null },
): Promise<string> {
  try {
    const phone = normalizeE164(input.phoneE164);
    const workspaceId = input.workspaceId?.trim();
    if (!phone || !workspaceId || !input.text.trim()) return input.text;
    const { isPhoneOptedOut } = await import("@/lib/sms-consent");
    if (await isPhoneOptedOut(db, phone)) return input.text;
    const { data: contact } = await db.from("sms_phone_contacts").select("user_id").eq("phone_e164", phone).maybeSingle();
    if ((contact as { user_id?: unknown } | null)?.user_id) return input.text;
    const since = new Date(Date.now() - SEVEN_DAYS_MS).toISOString();
    const { data: recent, error } = await db
      .from("phone_bound_links").select("id").eq("phone_key", phone).eq("purpose", "account").gte("created_at", since).limit(1);
    if (error || (recent ?? []).length > 0) return input.text;
    const { mintPersonalAccountLink } = await import("@/lib/personal-link/index.server");
    const link = await mintPersonalAccountLink(db, { phoneE164: phone, workspaceId, propertyId: input.propertyId ?? null });
    return link ? `${input.text.trimEnd()}\nSave this chat to your account: ${link}` : input.text;
  } catch {
    return input.text;
  }
}
