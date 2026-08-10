#!/usr/bin/env node
/**
 * Reset uncustomized long-term application question sets to PropLane's full
 * standard catalog (all built-in questions enabled).
 *
 * Skips listings the manager customized (`applicationConfigMode: custom`, disabled
 * keys, or custom questions).
 *
 * Dev/test:
 *   node --env-file=.env.local scripts/migrate-listing-application-defaults.mjs
 *
 * Production (captain-approved only):
 *   ALLOW_PRODUCTION_LISTING_WRITE=1 node --env-file=.env.production.local scripts/migrate-listing-application-defaults.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { refuseProductionListingWrites } from "./lib/refuse-production-listing-writes.mjs";
import { STANDARD_APPLICATION_FIELD_STANDARD_KEYS } from "./lib/standard-application-field-keys.mjs";

function loadEnvFiles() {
  for (const name of [".env.local", ".env"]) {
    const path = resolve(name);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const match = line.match(/^([^#=]+)=(.*)$/);
      if (!match || process.env[match[1]]) continue;
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  }
}

const LEGACY_FOUR_QUESTION_ENABLED_KEYS = new Set([
  "household-group-application",
  "property-property",
  "property-lease-term",
  "property-lease-start-end-dates",
]);

function isLegacyFourQuestionDefault(sub) {
  if (!sub || sub.applicationConfigMode === "custom") return false;
  if (Array.isArray(sub.customApplicationFields) && sub.customApplicationFields.length > 0) return false;
  const disabled = (sub.disabledStandardApplicationKeys ?? []).filter(
    (k) => typeof k === "string" && k.trim().length > 0,
  );
  if (disabled.length === 0) return false;
  const disabledSet = new Set(disabled);
  const enabled = STANDARD_APPLICATION_FIELD_STANDARD_KEYS.filter((key) => !disabledSet.has(key));
  if (enabled.length !== LEGACY_FOUR_QUESTION_ENABLED_KEYS.size) return false;
  return enabled.every((key) => LEGACY_FOUR_QUESTION_ENABLED_KEYS.has(key));
}

function usesPropLaneDefault(sub) {
  if (!sub || sub.applicationConfigMode === "custom") return false;
  if (Array.isArray(sub.customApplicationFields) && sub.customApplicationFields.length > 0) return false;
  if (isLegacyFourQuestionDefault(sub)) return true;
  if (
    Array.isArray(sub.disabledStandardApplicationKeys) &&
    sub.disabledStandardApplicationKeys.some((k) => typeof k === "string" && k.trim().length > 0)
  ) {
    return false;
  }
  return true;
}

function resetApplicationDefaults(sub) {
  return {
    ...sub,
    disabledStandardApplicationKeys: [],
    customApplicationFields: [],
    applicationConfigMode: "standard",
  };
}

async function api(url, key, pathname, options = {}) {
  const res = await fetch(`${url}${pathname}`, {
    ...options,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    throw new Error(`${res.status} ${typeof data === "object" ? JSON.stringify(data) : data}`);
  }
  return data;
}

async function main() {
  loadEnvFiles();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }
  refuseProductionListingWrites(url, "migrate-listing-application-defaults.mjs");

  const ref = new URL(url).hostname.split(".")[0];
  const rows = await api(
    url,
    key,
    "/rest/v1/manager_property_records?select=id,status,property_data,manager_user_id&status=in.(live,pending,draft,review,unlisted)",
  );

  let scanned = 0;
  let updated = 0;
  let skippedCustom = 0;
  let skippedNoSubmission = 0;

  for (const row of rows ?? []) {
    scanned += 1;
    const propertyData = row.property_data;
    if (!propertyData?.listingSubmission) {
      skippedNoSubmission += 1;
      continue;
    }
    const sub = propertyData.listingSubmission;
    if (!usesPropLaneDefault(sub)) {
      skippedCustom += 1;
      continue;
    }
    const nextSubmission = resetApplicationDefaults(sub);
    if (
      nextSubmission.disabledStandardApplicationKeys?.length === 0 &&
      nextSubmission.applicationConfigMode === "standard" &&
      (sub.disabledStandardApplicationKeys?.length ?? 0) === 0 &&
      sub.applicationConfigMode !== "custom"
    ) {
      continue;
    }
    const nextPropertyData = {
      ...propertyData,
      listingSubmission: nextSubmission,
    };
    await api(url, key, "/rest/v1/manager_property_records", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({
        id: row.id,
        manager_user_id: row.manager_user_id,
        status: row.status,
        property_data: nextPropertyData,
        updated_at: new Date().toISOString(),
      }),
    });
    updated += 1;
  }

  console.log(
    JSON.stringify({
      ok: true,
      project: ref,
      scanned,
      updated,
      skippedCustom,
      skippedNoSubmission,
    }),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
