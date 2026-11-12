import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Personal account link (design-1112 §3.0). Stub: Package B replaces. */

export async function mintPersonalAccountLink(db: SupabaseClient, input: { phoneE164: string; workspaceId: string; propertyId?: string | null; createdBy?: string | null }): Promise<string | null> {
  throw new Error("personal-link: not built");
}
