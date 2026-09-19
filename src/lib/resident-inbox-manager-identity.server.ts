import type { SupabaseClient } from "@supabase/supabase-js";
import type { PersistedInboxThread } from "@/lib/portal-inbox-storage";

function genericResidentManagerLabel(value: unknown): boolean {
  const label = String(value ?? "").trim().toLowerCase();
  return !label || label === "proplane" || label === "proplane tours" || label.startsWith("property manager (");
}

/**
 * Repair only the legacy resident rows whose stored manager email is empty and
 * whose manager/property pair is still proven by the authoritative ownership
 * record. Conflicting history remains isolated for investigation.
 */
export async function enrichResidentManagerIdentities(
  db: SupabaseClient,
  rows: PersistedInboxThread[],
): Promise<PersistedInboxThread[]> {
  const candidates = rows.flatMap((row) => {
    const managerUserId = row.managerUserId?.trim() ?? "";
    const propertyId = row.propertyId?.trim() ?? "";
    return managerUserId && propertyId ? [{ managerUserId, propertyId }] : [];
  });
  if (candidates.length === 0) return rows;

  const propertyIds = [...new Set(candidates.map((candidate) => candidate.propertyId))];
  const { data: properties, error: propertyError } = await db
    .from("manager_property_records")
    .select("id, manager_user_id")
    .in("id", propertyIds);
  if (propertyError) return rows;
  const verifiedPairs = new Set(
    (properties ?? []).map((property) => `${String(property.id)}\0${String(property.manager_user_id ?? "")}`),
  );
  const managerIds = [...new Set(candidates
    .filter((candidate) => verifiedPairs.has(`${candidate.propertyId}\0${candidate.managerUserId}`))
    .map((candidate) => candidate.managerUserId))];
  if (managerIds.length === 0) return rows;
  const { data: managers, error: managerError } = await db
    .from("profiles")
    .select("id, email, full_name")
    .in("id", managerIds);
  if (managerError) return rows;
  const managerById = new Map((managers ?? []).flatMap((manager) => {
    const id = String(manager.id ?? "").trim();
    const email = String(manager.email ?? "").trim().toLowerCase();
    if (!id || !email.includes("@")) return [];
    return [[id, { email, name: String(manager.full_name ?? "").trim() || email }] as const];
  }));

  return rows.map((row) => {
    const managerUserId = row.managerUserId?.trim() ?? "";
    const propertyId = row.propertyId?.trim() ?? "";
    if (!verifiedPairs.has(`${propertyId}\0${managerUserId}`)) return row;
    const manager = managerById.get(managerUserId);
    if (!manager) return row;
    const storedEmail = row.email.trim().toLowerCase();
    if (storedEmail && storedEmail !== manager.email) return row;
    return {
      ...row,
      email: manager.email,
      from: genericResidentManagerLabel(row.from) ? manager.name : row.from,
    };
  });
}
