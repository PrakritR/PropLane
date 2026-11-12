import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeReachBy, type ReachChannel } from "@/lib/recipient-channels";

/**
 * Server half of "Reach by": the person's choice lives on their resident record
 * (`manager_application_records.row_data.manualResidentDetails.reachBy`), keyed by the
 * record's `resident_email`. Absent = they never chose, which narrows nothing.
 */

type RecordRow = { resident_email?: unknown; updated_at?: unknown; details?: unknown };

/** One batched read. A failure returns nothing, i.e. "no narrowing" (STOP and the phone gate still apply downstream). */
export async function loadReachByForEmails(db: SupabaseClient, emails: readonly string[]): Promise<Map<string, ReachChannel[]>> {
  const out = new Map<string, ReachChannel[]>();
  const wanted = [...new Set(emails.map((email) => email.trim().toLowerCase()).filter((email) => email.includes("@")))];
  if (wanted.length === 0) return out;
  try {
    const { data, error } = await db
      .from("manager_application_records")
      .select("resident_email, updated_at, details:row_data->manualResidentDetails")
      .in("resident_email", wanted);
    if (error || !Array.isArray(data)) return out;
    const newest = new Map<string, string>();
    for (const row of data as RecordRow[]) {
      const email = String(row.resident_email ?? "").trim().toLowerCase();
      const details = row.details && typeof row.details === "object" ? (row.details as { reachBy?: unknown }) : null;
      const reachBy = normalizeReachBy(details?.reachBy);
      if (!email || !reachBy) continue;
      const updatedAt = String(row.updated_at ?? "");
      // Several records for one person (two managers): the most recently touched choice wins.
      if (out.has(email) && (newest.get(email) ?? "") > updatedAt) continue;
      out.set(email, reachBy);
      newest.set(email, updatedAt);
    }
  } catch {
    return new Map();
  }
  return out;
}

/**
 * The resident's own change from Settings → Profile: written onto every resident record that carries
 * THEIR email (the caller derives the email from the session, never from a request body).
 */
export async function saveReachByForResidentEmail(db: SupabaseClient, email: string, reachBy: readonly ReachChannel[]): Promise<number> {
  const normalized = email.trim().toLowerCase();
  const next = normalizeReachBy(reachBy);
  if (!normalized.includes("@") || !next) return 0;
  const { data, error } = await db.from("manager_application_records").select("id, row_data").eq("resident_email", normalized);
  if (error) throw new Error(error.message);
  let saved = 0;
  for (const record of (data ?? []) as Array<{ id: string; row_data: Record<string, unknown> | null }>) {
    const rowData = record.row_data && typeof record.row_data === "object" ? record.row_data : {};
    const details = rowData.manualResidentDetails && typeof rowData.manualResidentDetails === "object" ? (rowData.manualResidentDetails as Record<string, unknown>) : {};
    const { error: updateError } = await db
      .from("manager_application_records")
      .update({ row_data: { ...rowData, manualResidentDetails: { ...details, reachBy: next } } })
      .eq("id", record.id);
    if (updateError) throw new Error(updateError.message);
    saved += 1;
  }
  return saved;
}
