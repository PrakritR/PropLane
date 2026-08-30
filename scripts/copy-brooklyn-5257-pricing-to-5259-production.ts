#!/usr/bin/env npx tsx
/**
 * ONE-TIME manual production fix — NOT a migration, NOT run on deploy.
 *
 * Copies listing PRICING from 5257 Brooklyn Ave NE onto 5259 Brooklyn Ave NE
 * (room rent, short-term rates, Other fees, bundles, payment-at-signing).
 * Does not change photos, move-in text, marketing copy, leases, or status.
 *
 * Dry run (default):
 *   npx tsx --env-file=.env.production.local scripts/copy-brooklyn-5257-pricing-to-5259-production.ts
 *
 * Apply (captain-approved production write — run at most once):
 *   ALLOW_PRODUCTION_LISTING_WRITE=1 COPY_BROOKLYN_5257_PRICING_TO_5259_CONFIRM=1 \
 *   npx tsx --env-file=.env.production.local scripts/copy-brooklyn-5257-pricing-to-5259-production.ts --apply
 */
import { createClient } from "@supabase/supabase-js";
import {
  copyListingPricingBetweenSubmissions,
  pricingFingerprint,
} from "../src/lib/listing-pricing-copy";
import {
  normalizeManagerListingSubmissionV1,
  type ManagerListingSubmissionV1,
} from "../src/lib/manager-listing-submission";

const PROD_REF = (process.env.AXIS_PROD_SUPABASE_REF ?? "qahnczmilgptcedaqype").trim();
const AMBIKA_MANAGER_ID = "c49d02b1-7e99-4484-9986-b3b4550c3519";
const SOURCE_PROPERTY_ID = "mgr--9-rooms-b1wf3z"; // 5257 Brooklyn Ave NE
const TARGET_PROPERTY_ID = "mgr-seed-5259-brooklyn-ave-ne"; // 5259 Brooklyn Ave NE

type PropertyRow = {
  id: string;
  manager_user_id: string | null;
  status: string | null;
  row_data: unknown;
  property_data: unknown;
};

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function listingSubmissionOf(rec: PropertyRow): unknown {
  const propertyData = asObject(rec.property_data);
  const rowData = asObject(rec.row_data);
  return propertyData?.listingSubmission ?? rowData?.submission ?? null;
}

function listingSubmissionFromRecord(rec: PropertyRow): ManagerListingSubmissionV1 | null {
  const raw = listingSubmissionOf(rec);
  if (!raw) return null;
  return normalizeManagerListingSubmissionV1(raw as ManagerListingSubmissionV1);
}

function writeSubmissionToRecordPayloads(
  rec: PropertyRow,
  submission: ManagerListingSubmissionV1,
): { row_data: unknown; property_data: unknown } {
  const normalized = normalizeManagerListingSubmissionV1(submission);
  const rowData = asObject(rec.row_data);
  const propertyData = asObject(rec.property_data);
  const nextRow: Record<string, unknown> | null = rowData ? { ...rowData } : null;
  const nextProp: Record<string, unknown> | null = propertyData ? { ...propertyData } : null;
  if (nextRow && (asObject(nextRow.submission) || "submission" in nextRow)) {
    nextRow.submission = normalized;
  }
  if (nextProp) {
    nextProp.listingSubmission = normalized;
  }
  return { row_data: nextRow ?? rec.row_data, property_data: nextProp ?? rec.property_data };
}

function assertProductionGate(url: string, apply: boolean) {
  if (!url.includes(`${PROD_REF}.supabase.co`)) {
    console.error(`Refusing: expected production project ${PROD_REF}, got ${url}`);
    process.exit(1);
  }
  if (apply) {
    if (process.env.ALLOW_PRODUCTION_LISTING_WRITE !== "1") {
      console.error("Set ALLOW_PRODUCTION_LISTING_WRITE=1 to apply on production.");
      process.exit(1);
    }
    if (process.env.COPY_BROOKLYN_5257_PRICING_TO_5259_CONFIRM !== "1") {
      console.error("Set COPY_BROOKLYN_5257_PRICING_TO_5259_CONFIRM=1 to apply this one-time copy.");
      process.exit(1);
    }
  }
}

async function main() {
  const apply = process.argv.includes("--apply");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }
  assertProductionGate(url, apply);

  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  const { data, error } = await db
    .from("manager_property_records")
    .select("id,manager_user_id,status,row_data,property_data")
    .in("id", [SOURCE_PROPERTY_ID, TARGET_PROPERTY_ID]);
  if (error) {
    console.error("Read failed:", error.message);
    process.exit(1);
  }

  const rows = (data ?? []) as PropertyRow[];
  const source = rows.find((r) => r.id === SOURCE_PROPERTY_ID);
  const target = rows.find((r) => r.id === TARGET_PROPERTY_ID);
  if (!source || !target) {
    console.error("Missing source or target property row on this project.");
    process.exit(1);
  }
  for (const rec of [source, target]) {
    if (rec.manager_user_id !== AMBIKA_MANAGER_ID) {
      console.error(`Refusing: ${rec.id} is not owned by Ambika (${AMBIKA_MANAGER_ID}).`);
      process.exit(1);
    }
  }

  const sourceSub = listingSubmissionFromRecord(source);
  const targetSub = listingSubmissionFromRecord(target);
  if (!sourceSub || !targetSub) {
    console.error("Could not load listing submissions for both properties.");
    process.exit(1);
  }

  const before = pricingFingerprint(targetSub);
  const { submission, summary } = copyListingPricingBetweenSubmissions(sourceSub, targetSub);
  const after = pricingFingerprint(submission);

  console.log("Brooklyn listing pricing copy (5257 → 5259)");
  console.log(`  Source: ${SOURCE_PROPERTY_ID} (${source.status})`);
  console.log(`  Target: ${TARGET_PROPERTY_ID} (${target.status})`);
  console.log(`  Source pricing: ${pricingFingerprint(sourceSub)}`);
  console.log(`  Target before: ${before}`);
  console.log(`  Target after:  ${after}`);
  console.log(`  Summary:`, summary);

  if (!apply) {
    console.log("\nDry run only — pass --apply with production confirm env vars to write.");
    return;
  }

  const payloads = writeSubmissionToRecordPayloads(target, submission);
  const { error: updateError } = await db
    .from("manager_property_records")
    .update({
      row_data: payloads.row_data,
      property_data: payloads.property_data,
      updated_at: new Date().toISOString(),
    })
    .eq("id", TARGET_PROPERTY_ID)
    .eq("manager_user_id", AMBIKA_MANAGER_ID);
  if (updateError) {
    console.error("Update failed:", updateError.message);
    process.exit(1);
  }

  console.log("\nApplied — only listing pricing on 5259 was updated.");
}

void main();
