#!/usr/bin/env node
// Read-only release audit for the canonical PropLane App Store record. This is
// intentionally separate from the metadata repair: it may fail because a
// subscription is incomplete, but it never creates, prices, or submits one.

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import {
  PROPLANE_PRIVACY_URL,
  resolveCanonicalApp,
  selectEditableIosVersion,
  STANDARD_APPLE_EULA_URL,
} from "./ios-app-store-metadata.mjs";
import { AscClient } from "./ios-testflight-distribute.mjs";

export const EXPECTED_APPLE_SUBSCRIPTIONS = Object.freeze({
  "space.proplane.app.pro.monthly": { period: "ONE_MONTH", usd: "20.00" },
  "space.proplane.app.pro.annual": { period: "ONE_YEAR", usd: "191.99" },
  "space.proplane.app.business.monthly": { period: "ONE_MONTH", usd: "200.00" },
  "space.proplane.app.business.annual": { period: "ONE_YEAR", usd: "1919.99" },
});

function normalizeMoney(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(2) : null;
}

export function currentUsdPrice(pricesResponse) {
  const pricePoints = new Map(
    (pricesResponse?.included ?? [])
      .filter((entry) => entry.type === "subscriptionPricePoints")
      .map((entry) => [entry.id, entry.attributes?.customerPrice]),
  );
  const dated = (pricesResponse?.data ?? [])
    .map((price) => ({
      startDate: price.attributes?.startDate ?? "0000-00-00",
      pointId: price.relationships?.subscriptionPricePoint?.data?.id,
    }))
    .filter((price) => !price.startDate || price.startDate <= new Date().toISOString().slice(0, 10))
    .sort((a, b) => b.startDate.localeCompare(a.startDate));
  return normalizeMoney(pricePoints.get(dated[0]?.pointId));
}

export function auditSubscriptionInventory(subscriptions) {
  const byProductId = new Map(
    subscriptions.map((subscription) => [subscription.attributes?.productId, subscription]),
  );
  const problems = [];

  for (const [productId, expected] of Object.entries(EXPECTED_APPLE_SUBSCRIPTIONS)) {
    const subscription = byProductId.get(productId);
    if (!subscription) {
      problems.push(`${productId} does not exist in App Store Connect`);
      continue;
    }
    const period = subscription.attributes?.subscriptionPeriod;
    if (period !== expected.period) {
      problems.push(`${productId} has duration ${period ?? "missing"}; expected ${expected.period}`);
    }
    if (subscription.usd !== expected.usd) {
      problems.push(`${productId} has US price ${subscription.usd ?? "missing"}; expected $${expected.usd}`);
    }
    if ((subscription.localizations?.length ?? 0) === 0) {
      problems.push(`${productId} has no subscription localization`);
    }
    if (subscription.attributes?.state === "MISSING_METADATA") {
      problems.push(`${productId} is missing required App Store metadata`);
    }
  }

  return problems;
}

function assertVersionLegalLinks(localizations) {
  const problems = [];
  for (const localization of localizations) {
    const locale = localization.attributes?.locale ?? localization.id;
    const description = String(localization.attributes?.description ?? "");
    if (!description.includes(STANDARD_APPLE_EULA_URL)) {
      problems.push(`${locale} app description is missing the standard Apple EULA link`);
    }
    if (!description.includes(PROPLANE_PRIVACY_URL)) {
      problems.push(`${locale} app description is missing the PropLane privacy link`);
    }
  }
  return problems;
}

async function loadSubscriptions(client, appId) {
  const groupsResponse = await client.get(`apps/${appId}/subscriptionGroups?limit=200`);
  const groups = groupsResponse?.data ?? [];
  const subscriptions = [];

  for (const group of groups) {
    const response = await client.get(`subscriptionGroups/${group.id}/subscriptions?limit=200`);
    for (const subscription of response?.data ?? []) {
      const screenshotPromise = client
        .get(`subscriptions/${subscription.id}/appStoreReviewScreenshot`)
        .catch((error) => {
          if (String(error.message).includes("HTTP 404")) return null;
          throw error;
        });
      const [localizations, prices, screenshot] = await Promise.all([
        client.get(`subscriptions/${subscription.id}/subscriptionLocalizations?limit=50`),
        client.get(
          `subscriptions/${subscription.id}/prices?filter[territory]=USA&include=subscriptionPricePoint,territory&limit=200`,
        ),
        screenshotPromise,
      ]);
      subscriptions.push({
        ...subscription,
        groupName: group.attributes?.referenceName ?? group.id,
        localizations: localizations?.data ?? [],
        usd: currentUsdPrice(prices),
        reviewScreenshot: screenshot?.data ?? null,
      });
    }
  }

  return { groups, subscriptions };
}

export async function auditAppStoreSubmission(client = new AscClient()) {
  const app = await resolveCanonicalApp(client);
  console.log(`App: ${app.attributes?.name ?? "PropLane"} (${app.id})`);

  const versionsResponse = await client.get(
    `apps/${app.id}/appStoreVersions?filter[platform]=IOS&limit=200`,
  );
  const version = selectEditableIosVersion(versionsResponse?.data ?? []);
  const state = version.attributes?.appVersionState ?? version.attributes?.appStoreState ?? "UNKNOWN";
  console.log(`Version: ${version.attributes?.versionString ?? "?"} (${state}, id ${version.id})`);

  const localizationsResponse = await client.get(
    `appStoreVersions/${version.id}/appStoreVersionLocalizations?limit=50`,
  );
  const localizations = localizationsResponse?.data ?? [];
  console.log(`Version localizations: ${localizations.map((item) => item.attributes?.locale).join(", ") || "none"}`);
  console.log(`Release type: ${version.attributes?.releaseType ?? "unset"}`);

  // What the automatic release (scripts/ios-app-store-release.mjs) will find:
  // the screenshot sets on the primary localization and the reviewer sign-in.
  const primary = localizations.find((item) => item.attributes?.locale === "en-US") ?? localizations[0];
  if (primary) {
    const setsResponse = await client.get(
      `appStoreVersionLocalizations/${primary.id}/appScreenshotSets?include=appScreenshots&limit=50`,
    );
    const counts = (setsResponse?.data ?? []).map(
      (set) => `${set.attributes?.screenshotDisplayType}: ${set.relationships?.appScreenshots?.data?.length ?? 0}`,
    );
    console.log(`Screenshot sets (${primary.attributes?.locale}): ${counts.join(", ") || "none"}`);
  }
  const reviewDetail = await client
    .get(`appStoreVersions/${version.id}/appStoreReviewDetail`)
    .catch((error) => {
      if (String(error.message).includes("HTTP 404")) return null;
      throw error;
    });
  const reviewer = reviewDetail?.data?.attributes ?? {};
  console.log(
    `Reviewer sign-in: ${reviewer.demoAccountName ? `${reviewer.demoAccountName}${reviewer.demoAccountRequired ? " (required)" : ""}` : "none set"}`,
  );

  const { groups, subscriptions } = await loadSubscriptions(client, app.id);
  console.log(`Subscription groups: ${groups.length}`);
  for (const subscription of subscriptions) {
    console.log(
      `  - ${subscription.attributes?.productId ?? subscription.id}: ` +
        `${subscription.attributes?.subscriptionPeriod ?? "no duration"}, ` +
        `${subscription.usd ? `$${subscription.usd} USD` : "no US price"}, ` +
        `${subscription.attributes?.state ?? "unknown state"}, ` +
        `${subscription.localizations.length} localization(s), ` +
        `${subscription.reviewScreenshot ? `review screenshot ${subscription.reviewScreenshot.attributes?.fileName ?? subscription.reviewScreenshot.id}` : "no review screenshot"}`,
    );
    if (subscription.reviewScreenshot?.attributes?.imageAsset) {
      console.log(
        `    imageAsset: ${JSON.stringify(subscription.reviewScreenshot.attributes.imageAsset)}`,
      );
    }
  }

  const problems = [
    ...(localizations.length === 0 ? ["The editable App Store version has no localizations"] : []),
    ...assertVersionLegalLinks(localizations),
    ...auditSubscriptionInventory(subscriptions),
  ];
  if (problems.length > 0) {
    throw new Error(`Release audit found ${problems.length} issue(s):\n- ${problems.join("\n- ")}`);
  }

  console.log("");
  console.log("✅ App Store version and all four PropLane subscription products passed the release audit.");
  return { app, version, subscriptions };
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
  auditAppStoreSubmission().catch((error) => {
    console.error("");
    console.error(`❌ ${error.message}`);
    process.exitCode = 1;
  });
}
