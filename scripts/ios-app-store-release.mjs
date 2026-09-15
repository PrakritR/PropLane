#!/usr/bin/env node
// The App Store half of a production push.
//
// After the TestFlight distribute step has proved the build is processed and
// installable, this script makes the App Store follow: it picks (or creates) the
// store version, syncs the store page from app-store/ (screenshots + copy),
// attaches the build, submits the version for review, and only exits 0 once
// App Store Connect reads back WAITING_FOR_REVIEW — or once it has said, in
// plain words, why it is holding (a review already in Apple's queue, a rejected
// version that a human has to look at).
//
//   node scripts/ios-app-store-release.mjs --plan-version
//       Print the marketing version the NEXT build must carry (stdout only, no
//       writes). The workflow passes it to fastlane as MARKETING_VERSION so a
//       closed train can never reject an upload again.
//
//   TESTFLIGHT_BUILD_NUMBER=<n> node scripts/ios-app-store-release.mjs
//       Release that build (the push path).
//
//   node scripts/ios-app-store-release.mjs --latest-build
//       Catch-up (schedule / workflow_dispatch mode=release): release the newest
//       processed build if no review is pending; exits 0 with nothing to do
//       when that build is on a train Apple has already released.
//
//   --dry-run          Every read, no writes; prints each call it would make.
//   --force-resubmit   Resubmit a REJECTED / METADATA_REJECTED version. Never the
//                      default: an automatic resubmit of the rejected thing is a loop.
//
// Env: ASC_KEY_ID / ASC_ISSUER_ID / ASC_KEY_P8 (the existing secrets),
//      APP_STORE_RELEASE_TYPE (AFTER_APPROVAL | MANUAL; default AFTER_APPROVAL),
//      APP_STORE_DRY_RUN=true (same as --dry-run, for workflow inputs).

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  appendRequiredLegalLinks,
  resolveCanonicalApp,
  versionState,
} from "./ios-app-store-metadata.mjs";
import {
  AscClient,
  findBuild,
  parseTimeoutSeconds,
  waitForProcessedBuild,
} from "./ios-testflight-distribute.mjs";

const REPO = resolve(new URL("..", import.meta.url).pathname);
export const APP_STORE_DIR = resolve(REPO, "app-store");
const PBXPROJ = resolve(REPO, "ios/App/App.xcodeproj/project.pbxproj");
const LOCALE = "en-US";

/** Apple's limits for the fields copy.json carries. */
export const COPY_LIMITS = Object.freeze({
  promotionalText: 170,
  description: 4000,
  whatsNew: 4000,
  keywords: 100,
});

/** Which app-store/screenshots folder feeds which App Store Connect display type. */
export const SCREENSHOT_SETS = Object.freeze([
  { folder: "iphone-6.9", displayType: "APP_IPHONE_67", width: 1320, height: 2868 },
  { folder: "ipad-13", displayType: "APP_IPAD_PRO_3GEN_129", width: 2064, height: 2752 },
]);
export const MAX_SCREENSHOTS_PER_SET = 10;

// A version we may write to and submit.
const EDITABLE_STATES = new Set([
  "PREPARE_FOR_SUBMISSION",
  "READY_FOR_REVIEW",
  "DEVELOPER_REJECTED",
  "INVALID_BINARY",
]);
// Apple rejected it; a human decides whether the same thing goes back.
const REJECTED_STATES = new Set(["REJECTED", "METADATA_REJECTED"]);
// Apple is working on it (or has approved it and is waiting on us / itself).
const PENDING_STATES = new Set([
  "WAITING_FOR_REVIEW",
  "IN_REVIEW",
  "PENDING_APPLE_RELEASE",
  "PENDING_DEVELOPER_RELEASE",
  "PROCESSING_FOR_DISTRIBUTION",
]);
// After submission Apple may read back either of these before the review starts.
const SUBMITTED_STATES = new Set(["WAITING_FOR_REVIEW", "IN_REVIEW", "READY_FOR_REVIEW"]);

const VERSION_RE = /^\d+(\.\d+){0,2}$/;

export function parseVersion(value) {
  const text = String(value ?? "").trim();
  if (!VERSION_RE.test(text)) return null;
  const parts = text.split(".").map((part) => Number(part));
  while (parts.length < 3) parts.push(0);
  return parts;
}

export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) throw new Error(`Cannot compare versions ${JSON.stringify(a)} and ${JSON.stringify(b)}.`);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

export function bumpPatch(version) {
  const parts = parseVersion(version);
  if (!parts) throw new Error(`Cannot bump version ${JSON.stringify(version)}.`);
  return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
}

/** The marketing version hand-set in Xcode. A floor, so a deliberate minor/major bump is honoured. */
export function readXcodeMarketingVersion(pbxprojText) {
  const match = /MARKETING_VERSION = ([0-9.]+);/.exec(pbxprojText);
  return match ? match[1] : null;
}

function iosVersions(versions) {
  return (versions ?? []).filter((version) => version?.attributes?.platform === "IOS");
}

function describeVersion(version) {
  return `${version?.attributes?.versionString ?? "?"} (${versionState(version)}, id ${version?.id ?? "?"})`;
}

/**
 * The one decision: given every iOS version on the app, what does this run do?
 *
 *   { action: "reuse", version }            an editable version exists — write to it
 *   { action: "create", versionString }     nothing editable or pending — make the next patch
 *   { action: "hold", reason, version }     Apple is reviewing / has rejected — do not touch
 *
 * `forceResubmit` turns a rejected version into a reuse. Nothing turns a version
 * Apple is actively reviewing into anything: that is the queue, and we wait for it.
 */
export function planRelease(versions, { forceResubmit = false, xcodeVersion = null } = {}) {
  const ios = iosVersions(versions);
  const pending = ios.filter((version) => PENDING_STATES.has(versionState(version)));
  if (pending.length > 0) {
    const version = pending[0];
    const state = versionState(version);
    const reason =
      state === "PENDING_DEVELOPER_RELEASE"
        ? `${describeVersion(version)} is approved and waiting for a manual release in App Store Connect`
        : `${describeVersion(version)} is with Apple (${state})`;
    return { action: "hold", reason, version };
  }

  const rejected = ios.filter((version) => REJECTED_STATES.has(versionState(version)));
  const editable = ios.filter((version) => EDITABLE_STATES.has(versionState(version)));
  if (rejected.length > 0 && !forceResubmit) {
    const version = rejected[0];
    return {
      action: "hold",
      reason:
        `${describeVersion(version)} was rejected by Apple. Read the rejection in App Store Connect, fix it, ` +
        "then run the iOS workflow by hand in mode release with force_resubmit on",
      version,
    };
  }
  const candidates = forceResubmit ? [...editable, ...rejected] : editable;
  if (candidates.length > 1) {
    throw new Error(
      `Found ${candidates.length} editable iOS versions; refusing to guess: ${candidates.map(describeVersion).join(", ")}`,
    );
  }
  if (candidates.length === 1) return { action: "reuse", version: candidates[0] };

  // Nothing in flight: the next patch after the highest version Apple has seen,
  // never below what Xcode says.
  const seen = ios.map((version) => version?.attributes?.versionString).filter((v) => parseVersion(v));
  let next = seen.length > 0 ? bumpPatch(seen.sort(compareVersions).at(-1)) : "1.0.0";
  if (xcodeVersion && parseVersion(xcodeVersion) && compareVersions(xcodeVersion, next) > 0) next = xcodeVersion;
  return { action: "create", versionString: next };
}

/**
 * The marketing version the next BUILD must carry so the store can attach it.
 * A version in Apple's queue keeps its train open, but a build meant for the
 * store after it must sit on the next train — so the plan is "highest version
 * Apple has seen, plus one patch", and an editable version's own string wins
 * when it is already ahead (someone bumped minor/major on purpose).
 */
export function planBuildVersion(versions, { xcodeVersion = null } = {}) {
  const ios = iosVersions(versions);
  const editable = ios.find((version) => EDITABLE_STATES.has(versionState(version)) || REJECTED_STATES.has(versionState(version)));
  const others = ios
    .filter((version) => version !== editable)
    .map((version) => version?.attributes?.versionString)
    .filter((v) => parseVersion(v))
    .sort(compareVersions);
  let candidate = others.length > 0 ? bumpPatch(others.at(-1)) : "1.0.0";
  const editableString = editable?.attributes?.versionString;
  if (editableString && parseVersion(editableString) && compareVersions(editableString, candidate) >= 0) {
    candidate = editableString;
  }
  if (xcodeVersion && parseVersion(xcodeVersion) && compareVersions(xcodeVersion, candidate) > 0) candidate = xcodeVersion;
  return candidate;
}

export function readCopy(dir = APP_STORE_DIR) {
  const raw = JSON.parse(readFileSync(resolve(dir, "copy.json"), "utf8"));
  return validateCopy(raw);
}

export function validateCopy(copy) {
  const problems = [];
  for (const [field, limit] of Object.entries(COPY_LIMITS)) {
    const value = copy?.[field];
    if (typeof value !== "string" || value.trim() === "") problems.push(`${field} is missing`);
    else if (value.length > limit) problems.push(`${field} is ${value.length} characters; Apple allows ${limit}`);
  }
  if (typeof copy?.keywords === "string" && /,\s/.test(copy.keywords)) {
    problems.push("keywords must be comma-separated without spaces after the commas");
  }
  if (problems.length > 0) throw new Error(`app-store/copy.json: ${problems.join("; ")}`);
  return copy;
}

/** PNG header → { width, height }, or null when the file is not a PNG. */
export function pngSize(bytes) {
  if (bytes.length < 24) return null;
  const signature = bytes.subarray(0, 8).toString("hex");
  if (signature !== "89504e470d0a1a0a") return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** The local screenshot set for one display type, in store order, with Apple's checksum (MD5). */
export function readLocalScreenshots(set, dir = APP_STORE_DIR) {
  const folder = resolve(dir, "screenshots", set.folder);
  if (!existsSync(folder)) return [];
  const files = readdirSync(folder).filter((name) => name.toLowerCase().endsWith(".png")).sort();
  if (files.length > MAX_SCREENSHOTS_PER_SET) {
    throw new Error(`${set.folder} has ${files.length} screenshots; Apple allows ${MAX_SCREENSHOTS_PER_SET}.`);
  }
  return files.map((fileName) => {
    const bytes = readFileSync(resolve(folder, fileName));
    const size = pngSize(bytes);
    if (!size || size.width !== set.width || size.height !== set.height) {
      throw new Error(
        `${set.folder}/${fileName} is ${size ? `${size.width}×${size.height}` : "not a PNG"}; ` +
          `${set.displayType} needs ${set.width}×${set.height}. Re-run npm run app-store:shots.`,
      );
    }
    return { fileName, bytes, checksum: createHash("md5").update(bytes).digest("hex") };
  });
}

/** True when the store already holds exactly these files, in this order. */
export function screenshotsMatch(remote, local) {
  const remoteSums = (remote ?? [])
    .map((shot) => String(shot?.attributes?.sourceFileChecksum ?? "").toLowerCase())
    .filter(Boolean);
  const localSums = local.map((shot) => shot.checksum);
  return remoteSums.length === localSums.length && remoteSums.every((sum, index) => sum === localSums[index]);
}

/**
 * Apple's upload URLs are pre-signed and live on another host. They must NEVER
 * see the signed API token — the AscClient refuses other hosts for exactly that
 * reason — so this helper sends only the headers Apple asked for.
 */
export function uploadHeaders(operation) {
  const headers = {};
  for (const header of operation?.requestHeaders ?? []) {
    if (header?.name && /^authorization$/i.test(header.name)) continue;
    if (header?.name) headers[header.name] = header.value;
  }
  return headers;
}

async function putChunk(operation, bytes) {
  const body = bytes.subarray(operation.offset, operation.offset + operation.length);
  const response = await fetch(operation.url, { method: operation.method ?? "PUT", headers: uploadHeaders(operation), body });
  if (!response.ok) {
    throw new Error(`Screenshot chunk upload → HTTP ${response.status} (${(await response.text()).slice(0, 200)})`);
  }
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

class Release {
  constructor(client, { dryRun }) {
    this.client = client;
    this.dryRun = dryRun;
  }

  /** A write: performed, or printed and skipped under --dry-run. */
  async write(label, run) {
    if (this.dryRun) {
      console.log(`  [dry-run] would ${label}`);
      return null;
    }
    console.log(`  ${label}`);
    return run();
  }

  async listVersions(appId) {
    const body = await this.client.get(`apps/${appId}/appStoreVersions?filter[platform]=IOS&limit=200`);
    return body?.data ?? [];
  }

  async ensureVersion(app, plan, buildVersionString, releaseType) {
    if (plan.action === "create") {
      const versionString = buildVersionString ?? plan.versionString;
      const created = await this.write(`create App Store version ${versionString} (${releaseType})`, () =>
        this.client.post("appStoreVersions", {
          data: {
            type: "appStoreVersions",
            attributes: { platform: "IOS", versionString, releaseType },
            relationships: { app: { data: { type: "apps", id: app.id } } },
          },
        }),
      );
      return created?.data ?? { id: "(new)", attributes: { versionString, releaseType } };
    }
    const version = plan.version;
    const attributes = {};
    if (version.attributes?.releaseType !== releaseType) attributes.releaseType = releaseType;
    if (buildVersionString && version.attributes?.versionString !== buildVersionString) {
      attributes.versionString = buildVersionString;
    }
    if (Object.keys(attributes).length > 0) {
      await this.write(`update version ${describeVersion(version)} → ${JSON.stringify(attributes)}`, () =>
        this.client.patch(`appStoreVersions/${version.id}`, {
          data: { type: "appStoreVersions", id: version.id, attributes },
        }),
      );
    }
    return version;
  }

  async localization(version) {
    if (version.id === "(new)") return null;
    const body = await this.client.get(`appStoreVersions/${version.id}/appStoreVersionLocalizations?limit=50`);
    const all = body?.data ?? [];
    const match = all.find((loc) => loc?.attributes?.locale === LOCALE) ?? all[0];
    if (!match) throw new Error(`Version ${version.id} has no App Store localizations.`);
    return match;
  }

  async syncCopy(localization, copy) {
    if (!localization) {
      console.log(`  [dry-run] would write copy.json to the ${LOCALE} localization of the new version`);
      return;
    }
    const current = localization.attributes ?? {};
    const wanted = {
      promotionalText: copy.promotionalText,
      description: appendRequiredLegalLinks(copy.description),
      whatsNew: copy.whatsNew,
      keywords: copy.keywords,
    };
    const changed = Object.fromEntries(Object.entries(wanted).filter(([key, value]) => (current[key] ?? "") !== value));
    if (Object.keys(changed).length === 0) {
      console.log(`  copy: ${LOCALE} already matches copy.json`);
      return;
    }
    await this.write(`update ${LOCALE} copy: ${Object.keys(changed).join(", ")}`, () =>
      this.client.patch(`appStoreVersionLocalizations/${localization.id}`, {
        data: { type: "appStoreVersionLocalizations", id: localization.id, attributes: changed },
      }),
    );
  }

  async syncScreenshots(localization, set) {
    const local = readLocalScreenshots(set);
    if (local.length === 0) {
      console.log(`  screenshots ${set.folder}: no files in app-store/screenshots/${set.folder}, leaving the store as is`);
      return 0;
    }
    if (!localization) {
      console.log(`  [dry-run] would upload ${local.length} ${set.folder} screenshots to the new version`);
      return local.length;
    }
    const setsBody = await this.client.get(
      `appStoreVersionLocalizations/${localization.id}/appScreenshotSets?filter[screenshotDisplayType]=${set.displayType}&include=appScreenshots&limit=10`,
    );
    let screenshotSet = (setsBody?.data ?? [])[0] ?? null;
    const remote = (setsBody?.included ?? []).filter((entry) => entry.type === "appScreenshots");
    // `included` is unordered; the set's relationship data carries the order.
    const order = (screenshotSet?.relationships?.appScreenshots?.data ?? []).map((ref) => ref.id);
    remote.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));

    if (screenshotSet && screenshotsMatch(remote, local)) {
      console.log(`  screenshots ${set.folder}: ${local.length} already on the store, unchanged`);
      return 0;
    }

    if (!screenshotSet) {
      const created = await this.write(`create ${set.displayType} screenshot set`, () =>
        this.client.post("appScreenshotSets", {
          data: {
            type: "appScreenshotSets",
            attributes: { screenshotDisplayType: set.displayType },
            relationships: { appStoreVersionLocalization: { data: { type: "appStoreVersionLocalizations", id: localization.id } } },
          },
        }),
      );
      screenshotSet = created?.data ?? null;
    }
    for (const shot of remote) {
      await this.write(`delete stale screenshot ${shot.attributes?.fileName ?? shot.id}`, () =>
        this.client.delete(`appScreenshots/${shot.id}`),
      );
    }
    for (const shot of local) {
      await this.write(`upload ${set.folder}/${shot.fileName} (${shot.bytes.length} bytes)`, async () => {
        const reserved = await this.client.post("appScreenshots", {
          data: {
            type: "appScreenshots",
            attributes: { fileName: shot.fileName, fileSize: shot.bytes.length },
            relationships: { appScreenshotSet: { data: { type: "appScreenshotSets", id: screenshotSet.id } } },
          },
        });
        const id = reserved?.data?.id;
        for (const operation of reserved?.data?.attributes?.uploadOperations ?? []) {
          await putChunk(operation, shot.bytes);
        }
        await this.client.patch(`appScreenshots/${id}`, {
          data: { type: "appScreenshots", id, attributes: { uploaded: true, sourceFileChecksum: shot.checksum } },
        });
      });
    }
    if (!this.dryRun) await this.waitForAssets(screenshotSet.id, local.length);
    return local.length;
  }

  /**
   * Any other iPhone / iPad display set on the version is a leftover from a
   * hand upload (the July 6.5" and 11" sets were still the AXIS-branded 1.0
   * screens). Apple falls back to the 6.9" and 13" sets for every size, so the
   * leftovers are removed rather than left to show an older app on some phones.
   */
  async pruneUnmanagedSets(localization) {
    if (!localization) return 0;
    const managed = new Set(SCREENSHOT_SETS.map((set) => set.displayType));
    const body = await this.client.get(`appStoreVersionLocalizations/${localization.id}/appScreenshotSets?limit=50`);
    let pruned = 0;
    for (const set of body?.data ?? []) {
      const type = set.attributes?.screenshotDisplayType ?? "";
      if (managed.has(type) || !/^APP_(IPHONE|IPAD)/.test(type)) continue;
      await this.write(`remove leftover ${type} screenshot set (Apple reuses the 6.9"/13" sets)`, () =>
        this.client.delete(`appScreenshotSets/${set.id}`),
      );
      pruned += 1;
    }
    return pruned;
  }

  /** Apple processes uploads asynchronously; a version cannot submit while one is still processing. */
  async waitForAssets(setId, expected) {
    for (let attempt = 1; attempt <= 30; attempt += 1) {
      const body = await this.client.get(`appScreenshotSets/${setId}/appScreenshots?limit=10`);
      const shots = body?.data ?? [];
      const states = shots.map((shot) => shot.attributes?.assetDeliveryState?.state ?? "UNKNOWN");
      const failed = shots.filter((shot) => shot.attributes?.assetDeliveryState?.state === "FAILED");
      if (failed.length > 0) {
        const why = failed.map((shot) => `${shot.attributes?.fileName}: ${JSON.stringify(shot.attributes?.assetDeliveryState?.errors ?? [])}`);
        throw new Error(`Apple rejected ${failed.length} screenshot(s): ${why.join("; ")}`);
      }
      if (shots.length === expected && states.every((state) => state === "COMPLETE")) return;
      console.log(`  screenshots processing (${states.filter((s) => s === "COMPLETE").length}/${expected} complete)…`);
      await sleep(10_000);
    }
    throw new Error("Screenshots were still processing after five minutes; re-run the release to submit.");
  }

  async resolveBuild(app, { buildNumber, latest, timeoutSeconds }) {
    let build;
    if (latest) {
      const body = await this.client.get(
        `builds?filter[app]=${app.id}&filter[processingState]=VALID&sort=-uploadedDate&limit=1&include=preReleaseVersion`,
      );
      build = (body?.data ?? [])[0];
      if (!build) throw new Error(`App ${app.id} has no processed build to release.`);
      const train = (body?.included ?? []).find((entry) => entry.type === "preReleaseVersions");
      return { build, versionString: train?.attributes?.version ?? null };
    }
    if (this.dryRun) {
      build = await findBuild(this.client, app.id, buildNumber);
      if (!build) throw new Error(`Build ${buildNumber} does not exist on app ${app.id}.`);
    } else {
      build = await waitForProcessedBuild(this.client, app.id, buildNumber, timeoutSeconds);
    }
    const detail = await this.client.get(`builds/${build.id}?include=preReleaseVersion`);
    const train = (detail?.included ?? []).find((entry) => entry.type === "preReleaseVersions");
    return { build: detail?.data ?? build, versionString: train?.attributes?.version ?? null };
  }

  async ensureExportCompliance(build) {
    if (build.attributes?.usesNonExemptEncryption === null || build.attributes?.usesNonExemptEncryption === undefined) {
      await this.write(`declare build ${build.attributes?.version} uses only exempt encryption`, () =>
        this.client.patch(`builds/${build.id}`, {
          data: { type: "builds", id: build.id, attributes: { usesNonExemptEncryption: false } },
        }),
      );
    }
  }

  async attachBuild(version, build) {
    if (version.id === "(new)") {
      console.log(`  [dry-run] would attach build ${build.attributes?.version} to the new version`);
      return;
    }
    const current = await this.client.get(`appStoreVersions/${version.id}/relationships/build`);
    if (current?.data?.id === build.id) {
      console.log(`  build ${build.attributes?.version} already attached`);
      return;
    }
    await this.write(`attach build ${build.attributes?.version} (${build.id}) to version ${version.attributes?.versionString}`, () =>
      this.client.patch(`appStoreVersions/${version.id}/relationships/build`, { data: { type: "builds", id: build.id } }),
    );
  }

  async assertReviewerLogin(version) {
    if (version.id === "(new)") {
      console.log("  [dry-run] would check the reviewer sign-in on the new version");
      return;
    }
    let detail = null;
    try {
      detail = await this.client.get(`appStoreVersions/${version.id}/appStoreReviewDetail`);
    } catch (error) {
      if (!/HTTP 404/.test(error.message)) throw error;
    }
    const attributes = detail?.data?.attributes ?? {};
    if (attributes.demoAccountRequired && attributes.demoAccountName && attributes.demoAccountPassword !== undefined) return;
    if (!attributes.demoAccountRequired && attributes.demoAccountName) return;
    throw new Error(
      `Version ${version.attributes?.versionString} has no reviewer sign-in (App Review Information → Sign-in required). ` +
        "App Store Connect normally carries it over from the previous version; set it there once, then re-run in mode release.",
    );
  }

  async submit(app, version) {
    if (version.id === "(new)") {
      console.log("  [dry-run] would submit the new version for review");
      return;
    }
    const existing = await this.client.get(`reviewSubmissions?filter[app]=${app.id}&filter[platform]=IOS&filter[state]=READY_FOR_REVIEW,UNRESOLVED_ISSUES&limit=5`);
    let submission = (existing?.data ?? [])[0] ?? null;
    if (!submission) {
      const created = await this.write("create review submission", () =>
        this.client.post("reviewSubmissions", {
          data: { type: "reviewSubmissions", attributes: { platform: "IOS" }, relationships: { app: { data: { type: "apps", id: app.id } } } },
        }),
      );
      submission = created?.data ?? null;
    }
    if (!submission) return;
    const items = await this.client.get(`reviewSubmissions/${submission.id}/items?limit=10`);
    const hasVersion = (items?.data ?? []).some((item) => item?.relationships?.appStoreVersion?.data?.id === version.id);
    if (!hasVersion) {
      await this.write(`add version ${version.attributes?.versionString} to the submission`, () =>
        this.client.post("reviewSubmissionItems", {
          data: {
            type: "reviewSubmissionItems",
            relationships: {
              reviewSubmission: { data: { type: "reviewSubmissions", id: submission.id } },
              appStoreVersion: { data: { type: "appStoreVersions", id: version.id } },
            },
          },
        }),
      );
    }
    await this.write("submit for review", () =>
      this.client.patch(`reviewSubmissions/${submission.id}`, {
        data: { type: "reviewSubmissions", id: submission.id, attributes: { submitted: true } },
      }),
    );
  }

  async verifySubmitted(version) {
    if (this.dryRun || version.id === "(new)") return "(dry-run)";
    for (let attempt = 1; attempt <= 12; attempt += 1) {
      const body = await this.client.get(`appStoreVersions/${version.id}`);
      const state = versionState(body?.data);
      if (SUBMITTED_STATES.has(state)) return state;
      console.log(`  version reads ${state}; waiting for WAITING_FOR_REVIEW…`);
      await sleep(10_000);
    }
    throw new Error(`Version ${version.attributes?.versionString} did not reach WAITING_FOR_REVIEW after submission.`);
  }
}

function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (file) appendFileSync(file, `${name}=${value}\n`);
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run") || /^(1|true)$/i.test(process.env.APP_STORE_DRY_RUN ?? "");
  const forceResubmit = args.includes("--force-resubmit") || /^(1|true)$/i.test(process.env.APP_STORE_FORCE_RESUBMIT ?? "");
  const xcodeVersion = existsSync(PBXPROJ) ? readXcodeMarketingVersion(readFileSync(PBXPROJ, "utf8")) : null;

  const client = new AscClient();
  const app = await resolveCanonicalApp(client);
  const release = new Release(client, { dryRun });
  const versions = await release.listVersions(app.id);

  if (args.includes("--plan-version")) {
    // stdout is the answer; everything else goes to stderr so `$(…)` stays clean.
    const planned = planBuildVersion(versions, { xcodeVersion });
    console.error(`Versions: ${iosVersions(versions).map(describeVersion).join(", ") || "none"}`);
    console.error(`Xcode MARKETING_VERSION: ${xcodeVersion ?? "?"} → build as ${planned}`);
    process.stdout.write(`${planned}\n`);
    return;
  }

  console.log(`App: ${app.attributes?.name ?? "PropLane"} (${app.id})${dryRun ? "  — DRY RUN, no writes" : ""}`);
  console.log(`Versions: ${iosVersions(versions).map(describeVersion).join(", ") || "none"}`);
  const copy = readCopy();

  const plan = planRelease(versions, { forceResubmit, xcodeVersion });
  if (plan.action === "hold") {
    console.log("");
    console.log(`⏸  Holding: ${plan.reason}.`);
    console.log("   TestFlight has the build; the App Store step will run again on the next push or the 6-hourly catch-up.");
    setOutput("store", "held");
    return;
  }

  const latest = args.includes("--latest-build");
  const buildNumber = (args.find((arg) => arg.startsWith("--build="))?.split("=")[1] || process.env.TESTFLIGHT_BUILD_NUMBER || "").trim();
  if (!latest && !buildNumber) {
    throw new Error("No build. Set TESTFLIGHT_BUILD_NUMBER (the push path) or pass --latest-build (the catch-up).");
  }
  const timeoutSeconds = parseTimeoutSeconds(process.env.TESTFLIGHT_PROCESSING_TIMEOUT_SECONDS);
  const { build, versionString: buildVersionString } = await release.resolveBuild(app, { buildNumber, latest, timeoutSeconds });
  console.log(`Build: ${build.attributes?.version ?? "?"} on train ${buildVersionString ?? "?"} (${build.attributes?.processingState ?? "?"})`);
  if (plan.action === "create" && buildVersionString && compareVersions(buildVersionString, plan.versionString) < 0) {
    if (latest) {
      // The catch-up found nothing newer than the train already released: the
      // last push shipped and there is no parked build. That is a quiet success,
      // not a failure to repeat every six hours.
      console.log("");
      console.log(`✓ Nothing to catch up: newest build ${build.attributes?.version} is on train ${buildVersionString}, which is already released.`);
      setOutput("store", "nothing-to-release");
      return;
    }
    throw new Error(
      `Build ${build.attributes?.version} is on train ${buildVersionString}, but the next store version must be ${plan.versionString} ` +
        "(that train is already released). Push again so fastlane builds on the planned version.",
    );
  }

  const releaseType = (process.env.APP_STORE_RELEASE_TYPE || "AFTER_APPROVAL").toUpperCase();
  if (!["AFTER_APPROVAL", "MANUAL"].includes(releaseType)) throw new Error(`APP_STORE_RELEASE_TYPE must be AFTER_APPROVAL or MANUAL, got ${releaseType}.`);

  console.log("");
  console.log(`Plan: ${plan.action === "create" ? `create ${buildVersionString ?? plan.versionString}` : `reuse ${describeVersion(plan.version)}`}, release ${releaseType}`);
  const version = await release.ensureVersion(app, plan, buildVersionString, releaseType);
  const localization = await release.localization(version);
  await release.syncCopy(localization, copy);
  let uploaded = 0;
  for (const set of SCREENSHOT_SETS) uploaded += await release.syncScreenshots(localization, set);
  await release.pruneUnmanagedSets(localization);
  await release.ensureExportCompliance(build);
  await release.attachBuild(version, build);
  await release.assertReviewerLogin(version);
  await release.submit(app, version);
  const state = await release.verifySubmitted(version);

  console.log("");
  console.log(`✅ Version ${version.attributes?.versionString} with build ${build.attributes?.version} is ${state}; ${uploaded} screenshot(s) uploaded; release ${releaseType}.`);
  setOutput("store", dryRun ? "dry-run" : "submitted");
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
  main().catch((error) => {
    console.error("");
    console.error(`❌ App Store release failed: ${error.message}`);
    process.exitCode = 1;
  });
}
