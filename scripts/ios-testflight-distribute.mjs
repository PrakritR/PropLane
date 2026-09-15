#!/usr/bin/env node
// Assign a freshly uploaded TestFlight build to the internal tester group, then
// PROVE the assignment stuck by re-reading the App Store Connect API.
//
// Why this exists as a separate step instead of options on `upload_to_testflight`:
// fastlane's pilot cannot both `skip_waiting_for_build_processing` and assign the
// build to a tester group in one call — assignment requires Apple to have finished
// processing the binary. The old lane skipped the wait, so builds 33-37 uploaded
// "successfully" and sat in App Store Connect with an EMPTY Groups column: green
// CI, nothing anybody could install. Keeping the upload fast and doing the wait +
// assignment + verification here means the run is red whenever the build is not
// actually installable, which is the whole point.
//
// Usage:
//   node scripts/ios-testflight-distribute.mjs                 # build from $TESTFLIGHT_BUILD_NUMBER
//   node scripts/ios-testflight-distribute.mjs --build=38      # explicit build number
//   node scripts/ios-testflight-distribute.mjs --verify-only   # report state, change nothing
//
// Auth (same secrets the workflow already sets):
//   ASC_KEY_ID     App Store Connect API key id
//   ASC_ISSUER_ID  App Store Connect issuer id
//   ASC_KEY_P8     the AuthKey_XXXX.p8 contents, base64 or raw PEM
//   ASC_KEY_P8_PATH  alternative to ASC_KEY_P8 — path to the .p8 file (local runs)
//
// Optional:
//   TESTFLIGHT_APP_ID                       expected numeric app id (default 6795707576)
//   TESTFLIGHT_BUNDLE_ID                    default space.proplane.app
//   TESTFLIGHT_INTERNAL_GROUP               exact beta group name (default "Internal — PropLane team")
//   TESTFLIGHT_PROCESSING_TIMEOUT_SECONDS   bound on the processing wait (defaults to the
//                                           largest wait that still fits the step budget)

import { createPrivateKey, sign } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const ASC_BASE = "https://api.appstoreconnect.apple.com/v1";

// The canonical PropLane app record. The pre-rebrand record
// (com.axisseattlehousing.app, shown as "PropLane Legacy") is dead but still
// installable and its build numbers are HIGHER, so pinning the app id here is a
// real guard, not ceremony — see AGENTS.md "Two iOS app records".
const DEFAULT_APP_ID = "6795707576";
const DEFAULT_BUNDLE_ID = "space.proplane.app";
const DEFAULT_GROUP_NAME = "Internal — PropLane team";

const TERMINAL_PROCESSING_FAILURES = new Set(["FAILED", "INVALID"]);
// An ALLOWLIST, not a denylist of fatal states: a denylist passes every value it
// has not heard of — including `undefined` — so a body Apple changed, truncated,
// or served as non-JSON would read as installable. Only these two states mean an
// internal tester can actually install the build.
const INSTALLABLE_INTERNAL_BUILD_STATES = new Set(["READY_FOR_BETA_TESTING", "IN_BETA_TESTING"]);

/**
 * States that mean "Apple has not decided yet", not "this build is broken".
 *
 * `build.processingState` and `buildBetaDetail.internalBuildState` are separate
 * App Store Connect resources updated by different backends, so a build can be
 * VALID and assigned while its beta detail still reads one of these. Re-polling
 * them is what keeps the allowlist from producing a false red — a workflow that
 * reds at random trains people to re-run without reading, and a guard everyone
 * ignores is worse than no guard.
 */
const TRANSIENT_INTERNAL_BUILD_STATES = new Set(["PROCESSING", "IN_EXPORT_COMPLIANCE_REVIEW"]);

/** Beta group names are compared exactly, after NFC + trim. */
export function normalizeGroupName(name) {
  return String(name ?? "")
    .normalize("NFC")
    .trim();
}

/**
 * Find the beta group whose name matches `expectedName` exactly.
 *
 * Deliberately throws rather than falling back to "the first internal group" —
 * silently distributing to the wrong group is the failure mode we are
 * eliminating, and an external group must never be picked at all.
 */
export function selectBetaGroup(groups, expectedName) {
  const wanted = normalizeGroupName(expectedName);
  const inventory = groups
    .map((group) => {
      const kind = group?.attributes?.isInternalGroup ? "internal" : "external";
      return `  - ${JSON.stringify(group?.attributes?.name ?? "")} (${kind})`;
    })
    .join("\n");

  const match = groups.find((group) => normalizeGroupName(group?.attributes?.name) === wanted);
  if (!match) {
    throw new Error(
      `No TestFlight beta group named ${JSON.stringify(wanted)} exists on this app.\n` +
        `Groups that do exist:\n${inventory || "  (none)"}\n` +
        "Create the group in App Store Connect, or set TESTFLIGHT_INTERNAL_GROUP to an existing name.",
    );
  }
  if (!match.attributes?.isInternalGroup) {
    throw new Error(
      `Beta group ${JSON.stringify(wanted)} is an EXTERNAL group. This script only ever ` +
        "distributes to internal groups (external testing needs App Review, which we do not do here).",
    );
  }
  return match;
}

function loadPrivateKeyPem() {
  const path = process.env.ASC_KEY_P8_PATH;
  if (path) return readFileSync(path, "utf8");

  const raw = process.env.ASC_KEY_P8;
  if (!raw) {
    throw new Error("Set ASC_KEY_P8 (base64 or raw PEM) or ASC_KEY_P8_PATH.");
  }
  if (raw.includes("BEGIN PRIVATE KEY")) return raw;

  const decoded = Buffer.from(raw, "base64").toString("utf8");
  if (decoded.includes("BEGIN PRIVATE KEY")) return decoded;
  throw new Error("ASC_KEY_P8 is neither a PEM private key nor base64 of one.");
}

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

// 20 minutes is Apple's maximum for a team-scoped key.
const TOKEN_TTL_SECONDS = 20 * 60;
// Re-mint this far before expiry so a request can never be sent with a token
// that dies in flight.
const TOKEN_REFRESH_MARGIN_SECONDS = 120;

/**
 * A cached token is reused only while it stays valid past the refresh margin.
 *
 * The processing wait is bounded by TESTFLIGHT_PROCESSING_TIMEOUT_SECONDS, which
 * can exceed the token's 20-minute life; a single up-front mint would 401 the
 * assign + verify calls and leave the build undistributed — the exact failure
 * this script exists to catch.
 */
export function tokenIsUsable(expiresAtSeconds, nowSeconds) {
  if (!Number.isFinite(expiresAtSeconds)) return false;
  return expiresAtSeconds - nowSeconds > TOKEN_REFRESH_MARGIN_SECONDS;
}

function mintToken() {
  const keyId = requireEnv("ASC_KEY_ID");
  const issuerId = requireEnv("ASC_ISSUER_ID");
  const key = createPrivateKey(loadPrivateKeyPem());

  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + TOKEN_TTL_SECONDS;
  const header = base64url(JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({ iss: issuerId, iat: issuedAt, exp: expiresAt, aud: "appstoreconnect-v1" }),
  );
  // JWS wants the raw r||s pair, not the DER sequence node emits by default.
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), {
    key,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return { token: `${header}.${payload}.${signature}`, expiresAt };
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}.`);
  return value;
}

// `timeout-minutes: 30` on the distribute step in
// .github/workflows/ios-testflight.yml is the hard ceiling for everything below.
export const STEP_BUDGET_SECONDS = 30 * 60;

export const REQUEST_ATTEMPTS = 4;
export const REQUEST_BACKOFF_STEP_MS = 2000;
export const CONFIRM_ATTEMPTS = 5;
export const CONFIRM_INTERVAL_MS = 12_000;
const PROCESSING_POLL_INTERVAL_MS = 20_000;
/** ~60s of re-reads (4 sleeps) before a still-transient beta state fails closed. */
export const BETA_STATE_ATTEMPTS = 5;
export const BETA_STATE_INTERVAL_MS = 15_000;

/** Worst-case backoff one request can spend before it gives up or succeeds. */
const REQUEST_BACKOFF_BUDGET_MS =
  ((REQUEST_ATTEMPTS * (REQUEST_ATTEMPTS - 1)) / 2) * REQUEST_BACKOFF_STEP_MS;

/**
 * Round-trip time allowed per request. Backoff sleeps are not the only cost: a
 * reserve built from sleeps alone leaves nothing for the network itself, so the
 * advertised maximum wait would still run into the step cap.
 */
const REQUEST_LATENCY_BUDGET_MS = 5000;

/** Node boot + module load before the first request goes out. */
const PROCESS_STARTUP_BUDGET_MS = 15_000;

/**
 * Every request that is NOT inside the bounded processing wait, so its retry
 * backoff eats step budget the wait's own timeout does not cover:
 *   2  resolveApp + the betaGroups read, before the wait even starts
 *   1  the findBuild that lands on the deadline (the poll sleep is clamped to
 *      the deadline, so this is the only work the wait can run past it)
 *   1  the alreadyAssigned pre-check
 *   2  the two assign POST shapes
 *   +  one read per confirmAssignment attempt
 *   +  one buildBetaDetail read per beta-state attempt
 */
export const REQUESTS_OUTSIDE_PROCESSING_WAIT =
  2 + 1 + 1 + 2 + CONFIRM_ATTEMPTS + BETA_STATE_ATTEMPTS;

/**
 * Every sleep that happens outside the bounded processing wait. One term per
 * source, so adding another is a single line here and the reserve below follows
 * automatically.
 */
const SLEEP_MS_OUTSIDE_PROCESSING_WAIT =
  // confirmAssignment's sleeps between re-reads.
  (CONFIRM_ATTEMPTS - 1) * CONFIRM_INTERVAL_MS +
  // resolveInstallableBetaState's sleeps while the state is still transient.
  (BETA_STATE_ATTEMPTS - 1) * BETA_STATE_INTERVAL_MS;

/**
 * Seconds the work outside the processing wait can take, so the advertised
 * maximum wait still leaves room to finish. Derived from the constants above
 * rather than hard-coded: a second magic number would drift the moment one of
 * them changed, and the failure it causes is the opaque mid-verification
 * cancellation that `parseTimeoutSeconds` exists to prevent.
 */
const POST_WAIT_RESERVE_SECONDS = Math.ceil(
  (SLEEP_MS_OUTSIDE_PROCESSING_WAIT +
    REQUESTS_OUTSIDE_PROCESSING_WAIT * (REQUEST_BACKOFF_BUDGET_MS + REQUEST_LATENCY_BUDGET_MS) +
    PROCESS_STARTUP_BUDGET_MS) /
    1000,
);

export const MAX_PROCESSING_TIMEOUT_SECONDS = STEP_BUDGET_SECONDS - POST_WAIT_RESERVE_SECONDS;

/**
 * Wait as long as the step budget allows, since Apple's processing queue is the
 * unpredictable part. Derived, not a literal: a hard-coded default silently
 * became LARGER than the maximum its own validator allows the moment the reserve
 * grew, which would have made every default run fail on a bad-config error.
 */
export const DEFAULT_PROCESSING_TIMEOUT_SECONDS = MAX_PROCESSING_TIMEOUT_SECONDS;

/**
 * Reject a timeout that cannot do what it claims.
 *
 * An unvalidated `Number("abc")` yields NaN, `Date.now() >= NaN` is never true, and
 * the poll loop then runs until the workflow's step cap kills the job — replacing a
 * clear timeout message and its `--build=` remediation hint with an opaque
 * cancellation. A value above the step cap fails the same way.
 */
export function parseTimeoutSeconds(raw, { max = MAX_PROCESSING_TIMEOUT_SECONDS } = {}) {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return DEFAULT_PROCESSING_TIMEOUT_SECONDS;
  }
  const parsed = Number(String(raw).trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `TESTFLIGHT_PROCESSING_TIMEOUT_SECONDS must be a positive number of seconds, got ${JSON.stringify(raw)}.`,
    );
  }
  if (parsed > max) {
    throw new Error(
      `TESTFLIGHT_PROCESSING_TIMEOUT_SECONDS=${parsed} exceeds the ${max}s the workflow step allows, ` +
        "so the job would be cancelled mid-wait instead of reporting a timeout. Lower it, or raise the " +
        "step's timeout-minutes in .github/workflows/ios-testflight.yml first.",
    );
  }
  return parsed;
}

function describeApiError(body) {
  const errors = body?.errors;
  if (!Array.isArray(errors) || errors.length === 0) return JSON.stringify(body);
  return errors
    .map((error) => [error.title, error.detail, error.code].filter(Boolean).join(" — "))
    .join("; ");
}

export class AscClient {
  constructor(mint = mintToken) {
    this.mint = mint;
    this.cached = null;
  }

  authToken() {
    const now = Math.floor(Date.now() / 1000);
    if (!this.cached || !tokenIsUsable(this.cached.expiresAt, now)) {
      this.cached = this.mint();
    }
    return this.cached.token;
  }

  async request(method, path, body) {
    // Always ASC_BASE. There is deliberately no absolute-URL branch and no env
    // override for the host: every request carries a signed App Store Connect
    // token, so any caller- or config-supplied origin is a way for the release
    // pipeline to hand that token to another host. Callers pass paths only.
    const url = `${ASC_BASE}/${path.replace(/^\/+/, "")}`;
    let lastError;
    // Apple's API 429s and 5xxs under load; a bounded retry keeps a whole build
    // cycle from being wasted on a transient blip. 401 is deliberately NOT
    // retryable — a genuinely bad credential must fail fast and loudly.
    //
    // node's fetch REJECTS rather than returning a response on connection
    // resets, DNS blips and socket hangups, so those must be caught here too.
    // The processing wait makes ~75 requests over up to 25 minutes from a CI
    // runner: without this, one dropped socket fails a run whose build is fine,
    // and during confirmAssignment it produces exactly the false red the
    // re-poll exists to prevent.
    for (let attempt = 1; attempt <= REQUEST_ATTEMPTS; attempt += 1) {
      // Minted OUTSIDE the try. A missing ASC_ISSUER_ID or an unparseable
      // ASC_KEY_P8 is a configuration failure, not a transport blip: it must
      // surface immediately with its own message, exactly like the 401 that a
      // bad credential earns, instead of being retried four times behind
      // "transport error" and blamed on the network.
      const token = this.authToken();
      let retryable = false;
      try {
        const response = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });

        if (response.status === 204) return null;
        const text = await response.text();
        const parsed = text ? safeJsonParse(text) : null;
        if (response.ok) return parsed;

        lastError = new Error(
          `${method} ${url} → HTTP ${response.status}: ${parsed ? describeApiError(parsed) : text.slice(0, 500)}`,
        );
        retryable = response.status === 429 || response.status >= 500;
      } catch (error) {
        lastError = new Error(`${method} ${url} → transport error: ${error.message}`);
        retryable = true;
      }

      // Callers that tolerate a failed read (the processing wait) must tolerate
      // ONLY this class. Tagging it here is the point: the request layer is where
      // "was this worth retrying" is actually known, so deciding it anywhere else
      // means guessing — and guessing turns a revoked key into "Apple is slow".
      lastError.retryable = retryable;

      if (!retryable || attempt === REQUEST_ATTEMPTS) throw lastError;
      const backoffMs = REQUEST_BACKOFF_STEP_MS * attempt;
      console.log(`  ↻ ${lastError.message.slice(0, 160)}; retrying in ${backoffMs / 1000}s`);
      await sleep(backoffMs);
    }
    throw lastError;
  }

  get(path) {
    return this.request("GET", path);
  }

  post(path, body) {
    return this.request("POST", path, body);
  }

  patch(path, body) {
    return this.request("PATCH", path, body);
  }

  delete(path, body) {
    return this.request("DELETE", path, body);
  }
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function resolveApp(client, bundleId, expectedAppId) {
  const body = await client.get(`apps?filter[bundleId]=${encodeURIComponent(bundleId)}&limit=2`);
  const apps = body?.data ?? [];
  if (apps.length === 0) {
    throw new Error(`No App Store Connect app found for bundle id ${bundleId}.`);
  }
  if (apps.length > 1) {
    throw new Error(
      `Bundle id ${bundleId} matched ${apps.length} apps (${apps.map((app) => app.id).join(", ")}).`,
    );
  }
  const app = apps[0];
  if (expectedAppId && app.id !== expectedAppId) {
    throw new Error(
      `Bundle id ${bundleId} resolved to app ${app.id}, but TESTFLIGHT_APP_ID expects ${expectedAppId}. ` +
        "Refusing to distribute — this is exactly how the legacy app record swallowed builds.",
    );
  }
  return app;
}

export async function findBuild(client, appId, buildNumber) {
  const query = new URLSearchParams({
    "filter[app]": appId,
    "filter[version]": buildNumber,
    limit: "10",
  });
  const body = await client.get(`builds?${query}`);
  const builds = body?.data ?? [];
  if (builds.length > 1) {
    // Untagged on purpose: callers tolerate ONLY `retryable === true`, so this
    // fails fast without needing a second classification channel.
    throw new Error(
      `Build number ${buildNumber} matched ${builds.length} builds on app ${appId} ` +
        `(${builds.map((build) => build.id).join(", ")}); cannot pick one safely.`,
    );
  }
  return builds[0] ?? null;
}

/**
 * Poll until the build exists and Apple has finished processing it, or the deadline passes.
 *
 * A read that fails is a tick, not the end of the wait — but ONLY when the request
 * layer tagged it `retryable`. `findBuild` throws once the request layer's own retry
 * budget is spent, so a ~15s Apple 5xx window or a single 429 used to red a promote
 * whose build is fine while 20+ minutes of the deadline sat unused — the same false
 * red the group-membership and beta-state re-polls exist to prevent. Anything else
 * surfaces immediately with its own message: a 401 or 403 must not be re-read for
 * 20 minutes and then reported as Apple being slow. This stays fail-closed: a build
 * that never reads VALID still reds the run, a terminal processingState still fails
 * immediately, and an ambiguous build number carries no `retryable` tag, so it is
 * never mistaken for a blip.
 */
export async function waitForProcessedBuild(client, appId, buildNumber, timeoutSeconds) {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutSeconds * 1000;
  let lastState = null;
  let observedState = null;
  let lastReadError = null;

  for (;;) {
    let build = null;
    let readFailed = false;
    try {
      build = await findBuild(client, appId, buildNumber);
      lastReadError = null;
    } catch (error) {
      // Tolerate ONLY an affirmatively retryable failure. A 401 (revoked or
      // clock-skewed key), a 403, a permanent 4xx — or any untagged error, which
      // is by definition not something we decided was worth retrying — surfaces
      // immediately with its own message. Spinning out the full deadline and then
      // reporting "could not be read" would blame Apple for our own bad
      // credential: exactly the self-misdescribing behaviour this script ends.
      if (error?.retryable !== true) throw error;
      readFailed = true;
      lastReadError = error;
    }
    const elapsed = Math.round((Date.now() - startedAt) / 1000);

    if (readFailed) {
      console.log(`  [${elapsed}s] build ${buildNumber}: read failed, still waiting — ${lastReadError.message.slice(0, 160)}`);
      lastState = null;
    } else {
      const state = build ? (build.attributes?.processingState ?? "UNKNOWN") : "NOT_YET_VISIBLE";
      observedState = state;

      if (state !== lastState) {
        console.log(`  [${elapsed}s] build ${buildNumber}: ${state}`);
        lastState = state;
      } else {
        console.log(`  [${elapsed}s] still ${state}…`);
      }

      if (build && TERMINAL_PROCESSING_FAILURES.has(state)) {
        throw new Error(
          `Build ${buildNumber} finished processing as ${state}. It can never be distributed; ` +
            "check the App Store Connect activity log for the rejection reason.",
        );
      }
      if (build && state === "VALID") return build;
    }

    if (Date.now() >= deadline) {
      // Distinguish "Apple never finished" from "we could never ask" — reporting a
      // state that was never actually read would send someone hunting the wrong bug.
      // The FINAL read decides the wording: `observedState` is never cleared, so a
      // build that read once and then failed every read up to the deadline would
      // otherwise be reported as a stuck state with the read error dropped entirely.
      const outcome = !readFailed
        ? `was still "${observedState}" after ${timeoutSeconds}s`
        : `could not be read at the ${timeoutSeconds}s deadline ` +
          (observedState
            ? `(last state successfully read: "${observedState}"; ` +
              `last error: ${lastReadError?.message ?? "unknown"})`
            : `(every App Store Connect read failed; last error: ${lastReadError?.message ?? "unknown"})`);
      throw new Error(
        `Build ${buildNumber} ${outcome}. ` +
          "The upload succeeded but the build is NOT distributed, so nobody can install it. " +
          "Re-run this step once processing finishes: " +
          `node scripts/ios-testflight-distribute.mjs --build=${buildNumber}`,
      );
    }
    // Clamped to the deadline: an unclamped interval overshoots it by up to a
    // full poll, which is step budget the reserve above would have to guess at.
    await sleep(Math.min(PROCESSING_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
  }
}

/**
 * Ask Apple directly whether THIS build is in THIS group.
 *
 * Deliberately an exact filtered query rather than a page of the group's builds:
 * a beta group accumulates every build ever assigned to it, so a paged read
 * would eventually report a correctly-assigned build as missing. Every call is a
 * fresh request — the final verification must reflect the API, never a cached
 * pre-check or the POST's status code.
 */
async function isBuildAssignedToGroup(client, buildId, groupId) {
  const query = new URLSearchParams({
    "filter[id]": buildId,
    "filter[betaGroups]": groupId,
    limit: "1",
  });
  const body = await client.get(`builds?${query}`);
  return (body?.data ?? []).some((build) => build.id === buildId);
}

/**
 * Confirm membership by re-reading the API, retrying briefly before giving up.
 *
 * `filter[betaGroups]` is served by a search index that can lag the relationship
 * write by a few seconds, so a single read would occasionally fail a promote for
 * a build that is genuinely assigned and installable. Re-polling keeps the API
 * read as the SOLE gate — it never softens the verdict, it only stops a false red.
 *
 * A retryable read failure is a tick here too, exactly as in the processing wait:
 * without that, a 20-second Apple 5xx window during confirmation throws away the
 * remaining re-poll budget and reds a promote whose build IS installable. Anything
 * not tagged retryable — a 401 from a revoked key, a 403, a permanent 4xx —
 * propagates immediately with its own message.
 */
async function confirmAssignment(
  client,
  buildId,
  groupId,
  { attempts = CONFIRM_ATTEMPTS, intervalMs = CONFIRM_INTERVAL_MS } = {},
) {
  let lastReadError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      if (await isBuildAssignedToGroup(client, buildId, groupId)) return true;
      lastReadError = null;
      if (attempt === attempts) return false;
      console.log(`  not visible in the group yet (read ${attempt}/${attempts}); re-reading in ${intervalMs / 1000}s`);
    } catch (error) {
      if (error?.retryable !== true) throw error;
      lastReadError = error;
      if (attempt === attempts) {
        throw new Error(
          `Could not confirm group membership: every read failed. Last error: ${lastReadError.message}`,
        );
      }
      console.log(
        `  membership read failed (read ${attempt}/${attempts}), still confirming — ` +
          `${error.message.slice(0, 160)}`,
      );
    }
    await sleep(intervalMs);
  }
  return false;
}

/**
 * POST the relationship. Returns the failure reason instead of throwing, so the
 * verification read — not a status code — decides the outcome.
 *
 * That matters concretely: a POST retried after a transient 5xx can come back 409
 * "already exists", and throwing there would fail a run whose build is assigned
 * and installable.
 */
async function assignBuildToGroup(client, buildId, groupId) {
  // Apple documents both directions of this relationship. Try the canonical
  // "Add Builds to a Beta Group" first; if Apple rejects the shape, try the
  // inverse before giving up.
  const attempts = [
    { path: `betaGroups/${groupId}/relationships/builds`, body: { data: [{ type: "builds", id: buildId }] } },
    { path: `builds/${buildId}/relationships/betaGroups`, body: { data: [{ type: "betaGroups", id: groupId }] } },
  ];

  const failures = [];
  for (const attempt of attempts) {
    try {
      await client.post(attempt.path, attempt.body);
      console.log(`  ✓ POST ${attempt.path} accepted`);
      return null;
    } catch (error) {
      failures.push(`${attempt.path}: ${error.message}`);
      console.log(`  ✗ POST ${attempt.path} failed: ${error.message}`);
    }
  }
  return `Both relationship writes were rejected:\n${failures.join("\n")}`;
}

/**
 * Log the beta states and return them, or `null` if no state could be read.
 *
 * Reporting is separate from asserting so the diagnostics still print when the run
 * is about to fail for a different reason — a failure with no state in the log is
 * one someone has to reproduce by hand. The request itself already retries
 * transport errors and 5xx, so a `null` here means an affirmatively retryable read
 * genuinely failed; anything else is re-thrown with its own message.
 *
 * A body with no `internalBuildState` is `null` too, never an empty object: an
 * empty object is truthy and would slip past the fail-closed branch below. HTTP
 * 204, an empty 2xx body and a 200 carrying non-JSON (a proxy's HTML) all land
 * here as "no state", which is indistinguishable from a failed read and must be
 * treated as one.
 */
async function reportBetaDetail(client, buildId) {
  let detail = null;
  try {
    detail = await client.get(`builds/${buildId}/buildBetaDetail`);
  } catch (error) {
    console.log(`  buildBetaDetail could NOT be read: ${error.message}`);
    // Only an affirmatively retryable failure becomes the fail-closed UNKNOWN
    // path, exactly like the processing wait. A 401, a 403, a permanent 4xx — or
    // any untagged error — surfaces with its own message instead of being
    // reported as an unknown beta state, which would blame Apple's compliance
    // pipeline for our own credential.
    if (error?.retryable !== true) throw error;
    return null;
  }
  const attributes = detail?.data?.attributes;
  console.log(`  internalBuildState: ${attributes?.internalBuildState ?? "unknown"}`);
  console.log(`  externalBuildState: ${attributes?.externalBuildState ?? "unknown"}`);
  return attributes?.internalBuildState ? attributes : null;
}

/**
 * Fail unless the build is affirmatively in an installable state.
 *
 * Deliberately fails CLOSED when the state could not be read at all: this whole
 * step exists so that a green run means a tester can install the build, and
 * "unknown" must never render as green. A build that is actually fine is one
 * `--verify-only` away from confirmation, which is far cheaper than shipping the
 * belief that something installable went out when it did not.
 */
/** True while Apple has simply not finished deciding, so a re-read may still turn green. */
export function betaStateIsTransient(attributes) {
  const state = attributes?.internalBuildState;
  return Boolean(state) && TRANSIENT_INTERNAL_BUILD_STATES.has(state);
}

/**
 * Read the beta state, re-reading only while it is TRANSIENT.
 *
 * The allowlist in `assertInstallableBetaState` is intolerant by design, and
 * `buildBetaDetail` lags `build.processingState` because they are different
 * resources on different backends. Re-polling closes that gap without weakening
 * anything: it can only turn a not-yet-decided state into a decided one, exactly
 * like the group-membership re-poll. An unreadable state is NOT retried here —
 * the request layer already retried it, so it is a real unknown and fails closed.
 */
async function resolveInstallableBetaState(client, buildId, options = {}) {
  const { attempts = BETA_STATE_ATTEMPTS, intervalMs = BETA_STATE_INTERVAL_MS } = options;
  let attributes = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    attributes = await reportBetaDetail(client, buildId);
    if (!betaStateIsTransient(attributes)) return attributes;
    if (attempt === attempts) break;
    console.log(
      `  ${attributes.internalBuildState} is transient (read ${attempt}/${attempts}); ` +
        `re-reading in ${intervalMs / 1000}s`,
    );
    await sleep(intervalMs);
  }
  return attributes;
}

export function assertInstallableBetaState(attributes, buildNumber) {
  const state = attributes?.internalBuildState;
  if (!state) {
    throw new Error(
      `Build ${buildNumber} IS assigned to the internal group, but its export-compliance / beta state ` +
        "could NOT be read after retries, so whether a tester can install it is UNKNOWN. " +
        "Not reporting success on an unknown. Re-check with: " +
        `node scripts/ios-testflight-distribute.mjs --build=${buildNumber} --verify-only`,
    );
  }
  if (INSTALLABLE_INTERNAL_BUILD_STATES.has(state)) return;
  if (state === "MISSING_EXPORT_COMPLIANCE") {
    throw new Error(
      `Build ${buildNumber} is assigned to the group but its internalBuildState is ` +
        `${state}, so testers still cannot install it. Export compliance is ` +
        "declared via ITSAppUsesNonExemptEncryption in ios/App/App/Info.plist — verify that key " +
        "survived the last cap sync.",
    );
  }
  throw new Error(
    `Build ${buildNumber} is assigned to the group but its internalBuildState is ` +
      `${state}, which is not one of the states an internal tester can install from ` +
      `(${[...INSTALLABLE_INTERNAL_BUILD_STATES].join(", ")}). Not reporting success on a build ` +
      "nobody can install.",
  );
}

async function main() {
  const args = process.argv.slice(2);
  const verifyOnly = args.includes("--verify-only");
  const buildArg = args.find((arg) => arg.startsWith("--build="))?.split("=")[1];
  const buildNumber = (buildArg || process.env.TESTFLIGHT_BUILD_NUMBER || "").trim();
  if (!buildNumber) {
    throw new Error(
      "No build number. Pass --build=<n> or set TESTFLIGHT_BUILD_NUMBER " +
        "(the workflow reads it from the fastlane step output).",
    );
  }

  const bundleId = process.env.TESTFLIGHT_BUNDLE_ID || DEFAULT_BUNDLE_ID;
  // `||`, not `??`: an empty-string override (a `${{ vars.X }}` on an unset repo
  // variable) must fall back to the default rather than silently disabling the
  // app-id pin, which is the guard against shipping onto the legacy record.
  const expectedAppId = (process.env.TESTFLIGHT_APP_ID || DEFAULT_APP_ID).trim();
  const groupName = process.env.TESTFLIGHT_INTERNAL_GROUP || DEFAULT_GROUP_NAME;
  const timeoutSeconds = parseTimeoutSeconds(process.env.TESTFLIGHT_PROCESSING_TIMEOUT_SECONDS);

  const client = new AscClient();

  const app = await resolveApp(client, bundleId, expectedAppId);
  console.log(`App: ${app.attributes?.name ?? "?"} (${bundleId}, id ${app.id})`);

  const groupsBody = await client.get(`betaGroups?filter[app]=${app.id}&limit=200`);
  const group = selectBetaGroup(groupsBody?.data ?? [], groupName);
  console.log(`Internal group: ${JSON.stringify(group.attributes.name)} (id ${group.id})`);

  // --verify-only answers "is build N installable RIGHT NOW". Polling for up to
  // ~23 minutes and then timing out is the wrong answer to that question, and it
  // contradicts the "report state without changing anything" this flag documents.
  let build;
  if (verifyOnly) {
    build = await findBuild(client, app.id, buildNumber);
    if (!build) {
      throw new Error(`Build ${buildNumber} does not exist on app ${app.id} (nothing to report).`);
    }
    const state = build.attributes?.processingState ?? "UNKNOWN";
    console.log(`Build ${buildNumber} processingState: ${state}`);
    if (state !== "VALID") {
      throw new Error(
        `Build ${buildNumber} is ${state}, not VALID, so it is not installable yet. ` +
          "Not waiting — re-run this command to check again, or drop --verify-only to wait and distribute.",
      );
    }
  } else {
    console.log(`Waiting for build ${buildNumber} to finish processing (max ${timeoutSeconds}s)…`);
    build = await waitForProcessedBuild(client, app.id, buildNumber, timeoutSeconds);
  }
  console.log(
    `Build ${buildNumber} is VALID (id ${build.id}, ` +
      `usesNonExemptEncryption=${JSON.stringify(build.attributes?.usesNonExemptEncryption ?? null)}, ` +
      `expired=${JSON.stringify(build.attributes?.expired ?? null)})`,
  );

  if (build.attributes?.expired) {
    throw new Error(`Build ${buildNumber} is already expired; it cannot be distributed.`);
  }

  // A blip on the pre-check must not red the run either: treat an unreadable
  // pre-check as "not known to be assigned" and let the assignment (whose 409 is
  // already tolerated) and the confirming read decide. A non-retryable error still
  // propagates.
  // `preCheckRead` records whether the read actually returned a value. Without it
  // a failed read is indistinguishable from a successful "no", and --verify-only
  // (which skips `confirmAssignment` below) would report a membership state it
  // never read as though it were a fact.
  let alreadyAssigned = false;
  let preCheckRead = false;
  try {
    alreadyAssigned = await isBuildAssignedToGroup(client, build.id, group.id);
    preCheckRead = true;
  } catch (error) {
    if (error?.retryable !== true) throw error;
    console.log(
      verifyOnly
        ? `  pre-check read failed, re-reading before reporting — ${error.message.slice(0, 160)}`
        : `  pre-check read failed, proceeding to assign — ${error.message.slice(0, 160)}`,
    );
  }
  let assignError = null;
  if (alreadyAssigned) {
    console.log("Build is already assigned to the group; nothing to change.");
  } else if (verifyOnly) {
    // Only a read that succeeded may be reported as a state.
    if (preCheckRead) {
      console.log("--verify-only: build is NOT assigned to the group. Not changing anything.");
    }
  } else {
    console.log("Assigning build to the internal group…");
    // Deliberately does not throw: the verification read decides, so a 409
    // "already exists" cannot fail a run whose build really is installable.
    assignError = await assignBuildToGroup(client, build.id, group.id);
  }

  // Verification is a fresh read, not a restatement of the POST's status code.
  console.log("");
  console.log("Verification (fresh read of builds?filter[id]=…&filter[betaGroups]=…):");
  const assigned = verifyOnly
    ? preCheckRead
      ? alreadyAssigned
      // The pre-check never returned a value, so there is nothing to report yet.
      // Spend ONE more read (still no polling) rather than asserting non-membership
      // that was never observed: if this read also fails, `confirmAssignment` throws
      // "Could not confirm group membership" instead of claiming the build is NOT
      // in the group.
      : await confirmAssignment(client, build.id, group.id, { attempts: 1 })
    : await confirmAssignment(client, build.id, group.id);
  console.log(`  build ${buildNumber} (${build.id}) in ${JSON.stringify(group.attributes.name)}: ${assigned}`);
  // --verify-only never polls: it reports the state as it stands right now. An
  // unassigned build is already going to fail below, so it gets the same single
  // read — the diagnostics still land in the log, without spending ~60s re-polling
  // a transient state whose value is then discarded.
  const betaDetail =
    verifyOnly || !assigned
      ? await reportBetaDetail(client, build.id)
      : await resolveInstallableBetaState(client, build.id);

  if (!assigned) {
    throw new Error(
      `Build ${buildNumber} is NOT in ${JSON.stringify(group.attributes.name)}. ` +
        "The upload is useless to testers — failing so this does not read as a successful ship." +
        (assignError ? `\nAssignment attempts: ${assignError}` : ""),
    );
  }
  if (assignError) {
    console.log(`  (assignment POST reported an error, but the API says the build IS assigned: ${assignError})`);
  }
  assertInstallableBetaState(betaDetail, buildNumber);

  console.log("");
  console.log(`✅ Build ${buildNumber} is distributed to ${group.attributes.name} and installable by internal testers.`);
}

// `import`ed by tests for the pure helpers; only run as a CLI.
//
// Both sides must be built the same way node builds import.meta.url: percent
// encoded (a checkout path with a space would otherwise never match) and
// realpath'd (node resolves module specifiers through symlinks). A guard that
// silently mismatches exits 0 having done nothing, which is the worst possible
// outcome for a script whose entire job is failing loudly.
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
    console.error(`❌ TestFlight distribution failed: ${error.message}`);
    process.exitCode = 1;
  });
}
