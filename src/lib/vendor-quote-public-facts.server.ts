import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PublicVendorServiceFacts } from "@/lib/vendor-quote-contract";

// These expressions match whole reports, not fragments. Expanding this vocabulary
// requires reviewing the assertion and contradiction cases, not redacting free text.
const REPORTS: ReadonlyArray<[RegExp, string]> = [
  [/^(?:(?:a|the) )?(?:pipe is leaking|pipe leaks|leaking pipe|pipe leak)[.!]?$/i, "A pipe is leaking."],
  [/^(?:(?:a|the) )?(?:drain is clogged|drain is blocked|clogged drain|blocked drain)[.!]?$/i, "A drain is clogged."],
  [/^(?:(?:a|the) )?(?:faucet is leaking|faucet leaks|leaking faucet|faucet leak)[.!]?$/i, "A faucet is leaking."],
  [/^(?:(?:a|the) )?(?:toilet is leaking|toilet leaks|leaking toilet|toilet leak)[.!]?$/i, "A toilet is leaking."],
  [/^(?:(?:a|the) )?(?:toilet is clogged|clogged toilet)[.!]?$/i, "A toilet is clogged."],
  [/^(?:(?:a|the) )?(?:sink is clogged|clogged sink)[.!]?$/i, "A sink is clogged."],
];

/** Only complete, affirmative reports are recognized. Unknown/conflicting text stays unknown. */
export function projectPublicProblemSummary(row: Record<string, unknown>): string | null {
  const texts = [row.title, row.description].filter((value): value is string => typeof value === "string" && Boolean(value.trim()));
  const results: string[] = [];
  for (const text of texts) {
    const normalized = text.trim().replace(/\s+/g, " ");
    // Generic generated titles do not assert or contradict a particular problem.
    if (/^(?:service|maintenance|work order|(?:plumbing|electrical|hvac|appliance|general) issue)$/i.test(normalized)) continue;
    const match = REPORTS.find(([pattern]) => pattern.test(normalized));
    if (!match) return null;
    results.push(match[1]);
  }
  return results.length && results.every((result) => result === results[0]) ? results[0] : null;
}

const CATEGORIES: Record<string, string> = {
  plumbing: "Plumbing", electrical: "Electrical", hvac: "HVAC", appliance: "Appliance",
  access: "Access / Locks", "access / locks": "Access / Locks", cleaning: "Cleaning", general: "General", other: "Other",
};

/** Fetch only the requested manager's service and its owned property. */
export async function loadPublicVendorServiceFacts(
  db: SupabaseClient,
  input: { managerUserId: string; workOrderId: string },
): Promise<PublicVendorServiceFacts | null> {
  const work = await db.from("portal_work_order_records").select("id,assigned_property_id,property_id,row_data")
    .eq("id", input.workOrderId).eq("manager_user_id", input.managerUserId).maybeSingle();
  if (work.error || !work.data) return null;
  const row = (work.data.row_data && typeof work.data.row_data === "object" ? work.data.row_data : {}) as Record<string, unknown>;
  const propertyId = work.data.assigned_property_id || work.data.property_id || row.propertyId;
  let city = "";
  if (typeof propertyId === "string" && propertyId) {
    const property = await db.from("manager_property_records").select("row_data,property_data")
      .eq("id", propertyId).eq("manager_user_id", input.managerUserId).maybeSingle();
    if (property.error) return null;
    const data = property.data;
    const facts = data?.row_data?.submission || data?.property_data || data?.row_data || {};
    if (typeof facts.city === "string" && /^[a-zA-Z][a-zA-Z .'-]{0,79}$/.test(facts.city.trim())) city = facts.city.trim();
  }
  const rawReference = typeof row.reference === "string" ? row.reference.trim() : "";
  const match = /^(?:WO|SR)-([1-9]\d{3,7})$/i.exec(rawReference);
  const id = String(work.data.id);
  const serviceReference = match ? `SR-${match[1]}` : /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id) ? `SR-${id}` : "Service request";
  const category = typeof row.category === "string" ? CATEGORIES[row.category.trim().toLowerCase()] || "Service" : "Service";
  return { category, serviceReference, city, problemSummary: projectPublicProblemSummary(row) };
}
