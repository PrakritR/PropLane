#!/usr/bin/env node
// Repair the App Store metadata required for PropLane's auto-renewable
// subscriptions without uploading a binary or replacing existing marketing copy.
// The script appends Apple's standard EULA and PropLane privacy-policy links to
// every localization on the one editable iOS version, then re-reads Apple and
// fails unless both links are present.

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { AscClient } from "./ios-testflight-distribute.mjs";

export const STANDARD_APPLE_EULA_URL =
  "https://www.apple.com/legal/internet-services/itunes/dev/stdeula/";
export const PROPLANE_PRIVACY_URL = "https://proplane.ai/privacy";

const DEFAULT_APP_ID = "6795707576";
const DEFAULT_BUNDLE_ID = "space.proplane.app";
const APP_STORE_DESCRIPTION_MAX = 4000;

// Apple permits normal version metadata edits in these pre-release/rejected
// states. Deliberately exclude WAITING_FOR_REVIEW and IN_REVIEW: silently
// pulling or mutating an active review is not a metadata repair.
const EDITABLE_VERSION_STATES = new Set([
  "PREPARE_FOR_SUBMISSION",
  "READY_FOR_REVIEW",
  "DEVELOPER_REJECTED",
  "METADATA_REJECTED",
  "REJECTED",
  "INVALID_BINARY",
]);

export function versionState(version) {
  return version?.attributes?.appVersionState ?? version?.attributes?.appStoreState ?? "UNKNOWN";
}

export function appendRequiredLegalLinks(description) {
  const current = String(description ?? "").trimEnd();
  const missing = [];
  if (!current.includes(STANDARD_APPLE_EULA_URL)) {
    missing.push(`Terms of Use (EULA): ${STANDARD_APPLE_EULA_URL}`);
  }
  if (!current.includes(PROPLANE_PRIVACY_URL)) {
    missing.push(`Privacy Policy: ${PROPLANE_PRIVACY_URL}`);
  }
  if (missing.length === 0) return current;

  const next = `${current}${current ? "\n\n" : ""}${missing.join("\n")}`;
  if (next.length > APP_STORE_DESCRIPTION_MAX) {
    throw new Error(
      `The legal-link footer would make the App Store description ${next.length} characters; ` +
        `Apple allows ${APP_STORE_DESCRIPTION_MAX}. Shorten the description before retrying.`,
    );
  }
  return next;
}

export function selectEditableIosVersion(versions) {
  const ios = versions.filter((version) => version?.attributes?.platform === "IOS");
  const editable = ios.filter((version) => EDITABLE_VERSION_STATES.has(versionState(version)));
  if (editable.length === 1) return editable[0];

  const inventory = ios
    .map(
      (version) =>
        `${version?.attributes?.versionString ?? "?"} (${versionState(version)}, id ${version?.id ?? "?"})`,
    )
    .join(", ");
  if (editable.length === 0) {
    throw new Error(
      `No editable iOS App Store version was found. Versions: ${inventory || "none"}. ` +
        "Resolve or withdraw an active review before changing version metadata.",
    );
  }
  throw new Error(
    `Found ${editable.length} editable iOS versions; refusing to guess which submission to change. ` +
      `Versions: ${inventory}`,
  );
}

export async function resolveCanonicalApp(client) {
  const bundleId = process.env.TESTFLIGHT_BUNDLE_ID || DEFAULT_BUNDLE_ID;
  const expectedAppId = (process.env.TESTFLIGHT_APP_ID || DEFAULT_APP_ID).trim();
  const response = await client.get(`apps?filter[bundleId]=${encodeURIComponent(bundleId)}&limit=2`);
  const apps = response?.data ?? [];
  if (apps.length !== 1) {
    throw new Error(`Expected one App Store app for ${bundleId}; found ${apps.length}.`);
  }
  const app = apps[0];
  if (app.id !== expectedAppId) {
    throw new Error(
      `Bundle id ${bundleId} resolved to app ${app.id}, not canonical PropLane app ${expectedAppId}. ` +
        "Refusing to touch the legacy app record.",
    );
  }
  return app;
}

function assertLegalLinks(description, locale) {
  const value = String(description ?? "");
  if (!value.includes(STANDARD_APPLE_EULA_URL) || !value.includes(PROPLANE_PRIVACY_URL)) {
    throw new Error(`Apple did not return both required legal links for ${locale}.`);
  }
}

export async function repairAppStoreMetadata(client = new AscClient()) {
  const app = await resolveCanonicalApp(client);
  console.log(`App: ${app.attributes?.name ?? "PropLane"} (${app.id})`);

  const versionsResponse = await client.get(
    `apps/${app.id}/appStoreVersions?filter[platform]=IOS&limit=200`,
  );
  const version = selectEditableIosVersion(versionsResponse?.data ?? []);
  console.log(
    `Version: ${version.attributes?.versionString ?? "?"} (${versionState(version)}, id ${version.id})`,
  );

  const localizationsResponse = await client.get(
    `appStoreVersions/${version.id}/appStoreVersionLocalizations?limit=50`,
  );
  const localizations = localizationsResponse?.data ?? [];
  if (localizations.length === 0) {
    throw new Error(`Version ${version.id} has no App Store localizations.`);
  }

  // Build and validate the entire plan before the first mutation so one long
  // localized description cannot leave Apple half-updated.
  const updates = localizations.map((localization) => {
    const locale = localization.attributes?.locale ?? localization.id;
    const current = String(localization.attributes?.description ?? "");
    return {
      id: localization.id,
      locale,
      current,
      next: appendRequiredLegalLinks(current),
    };
  });

  for (const update of updates) {
    if (update.next === update.current.trimEnd()) {
      console.log(`  ✓ ${update.locale}: legal links already present`);
      continue;
    }
    await client.patch(`appStoreVersionLocalizations/${update.id}`, {
      data: {
        type: "appStoreVersionLocalizations",
        id: update.id,
        attributes: { description: update.next },
      },
    });
    console.log(`  ✓ ${update.locale}: appended legal links`);
  }

  for (const update of updates) {
    const verified = await client.get(`appStoreVersionLocalizations/${update.id}`);
    assertLegalLinks(verified?.data?.attributes?.description, update.locale);
  }

  console.log("");
  console.log(`✅ Verified EULA and privacy-policy links on ${updates.length} App Store localization(s).`);
}

function entryHref(argvPath) {
  try {
    return pathToFileURL(realpathSync(argvPath)).href;
  } catch {
    return pathToFileURL(argvPath).href;
  }
}

const invokedDirectly = Boolean(process.argv[1]) && import.meta.url === entryHref(process.argv[1]);
if (invokedDirectly) {
  repairAppStoreMetadata().catch((error) => {
    console.error("");
    console.error(`❌ App Store metadata repair failed: ${error.message}`);
    process.exitCode = 1;
  });
}
