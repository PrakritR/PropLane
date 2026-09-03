#!/usr/bin/env npx tsx
/**
 * ONE-TIME manual production fix — NOT a migration, NOT run on deploy.
 *
 * Makes 5259 Brooklyn Ave NE an exact listing copy of 5257 Brooklyn Ave NE from
 * production (rooms, bathrooms, photos, pricing, fees, bundles, move-in copy,
 * lease/application config, property_data summary fields). Only 5259 identity
 * is preserved: record id, buildingId, street address, and building name.
 *
 * Dry run (default):
 *   npx tsx --env-file=.env.production.local scripts/copy-brooklyn-5257-full-to-5259-production.ts
 *
 * Apply (captain-approved production write — run at most once per intentional copy):
 *   ALLOW_PRODUCTION_LISTING_WRITE=1 COPY_BROOKLYN_5257_FULL_TO_5259_CONFIRM=1 \
 *   npx tsx --env-file=.env.production.local scripts/copy-brooklyn-5257-full-to-5259-production.ts --apply
 */
import { createClient } from "@supabase/supabase-js";
import { deriveLegacyFields } from "../src/lib/demo-property-pipeline";
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

type PropertyData = Record<string, unknown> & {
  id?: string;
  buildingId?: string;
  buildingName?: string;
  title?: string;
  address?: string;
  zip?: string;
  listingSubmission?: ManagerListingSubmissionV1;
};

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function listingSubmissionFromPropertyData(pd: PropertyData | null): ManagerListingSubmissionV1 | null {
  const raw = pd?.listingSubmission;
  if (!raw) return null;
  return normalizeManagerListingSubmissionV1(raw);
}

function submissionIdentity(sub: ManagerListingSubmissionV1) {
  return {
    buildingName: sub.buildingName,
    address: sub.address,
    zip: sub.zip,
    city: sub.city,
    state: sub.state,
    neighborhood: sub.neighborhood,
  };
}

function listingFingerprint(sub: ManagerListingSubmissionV1 | null): string {
  if (!sub) return "no-submission";
  return [
    `rooms=${sub.rooms.length}`,
    `baths=${sub.bathrooms.filter((b) => b.name.trim()).length}`,
    `housePhotos=${sub.housePhotoDataUrls.length}`,
    `building=${sub.buildingName.trim()}`,
    `addr=${sub.address.trim().slice(0, 40)}`,
  ].join(" ");
}

function propertyDataFingerprint(pd: PropertyData | null): string {
  if (!pd) return "no-property_data";
  return [
    `beds=${pd.beds}`,
    `baths=${pd.baths}`,
    `building=${String(pd.buildingName ?? "")}`,
    `title=${String(pd.title ?? "").slice(0, 40)}`,
  ].join(" ");
}

/** Map source room ids onto target ids when names match so live applications keep roomChoice refs. */
function remapListingRoomIdsToTarget(
  sourceSub: ManagerListingSubmissionV1,
  targetSub: ManagerListingSubmissionV1,
): ManagerListingSubmissionV1 {
  const cloned = deepClone(sourceSub);
  const targetIdByName = new Map(
    targetSub.rooms.map((room) => [room.name.trim().toLowerCase(), room.id]),
  );
  const idMap = new Map<string, string>();
  cloned.rooms = cloned.rooms.map((room, index) => {
    const existingId = targetIdByName.get(room.name.trim().toLowerCase());
    const newId = existingId ?? `room-new-${index}-${Math.random().toString(36).slice(2, 9)}`;
    idMap.set(room.id, newId);
    return { ...room, id: newId };
  });
  const remapIds = (ids: string[] | undefined) =>
    (ids ?? [])
      .map((id) => idMap.get(id))
      .filter((id): id is string => Boolean(id && cloned.rooms.some((r) => r.id === id)));
  cloned.bathrooms = cloned.bathrooms.map((bath) => ({
    ...bath,
    assignedRoomIds: remapIds(bath.assignedRoomIds),
    accessKindByRoomId: Object.fromEntries(
      Object.entries(bath.accessKindByRoomId ?? {})
        .map(([id, kind]) => {
          const mapped = idMap.get(id);
          return mapped ? [mapped, kind] : null;
        })
        .filter((entry): entry is [string, string] => Boolean(entry)),
    ),
  }));
  cloned.sharedSpaces = cloned.sharedSpaces.map((space) => ({
    ...space,
    roomAccessIds: remapIds(space.roomAccessIds),
  }));
  if (cloned.bundles) {
    cloned.bundles = cloned.bundles.map((bundle) => ({
      ...bundle,
      includedRoomIds: remapIds(bundle.includedRoomIds),
    }));
  }
  return cloned;
}

/** Resident-only move-in secrets stay on the target — public listing copy must not overwrite them. */
function preserveTargetMoveInSecrets(
  copiedSub: ManagerListingSubmissionV1,
  targetSub: ManagerListingSubmissionV1,
): ManagerListingSubmissionV1 {
  copiedSub.generalHouseInfo = targetSub.generalHouseInfo;
  copiedSub.wifiNetworkName = targetSub.wifiNetworkName;
  copiedSub.wifiPassword = targetSub.wifiPassword;
  copiedSub.houseMoveInInstructions = targetSub.houseMoveInInstructions;
  copiedSub.rooms = copiedSub.rooms.map((room) => {
    const match = targetSub.rooms.find((r) => r.name.trim() === room.name.trim());
    if (!match) return room;
    return {
      ...room,
      moveInInstructions: match.moveInInstructions,
      moveInPhotoDataUrls: match.moveInPhotoDataUrls,
      moveInVideoDataUrl: match.moveInVideoDataUrl,
    };
  });
  return copiedSub;
}

function buildTargetPropertyData(
  sourcePd: PropertyData,
  targetPd: PropertyData,
  sourceSub: ManagerListingSubmissionV1,
  targetSub: ManagerListingSubmissionV1,
): PropertyData {
  const identity = submissionIdentity(targetSub);
  const nextSub = normalizeManagerListingSubmissionV1({
    ...preserveTargetMoveInSecrets(remapListingRoomIdsToTarget(sourceSub, targetSub), targetSub),
    ...identity,
  });
  const legacy = deriveLegacyFields(nextSub);
  const monthlyRent = legacy.monthlyRent;
  const next: PropertyData = {
    ...deepClone(sourcePd),
    id: TARGET_PROPERTY_ID,
    buildingId: targetPd.buildingId ?? TARGET_PROPERTY_ID,
    buildingName: identity.buildingName,
    title: `${identity.buildingName} · ${legacy.unitLabel}`,
    address: targetPd.address ?? identity.address,
    zip: targetPd.zip ?? identity.zip,
    neighborhood: legacy.neighborhood,
    unitLabel: legacy.unitLabel,
    beds: legacy.beds,
    baths: legacy.baths,
    monthlyRent,
    rentLabel:
      monthlyRent > 0
        ? `$${monthlyRent}`
        : String(sourcePd.rentLabel ?? targetPd.rentLabel ?? ""),
    petFriendly: legacy.petFriendly,
    tagline: legacy.tagline,
    listingSubmission: nextSub,
    managerUserId: targetPd.managerUserId ?? sourcePd.managerUserId ?? AMBIKA_MANAGER_ID,
  };
  return next;
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
    if (process.env.COPY_BROOKLYN_5257_FULL_TO_5259_CONFIRM !== "1") {
      console.error("Set COPY_BROOKLYN_5257_FULL_TO_5259_CONFIRM=1 to apply this one-time copy.");
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

  const targetStatus = String(target.status ?? "").trim().toLowerCase();
  if (apply && targetStatus !== "live" && targetStatus !== "review") {
    console.error(
      `Refusing apply: target status is "${target.status}" — only live/review listings read property_data publicly.`,
    );
    process.exit(1);
  }

  const sourcePd = asObject(source.property_data) as PropertyData | null;
  const targetPd = asObject(target.property_data) as PropertyData | null;
  if (!sourcePd || !targetPd) {
    console.error("Missing property_data on source or target.");
    process.exit(1);
  }

  const sourceSub = listingSubmissionFromPropertyData(sourcePd);
  const targetSub = listingSubmissionFromPropertyData(targetPd);
  if (!sourceSub || !targetSub) {
    console.error("Could not load listing submissions for both properties.");
    process.exit(1);
  }

  const nextPd = buildTargetPropertyData(sourcePd, targetPd, sourceSub, targetSub);

  console.log("Brooklyn FULL listing copy (5257 → 5259)");
  console.log(`  Source: ${SOURCE_PROPERTY_ID} (${source.status})`);
  console.log(`  Target: ${TARGET_PROPERTY_ID} (${target.status})`);
  console.log(`  Source submission: ${listingFingerprint(sourceSub)}`);
  console.log(`  Target before:       ${listingFingerprint(targetSub)} | ${propertyDataFingerprint(targetPd)}`);
  console.log(`  Target after:        ${listingFingerprint(nextPd.listingSubmission!)} | ${propertyDataFingerprint(nextPd)}`);

  if (!apply) {
    console.log("\nDry run only — pass --apply with production confirm env vars to write.");
    return;
  }

  const { error: updateError } = await db
    .from("manager_property_records")
    .update({
      property_data: nextPd,
      updated_at: new Date().toISOString(),
    })
    .eq("id", TARGET_PROPERTY_ID)
    .eq("manager_user_id", AMBIKA_MANAGER_ID);
  if (updateError) {
    console.error("Update failed:", updateError.message);
    process.exit(1);
  }

  console.log("\nApplied — 5259 listing is now a copy of 5257 (5259 address/id preserved).");
}

void main();
