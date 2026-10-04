import type { SupabaseClient } from "@supabase/supabase-js";

import {
  LEASING_FORMS_ROW_DATA_KEY,
  normalizeLeasingFormsLibrary,
  stripServerOwnedFromLibrary,
  type LeasingFormsLibrary,
} from "@/lib/leasing-forms-library";

async function readRowData(db: SupabaseClient, managerUserId: string): Promise<Record<string, unknown>> {
  const { data, error } = await db
    .from("manager_automation_settings")
    .select("row_data")
    .eq("manager_user_id", managerUserId)
    .maybeSingle();
  if (error) throw error;
  const raw = data?.row_data;
  return raw && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
}

/** The workspace Forms library of one manager account (`row_data.leasingForms`). */
export async function loadLeasingFormsLibrary(db: SupabaseClient, managerUserId: string): Promise<LeasingFormsLibrary> {
  const rowData = await readRowData(db, managerUserId);
  return normalizeLeasingFormsLibrary(rowData[LEASING_FORMS_ROW_DATA_KEY]);
}

export async function saveLeasingFormsLibrary(
  db: SupabaseClient,
  managerUserId: string,
  library: unknown,
): Promise<LeasingFormsLibrary> {
  const normalized = stripServerOwnedFromLibrary(normalizeLeasingFormsLibrary(library));
  const rowData = await readRowData(db, managerUserId);
  rowData[LEASING_FORMS_ROW_DATA_KEY] = normalized;
  const { error } = await db.from("manager_automation_settings").upsert(
    { manager_user_id: managerUserId, row_data: rowData, updated_at: new Date().toISOString() },
    { onConflict: "manager_user_id" },
  );
  if (error) throw error;
  return normalized;
}
