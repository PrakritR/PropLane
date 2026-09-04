/**
 * Enable Airbnb lease length on the three captain live listings (production only).
 *
 *   ALLOW_PRODUCTION_LISTING_WRITE=1 ENABLE_AIRBNB_LIVE_LISTINGS_CONFIRM=1 \
 *     node --env-file=.env.production.local scripts/enable-airbnb-on-live-listings-production.mjs
 */
import { createClient } from "@supabase/supabase-js";
import { refuseProductionListingWrites } from "./lib/refuse-production-listing-writes.mjs";

const LIVE_PROPERTY_IDS = [
  "mgr--9-rooms-b1wf3z",
  "mgr-seed-5259-brooklyn-ave-ne",
  "mgr-seed-4709a-8th-ave-ne",
];

const AIRBNB_LEASE_TERM = "Airbnb";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";

refuseProductionListingWrites(url, "enable-airbnb-on-live-listings-production");

if (process.env.ENABLE_AIRBNB_LIVE_LISTINGS_CONFIRM !== "1") {
  console.error("Set ENABLE_AIRBNB_LIVE_LISTINGS_CONFIRM=1 to apply.");
  process.exit(2);
}

const db = createClient(url, key, { auth: { persistSession: false } });

function syncAirbnb(terms, enabled) {
  const without = (terms ?? []).filter((t) => t !== AIRBNB_LEASE_TERM);
  return enabled ? [...without, AIRBNB_LEASE_TERM] : without;
}

const { data: rows, error } = await db
  .from("manager_property_records")
  .select("id, property_data")
  .in("id", LIVE_PROPERTY_IDS);

if (error) throw new Error(error.message);

for (const row of rows ?? []) {
  const propertyData = row.property_data ?? {};
  const submission = propertyData.listingSubmission ?? {};
  if (submission.v !== 1 && !Array.isArray(submission.rooms)) {
    console.warn(`Skip ${row.id}: no v1 listing submission on property_data`);
    continue;
  }
  const allowed = syncAirbnb(submission.allowedLeaseTerms, true);
  const nextSubmission = {
    ...submission,
    v: 1,
    airbnbRentalsAllowed: true,
    allowedLeaseTerms: allowed,
    leaseTermsBody:
      allowed.length > 0 ? `Available lease lengths: ${allowed.join(", ")}.` : submission.leaseTermsBody,
  };
  const nextPropertyData = {
    ...propertyData,
    listingSubmission: nextSubmission,
  };
  const { error: upErr } = await db
    .from("manager_property_records")
    .update({ property_data: nextPropertyData, updated_at: new Date().toISOString() })
    .eq("id", row.id);
  if (upErr) throw new Error(`${row.id}: ${upErr.message}`);
  console.log(`Enabled Airbnb on ${row.id}`);
}

const found = new Set((rows ?? []).map((r) => r.id));
for (const id of LIVE_PROPERTY_IDS) {
  if (!found.has(id)) console.warn(`Missing row: ${id}`);
}
