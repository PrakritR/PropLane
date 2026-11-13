import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeE164 } from "@/lib/phone-e164";
import { phoneKeyOf } from "@/lib/sms/phone-key";

type Row = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());

/**
 * An inbound text that quotes a platform inquiry's stitch code ("SpareRoom, code K7M2P") merges that inquiry into the
 * sender's phone-keyed conversation and routes the text as that workspace's returning prospect (the line session is
 * pointed at the workspace and the inquiry's house). Run BEFORE the shared-line router. Matches the code against
 * `prospect_contexts.stitch_code` only; a word that is not a live code changes nothing, and a code seen in two workspaces
 * is ambiguous and ignored. Never throws; `false` = nothing stitched.
 */
export async function applyStitchCodeFromText(db: SupabaseClient, input: { fromPhone: string; body: string }): Promise<boolean> {
  const stitched = await stitchQuotedCode(db, input);
  if (stitched) return true;
  // No code, but this phone was written in a platform inquiry (merged under the phone key, still "active"): their text IS the move.
  try {
    const { moveClaimedContextsOnText } = await import("@/lib/prospect-spine/stitch.server");
    await moveClaimedContextsOnText(db, input.fromPhone);
  } catch {
    /* advisory */
  }
  return false;
}

async function stitchQuotedCode(db: SupabaseClient, input: { fromPhone: string; body: string }): Promise<boolean> {
  try {
    const phone = normalizeE164(input.fromPhone);
    if (!phone) return false;
    const tokens = [...new Set((input.body.toUpperCase().match(/\b[A-Z0-9]{4,8}\b/g) ?? []).slice(0, 20))];
    if (tokens.length === 0) return false;
    const { data, error } = await db
      .from("prospect_contexts")
      .select("id, workspace_id, stitch_code, property_id")
      .in("stitch_code", tokens)
      .limit(5);
    if (error || !data || data.length === 0) return false;
    const rows = data as Row[];
    const workspaces = new Set(rows.map((r) => str(r.workspace_id)));
    if (workspaces.size !== 1) return false;
    const hit = rows[0]!;
    const { stitchByCode } = await import("@/lib/prospect-spine/stitch.server");
    const result = await stitchByCode(db, { code: str(hit.stitch_code), phoneE164: phone, workspaceId: str(hit.workspace_id) });
    if (!result.ok) return false;
    const { saveSharedLineRoute } = await import("@/lib/one-number/session.server");
    await saveSharedLineRoute(db, phoneKeyOf(phone), {
      workspaceId: str(hit.workspace_id),
      role: "prospect",
      lockedPropertyId: str(hit.property_id) || null,
    });
    return true;
  } catch {
    return false;
  }
}
