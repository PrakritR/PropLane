import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

/** The name a statement or tax package is addressed to: the owner of record's profile name, else their email, else "Property owner". */
export async function ownerOfRecordName(db: SupabaseClient, ownerUserId: string): Promise<string> {
  try {
    const { data } = await db.from("profiles").select("full_name, email").eq("id", ownerUserId).maybeSingle();
    const row = data as { full_name?: string | null; email?: string | null } | null;
    return String(row?.full_name ?? "").trim() || String(row?.email ?? "").trim() || "Property owner";
  } catch {
    return "Property owner";
  }
}
