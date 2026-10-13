import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ASC_BASE,
  AscClient,
  assertInstallableBetaState,
  assignBuildToGroup,
  AUTO_DISTRIBUTION_CONFIRM_ATTEMPTS,
  AUTO_DISTRIBUTION_CONFIRM_INTERVAL_MS,
  autoDistributionConfirmAttempts,
  BETA_STATE_ATTEMPTS,
  BETA_STATE_INTERVAL_MS,
  betaStateIsTransient,
  CONFIRM_ATTEMPTS,
  CONFIRM_INTERVAL_MS,
  confirmAssignment,
  confirmationWindow,
  DEFAULT_PROCESSING_TIMEOUT_SECONDS,
  MAX_PROCESSING_TIMEOUT_SECONDS,
  normalizeGroupName,
  parseTimeoutSeconds,
  REQUEST_ATTEMPTS,
  REQUEST_BACKOFF_STEP_MS,
  REQUESTS_OUTSIDE_PROCESSING_WAIT,
  selectBetaGroup,
  STEP_BUDGET_SECONDS,
  tokenIsUsable,
} from "../../scripts/ios-testflight-distribute.mjs";

const repoRoot = path.resolve(__dirname, "../..");
const readRepoFile = (relative: string) => readFileSync(path.join(repoRoot, relative), "utf8");

const group = (name: string, isInternalGroup: boolean, id = name) => ({
  id,
  attributes: { name, isInternalGroup },
});

const INTERNAL_GROUP = "Internal — PropLane team";

describe("selectBetaGroup", () => {
  it("matches the internal group by exact name", () => {
    const groups = [group("Public beta", false), group(INTERNAL_GROUP, true, "grp-1")];
    expect(selectBetaGroup(groups, INTERNAL_GROUP).id).toBe("grp-1");
  });

  it("tolerates surrounding whitespace and Unicode normalization, not different names", () => {
    const groups = [group(`  ${INTERNAL_GROUP}  `, true, "grp-1")];
    expect(selectBetaGroup(groups, INTERNAL_GROUP).id).toBe("grp-1");

    // A hyphen is not an em dash — this must not fuzzy-match.
    expect(() => selectBetaGroup([group("Internal - PropLane team", true)], INTERNAL_GROUP)).toThrow(
      /No TestFlight beta group named/,
    );
  });

  it("fails loudly instead of falling back to another internal group", () => {
    const groups = [group("Internal testers", true), group("Team", true)];
    expect(() => selectBetaGroup(groups, INTERNAL_GROUP)).toThrow(/No TestFlight beta group named/);
    // The error lists what does exist so the fix is obvious from CI logs alone.
    expect(() => selectBetaGroup(groups, INTERNAL_GROUP)).toThrow(/Internal testers/);
  });

  it("refuses an external group even on an exact name match", () => {
    const groups = [group(INTERNAL_GROUP, false)];
    expect(() => selectBetaGroup(groups, INTERNAL_GROUP)).toThrow(/EXTERNAL group/);
  });

  it("fails on an empty group list rather than treating it as nothing to do", () => {
    expect(() => selectBetaGroup([], INTERNAL_GROUP)).toThrow(/No TestFlight beta group named/);
  });
});

describe("normalizeGroupName", () => {
  it("is total over nullish input", () => {
    expect(normalizeGroupName(undefined)).toBe("");
    expect(normalizeGroupName(null)).toBe("");
  });
});

describe("tokenIsUsable", () => {
  const now = 1_700_000_000;

  it("keeps a token that outlives the refresh margin", () => {
    expect(tokenIsUsable(now + 20 * 60, now)).toBe(true);
  });

  it("re-mints before expiry rather than sending a token that dies in flight", () => {
    // A processing wait longer than the 20-minute token life used to 401 the
    // assign + verify calls and leave the build undistributed.
    expect(tokenIsUsable(now + 120, now)).toBe(false);
    expect(tokenIsUsable(now - 1, now)).toBe(false);
    expect(tokenIsUsable(undefined, now)).toBe(false);
  });
});

describe("parseTimeoutSeconds", () => {
  it("defaults when unset or blank", () => {
    expect(parseTimeoutSeconds(undefined)).toBe(DEFAULT_PROCESSING_TIMEOUT_SECONDS);
    expect(parseTimeoutSeconds("")).toBe(DEFAULT_PROCESSING_TIMEOUT_SECONDS);
    expect(parseTimeoutSeconds("   ")).toBe(DEFAULT_PROCESSING_TIMEOUT_SECONDS);
  });

  it("accepts a positive number", () => {
    expect(parseTimeoutSeconds("600")).toBe(600);
    expect(parseTimeoutSeconds(" 900 ")).toBe(900);
  });

  it("rejects a non-numeric value instead of polling forever on NaN", () => {
    // Number("abc") -> NaN makes `Date.now() >= deadline` never true, so the
    // wait would run until the workflow step cap killed the job with no
    // diagnostic — replacing the timeout message and its --build= hint.
    expect(() => parseTimeoutSeconds("abc")).toThrow(/positive number of seconds/);
    expect(() => parseTimeoutSeconds("0")).toThrow(/positive number of seconds/);
    expect(() => parseTimeoutSeconds("-30")).toThrow(/positive number of seconds/);
  });

  it("rejects a value that would outlive the workflow step cap", () => {
    expect(() => parseTimeoutSeconds(String(MAX_PROCESSING_TIMEOUT_SECONDS + 1))).toThrow(
      /exceeds the .* the workflow step allows/,
    );
    expect(parseTimeoutSeconds(String(MAX_PROCESSING_TIMEOUT_SECONDS))).toBe(MAX_PROCESSING_TIMEOUT_SECONDS);
  });
});

describe("beta-state gate fails closed", () => {
  // The whole point of the distribute step is that a green run means a tester can
  // install the build. An unreadable compliance state is not evidence of that, so
  // it must not pass — that is the failure mode this branch exists to remove.
  it("refuses to report success when the beta state could not be read", () => {
    expect(() => assertInstallableBetaState(null, "38")).toThrow(/UNKNOWN/);
    expect(() => assertInstallableBetaState(null, "38")).toThrow(/--verify-only/);
    expect(() => assertInstallableBetaState(null, "38")).toThrow(/build 38|Build 38/);
  });

  it("treats an empty payload as UNKNOWN, not as nothing-wrong", () => {
    // `{}` is truthy, so a denylist gate would pass it: HTTP 204, an empty 2xx
    // body and a proxy's HTML 200 all arrive as an attribute-less payload.
    expect(() => assertInstallableBetaState({}, "38")).toThrow(/UNKNOWN/);
    expect(() => assertInstallableBetaState({}, "38")).toThrow(/--verify-only/);
  });

  it("treats a payload missing internalBuildState as UNKNOWN", () => {
    expect(() => assertInstallableBetaState({ externalBuildState: "READY_FOR_BETA_TESTING" }, "38")).toThrow(
      /UNKNOWN/,
    );
  });

  it("fails on a state that blocks installation", () => {
    expect(() =>
      assertInstallableBetaState({ internalBuildState: "MISSING_EXPORT_COMPLIANCE" }, "38"),
    ).toThrow(/ITSAppUsesNonExemptEncryption/);
    expect(() => assertInstallableBetaState({ internalBuildState: "PROCESSING_EXCEPTION" }, "38")).toThrow();
  });

  it("fails on a state it has never heard of rather than assuming it is fine", () => {
    expect(() => assertInstallableBetaState({ internalBuildState: "SOME_FUTURE_APPLE_STATE" }, "38")).toThrow(
      /SOME_FUTURE_APPLE_STATE/,
    );
    expect(() => assertInstallableBetaState({ internalBuildState: "PROCESSING" }, "38")).toThrow();
    expect(() => assertInstallableBetaState({ internalBuildState: "EXPIRED" }, "38")).toThrow();
  });

  it("passes an installable state", () => {
    expect(() => assertInstallableBetaState({ internalBuildState: "IN_BETA_TESTING" }, "38")).not.toThrow();
    expect(() =>
      assertInstallableBetaState({ internalBuildState: "READY_FOR_BETA_TESTING" }, "38"),
    ).not.toThrow();
  });
});

describe("betaStateIsTransient", () => {
  // buildBetaDetail and build.processingState are separate resources on separate
  // backends, so a VALID assigned build can still read PROCESSING here. Re-polling
  // these two is what keeps the allowlist from producing a false red.
  it("treats only the not-yet-decided states as transient", () => {
    expect(betaStateIsTransient({ internalBuildState: "PROCESSING" })).toBe(true);
    expect(
      betaStateIsTransient({
        internalBuildState: "IN_EXPORT_COMPLIANCE_REVIEW",
      }),
    ).toBe(true);
  });

  it("never re-polls a decided state, so a real verdict is never softened", () => {
    expect(betaStateIsTransient({ internalBuildState: "IN_BETA_TESTING" })).toBe(false);
    expect(betaStateIsTransient({ internalBuildState: "MISSING_EXPORT_COMPLIANCE" })).toBe(false);
    expect(betaStateIsTransient({ internalBuildState: "EXPIRED" })).toBe(false);
    // An unreadable state is a real unknown — the request layer already retried
    // it — so it must fail closed rather than spin here.
    expect(betaStateIsTransient(null)).toBe(false);
    expect(betaStateIsTransient({})).toBe(false);
  });

  it("still fails closed on a state that stays transient", () => {
    expect(() => assertInstallableBetaState({ internalBuildState: "PROCESSING" }, "38")).toThrow(
      /not one of the states an internal tester can install/,
    );
  });
});

describe("AscClient credential failures", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("surfaces a token-mint failure immediately instead of retrying it as a transport error", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const mint = vi.fn(() => {
      throw new Error("Missing required env var ASC_ISSUER_ID.");
    });

    const client = new AscClient(mint);
    // Its own message, unwrapped: a missing secret must not be reported as a
    // network problem, and must not burn four attempts with backoff first.
    await expect(client.get("apps")).rejects.toThrow("Missing required env var ASC_ISSUER_ID.");
    expect(mint).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("tags errors with whether they were retryable, so callers never have to guess", async () => {
    // The processing wait tolerates a failed read so a brief Apple outage does not
    // red a good promote. It must tolerate ONLY this class: without the tag, a
    // revoked key would be re-read every 20s for the whole deadline and then
    // reported as "could not be read at all", blaming Apple for our credential.
    const unauthorized = {
      status: 401,
      ok: false,
      text: async () => JSON.stringify({ errors: [{ title: "NOT_AUTHORIZED" }] }),
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(unauthorized));
    await expect(
      new AscClient(() => ({ token: "t", expiresAt: 2 ** 40 })).get("builds"),
    ).rejects.toMatchObject({
      retryable: false,
    });

    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("socket hang up")));
    await expect(
      new AscClient(() => ({ token: "t", expiresAt: 2 ** 40 })).get("builds"),
    ).rejects.toMatchObject({
      retryable: true,
    });
  });

  it("still retries a genuine transport error", async () => {
    const fetchSpy = vi
      .fn()
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        text: async () => JSON.stringify({ data: [] }),
      });
    vi.stubGlobal("fetch", fetchSpy);

    const client = new AscClient(() => ({
      token: "t",
      expiresAt: Math.floor(Date.now() / 1000) + 1200,
    }));
    await expect(client.get("apps")).resolves.toEqual({ data: [] });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  }, 15_000);

  it("always addresses the App Store Connect base, with no absolute-URL escape hatch", async () => {
    // Every request carries a signed ASC bearer token, so a caller-supplied host
    // would be a way to hand that token to somewhere else. There is deliberately
    // no env override for the same reason; this pins that a path that merely
    // LOOKS absolute is still sent to Apple.
    const fetchSpy = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      text: async () => JSON.stringify({ data: [] }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    const client = new AscClient(() => ({ token: "t", expiresAt: 2 ** 40 }));
    await client.get("apps");
    await client.get("/builds?limit=1");
    await client.get("https://attacker.example/v1/apps");

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    for (const [url] of fetchSpy.mock.calls) {
      expect(String(url).startsWith(`${ASC_BASE}/`)).toBe(true);
    }
  });

  it("does not retry a 401", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      status: 401,
      ok: false,
      text: async () => JSON.stringify({ errors: [{ title: "NOT_AUTHORIZED" }] }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    const client = new AscClient(() => ({
      token: "t",
      expiresAt: Math.floor(Date.now() / 1000) + 1200,
    }));
    await expect(client.get("apps")).rejects.toThrow(/HTTP 401/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("timeout budget leaves room to verify", () => {
  // Setting the advertised maximum must not reproduce the opaque mid-verification
  // cancellation that parseTimeoutSeconds exists to prevent. Asserted as the
  // invariant rather than a literal, so tuning a constant either stays safe or
  // fails here.
  it("fits the maximum wait plus the worst-case work outside it inside the step cap, with slack", () => {
    // Computed from the script's OWN constants, never re-typed as literals: a
    // duplicated copy drifts silently and turns this guard into a tautology that
    // only catches someone hard-coding the maximum.
    // The reserve covers the SHORT window only: the long auto-distribution window
    // is clamped to the budget actually left, so it never shortens this wait.
    const confirmRePollSleepSeconds = ((CONFIRM_ATTEMPTS - 1) * CONFIRM_INTERVAL_MS) / 1000;
    const betaStateRePollSleepSeconds = ((BETA_STATE_ATTEMPTS - 1) * BETA_STATE_INTERVAL_MS) / 1000;
    const worstCaseBackoffPerRequestSeconds =
      (((REQUEST_ATTEMPTS * (REQUEST_ATTEMPTS - 1)) / 2) * REQUEST_BACKOFF_STEP_MS) / 1000;

    // Sleeps only. The reserve must ALSO cover the round-trip latency of those
    // requests and node's own startup, neither of which is a sleep — a reserve
    // that lands exactly on the cap reproduces the opaque mid-verification
    // cancellation parseTimeoutSeconds exists to prevent.
    const worstCaseSleepSecondsOutsideWait =
      confirmRePollSleepSeconds +
      betaStateRePollSleepSeconds +
      REQUESTS_OUTSIDE_PROCESSING_WAIT * worstCaseBackoffPerRequestSeconds;

    const slackSeconds =
      STEP_BUDGET_SECONDS - (MAX_PROCESSING_TIMEOUT_SECONDS + worstCaseSleepSecondsOutsideWait);

    expect(MAX_PROCESSING_TIMEOUT_SECONDS + worstCaseSleepSecondsOutsideWait).toBeLessThan(
      STEP_BUDGET_SECONDS,
    );
    // At least a second of real network time per request outside the wait.
    expect(slackSeconds).toBeGreaterThanOrEqual(REQUESTS_OUTSIDE_PROCESSING_WAIT);
    expect(MAX_PROCESSING_TIMEOUT_SECONDS).toBeGreaterThan(0);
  });

  it("never lets the long auto-distribution window shorten the processing wait", () => {
    // Reserving the long window up front cost the processing queue 7+ minutes for
    // a window only reachable AFTER processing already finished. The wait Apple's
    // queue gets must be sized by the short window alone.
    const shortWindowRequests = 2 + 1 + 1 + 2 + CONFIRM_ATTEMPTS + BETA_STATE_ATTEMPTS;
    expect(REQUESTS_OUTSIDE_PROCESSING_WAIT).toBe(shortWindowRequests);
    // Apple's queue regularly sits past 20 minutes; that is the whole point of the wait.
    expect(MAX_PROCESSING_TIMEOUT_SECONDS).toBeGreaterThanOrEqual(23 * 60);
  });

  it("clamps the long confirmation window to the step budget actually left", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const perAttemptMs =
      AUTO_DISTRIBUTION_CONFIRM_INTERVAL_MS +
      ((REQUEST_ATTEMPTS * (REQUEST_ATTEMPTS - 1)) / 2) * REQUEST_BACKOFF_STEP_MS +
      5000;

    // Plenty left → the full ceiling, never more.
    expect(autoDistributionConfirmAttempts(STEP_BUDGET_SECONDS * 1000)).toBe(
      AUTO_DISTRIBUTION_CONFIRM_ATTEMPTS,
    );
    // A processing queue that ate almost everything shrinks the window instead of
    // overrunning the step cap, and falls back to the short one when nothing fits.
    expect(autoDistributionConfirmAttempts(8 * perAttemptMs)).toBeLessThan(
      AUTO_DISTRIBUTION_CONFIRM_ATTEMPTS,
    );
    expect(autoDistributionConfirmAttempts(0)).toBe(0);
    expect(autoDistributionConfirmAttempts(-60_000)).toBe(0);
    expect(confirmationWindow({ autoDistribution: true }, 0)).toEqual({});
    expect(confirmationWindow({ autoDistribution: true }, STEP_BUDGET_SECONDS * 1000)).toEqual({
      attempts: AUTO_DISTRIBUTION_CONFIRM_ATTEMPTS,
      intervalMs: AUTO_DISTRIBUTION_CONFIRM_INTERVAL_MS,
    });
    vi.restoreAllMocks();
  });

  it("keeps the step budget matching the distribute step's own timeout-minutes", () => {
    // The reserve is derived from STEP_BUDGET_SECONDS, so if THIS step's cap ever
    // drops below it every derived bound above is quietly wrong. Anchored to the
    // distribute step's own block: scanning the whole file also sees the job's
    // timeout-minutes, so a step lowered to 20 under an 80 → 30 job would pass.
    const workflow = readRepoFile(".github/workflows/ios-testflight.yml");
    const distributeSteps = workflow
      .split(/^ {6}- /m)
      .slice(1)
      .filter((step) => step.includes("node scripts/ios-testflight-distribute.mjs"));

    expect(distributeSteps).toHaveLength(1);
    const timeout = distributeSteps[0].match(/^ {8}timeout-minutes:\s*(\d+)\s*$/m);
    expect(timeout).not.toBeNull();
    expect(Number(timeout?.[1])).toBe(STEP_BUDGET_SECONDS / 60);
  });

  it("keeps the default within its own validator", () => {
    // A hard-coded default silently became LARGER than the maximum the validator
    // allows the moment the reserve grew, which would have failed every default
    // run on a bad-config error. Both are derived now; this pins that.
    expect(DEFAULT_PROCESSING_TIMEOUT_SECONDS).toBeLessThanOrEqual(MAX_PROCESSING_TIMEOUT_SECONDS);
    expect(() => parseTimeoutSeconds(String(DEFAULT_PROCESSING_TIMEOUT_SECONDS))).not.toThrow();
    expect(parseTimeoutSeconds(undefined)).toBe(DEFAULT_PROCESSING_TIMEOUT_SECONDS);
    // Still long enough to be useful against Apple's queue.
    expect(DEFAULT_PROCESSING_TIMEOUT_SECONDS).toBeGreaterThanOrEqual(15 * 60);
  });

  it("clamps the processing poll sleep to the deadline so the wait cannot overshoot it", () => {
    const script = readRepoFile("scripts/ios-testflight-distribute.mjs");
    expect(script).toContain(
      "await sleep(Math.min(PROCESSING_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));",
    );
  });
});

describe("assignment into an auto-distributing group", () => {
  // Run 38432122653: the internal group distributes automatically, so Apple 422s
  // both assignment POSTs and then adds the build itself after a variable delay
  // (instant for build 266, over 50s for 267). The short window reded a good build.
  const AUTO_422 =
    "POST https://api.appstoreconnect.apple.com/v1/x → HTTP 422: Builds cannot be assigned to this " +
    "internal group. — Cannot add internal group to a build. — ENTITY_UNPROCESSABLE";

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // Mirrors main(): assign, pick the window from the outcome, then confirm.
  const run = async (postError: string, appearsOnRead: number | null) => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    let reads = 0;
    const client = {
      post: vi.fn().mockRejectedValue(new Error(postError)),
      get: vi.fn(async () => {
        reads += 1;
        return {
          data: appearsOnRead !== null && reads >= appearsOnRead ? [{ id: "b1" }] : [],
        };
      }),
    };
    const outcome = await assignBuildToGroup(client, "b1", "g1");
    const confirming = confirmAssignment(client, "b1", "g1", confirmationWindow(outcome));
    await vi.advanceTimersByTimeAsync(
      Math.max(
        CONFIRM_ATTEMPTS * CONFIRM_INTERVAL_MS,
        AUTO_DISTRIBUTION_CONFIRM_ATTEMPTS * AUTO_DISTRIBUTION_CONFIRM_INTERVAL_MS,
      ),
    );
    return { client, outcome, result: await confirming, reads: () => reads };
  };

  it("waits past the old window and succeeds once Apple adds the build", async () => {
    const laterThanOldWindow = CONFIRM_ATTEMPTS + 6;
    expect(laterThanOldWindow).toBeLessThanOrEqual(AUTO_DISTRIBUTION_CONFIRM_ATTEMPTS);
    const { client, outcome, result, reads } = await run(AUTO_422, laterThanOldWindow);

    expect(client.post).toHaveBeenCalledTimes(2);
    expect(outcome?.autoDistribution).toBe(true);
    expect(result).toBe(true);
    expect(reads()).toBe(laterThanOldWindow);
  });

  it("still fails closed when the build never appears", async () => {
    const { result, reads } = await run(AUTO_422, null);

    expect(result).toBe(false);
    expect(reads()).toBe(AUTO_DISTRIBUTION_CONFIRM_ATTEMPTS);
  });

  it("keeps the short window for any other 4xx, or a 422 about something else", async () => {
    const other403 = await run(
      "POST x → HTTP 403: Forbidden — cannot be assigned to this internal group",
      null,
    );
    expect(other403.outcome?.autoDistribution).toBe(false);
    expect(other403.result).toBe(false);
    expect(other403.reads()).toBe(CONFIRM_ATTEMPTS);

    const other422 = await run("POST x → HTTP 422: Invalid relationship — ENTITY_UNPROCESSABLE", null);
    expect(other422.outcome?.autoDistribution).toBe(false);
    expect(other422.reads()).toBe(CONFIRM_ATTEMPTS);
  });

  it("does not widen the window when only one of the two POSTs hit the auto-distribution 422", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const client = {
      post: vi
        .fn()
        .mockRejectedValueOnce(new Error(AUTO_422))
        .mockRejectedValueOnce(new Error("POST x → HTTP 409: already exists")),
    };
    const outcome = await assignBuildToGroup(client, "b1", "g1");
    expect(outcome?.autoDistribution).toBe(false);
    expect(confirmationWindow(outcome)).toEqual({});
  });
});

describe("iOS TestFlight pipeline wiring", () => {
  // A build that uploads but is never assigned to a tester group is invisible to
  // testers while CI stays green — the exact failure these assertions prevent.
  it("runs the distribute step after the fastlane upload and threads the build number", () => {
    const workflow = readRepoFile(".github/workflows/ios-testflight.yml");
    expect(workflow).toContain("node scripts/ios-testflight-distribute.mjs");
    expect(workflow).toContain("TESTFLIGHT_BUILD_NUMBER: ${{ steps.upload.outputs.build_number }}");
    expect(workflow.indexOf("id: upload")).toBeLessThan(
      workflow.indexOf("node scripts/ios-testflight-distribute.mjs"),
    );
  });

  it("keeps the fastlane lane emitting the build number and never distributes externally", () => {
    const fastfile = readRepoFile("ios/App/fastlane/Fastfile");
    expect(fastfile).toContain('File.open(github_output, "a")');
    expect(fastfile).toContain("build_number=#{next_build}");
    expect(fastfile).toContain("distribute_external: false");
  });

  it("declares export compliance in Info.plist so a build is never stuck on it", () => {
    const plist = readRepoFile("ios/App/App/Info.plist");
    expect(plist).toMatch(/<key>ITSAppUsesNonExemptEncryption<\/key>\s*<false\/>/);
  });

  it("pins the canonical app record so the legacy record can never receive a build", () => {
    const script = readRepoFile("scripts/ios-testflight-distribute.mjs");
    expect(script).toContain('DEFAULT_APP_ID = "6795707576"');
    expect(script).toContain('DEFAULT_BUNDLE_ID = "space.proplane.app"');
  });
});
