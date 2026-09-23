// @vitest-environment jsdom
/**
 * When the server refuses a publish, the manager has to be told WHY.
 *
 * The publish path used to collapse every non-ok response into `false`, and the
 * wizard turned that into "Could not submit listing." — which reads as a broken
 * button, not a plan limit with a way past it. `POST /api/property-records` now
 * answers the plan property-limit refusal with a sentence naming the limit and
 * the plans that lift it, so that sentence has to survive the trip back.
 *
 * The second half is the data rule: the local listing catalog is appended only
 * once the SERVER accepted the write, so a refused publish can never leave a
 * listing that exists in this browser and nowhere else.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import {
  mirrorLocalPropertyPipelineToServer,
  publishManagerListingSubmissionToServer,
  readExtraListingsForUser,
  submitManagerPendingPropertyToServer,
} from "@/lib/demo-property-pipeline";
import { FREE_MAX_PROPERTIES, managerPropertyLimitMessage } from "@/lib/manager-access";
import { RATE_CARD } from "@/lib/billing/rate-card";

const LIMIT_MESSAGE = managerPropertyLimitMessage("free");

/** What the route answers next; `null` = accept the write. */
let refusal: { status: number; body: unknown } | null = null;

function mockFetch() {
  return vi.fn(async (url: unknown) => {
    if (String(url).includes("/api/property-records") && refusal) {
      return {
        ok: false,
        status: refusal.status,
        json: async () => refusal!.body,
      } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => ({ snapshot: null }) } as unknown as Response;
  });
}

function submission(buildingName: string) {
  return {
    ...createDefaultListingSubmission(),
    buildingName,
    address: "5200 Ravenna Ave NE",
    zip: "98105",
  };
}

let seq = 0;
const nextManager = () => `mgr-publish-limit-${(seq += 1)}`;

beforeEach(() => {
  window.history.replaceState(null, "", "/portal/properties");
  window.localStorage.clear();
  window.sessionStorage.clear();
  refusal = null;
  vi.stubGlobal("fetch", mockFetch());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a publish refused by the plan property limit", () => {
  beforeEach(() => {
    refusal = {
      status: 403,
      body: {
        error: LIMIT_MESSAGE,
        code: "property_limit_reached",
        tier: "free",
        limit: FREE_MAX_PROPERTIES,
      },
    };
  });

  it("hands the server's own explanation to the caller", async () => {
    const manager = nextManager();
    const seen: string[] = [];

    const ok = await publishManagerListingSubmissionToServer(
      "mgr-second-listing",
      submission("Second House"),
      manager,
      { onError: (m) => seen.push(m) },
    );

    expect(ok).toBe(false);
    expect(seen).toEqual([LIMIT_MESSAGE]);
    // The sentence a manager actually reads: the door count, and the way past it.
    expect(seen[0]).toContain(`Free includes ${RATE_CARD.free.includedDoors} doors`);
    expect(seen[0]).toContain("Upgrade to Pro or Business");
  });

  it("does not leave the refused listing in the local catalog", async () => {
    const manager = nextManager();

    await publishManagerListingSubmissionToServer("mgr-refused", submission("Refused House"), manager, {
      onError: () => {},
    });

    expect(readExtraListingsForUser(manager)).toEqual([]);
  });

  it("carries the explanation through the brand-new-listing wizard path too", async () => {
    const manager = nextManager();
    const seen: string[] = [];

    const id = await submitManagerPendingPropertyToServer(submission("Wizard House"), manager, {
      onError: (m) => seen.push(m),
    });

    expect(id).toBeNull();
    expect(seen).toEqual([LIMIT_MESSAGE]);
  });
});

describe("other failures", () => {
  it("reports nothing to explain when the server sends no message", async () => {
    // The caller falls back to its own generic copy rather than an empty toast.
    refusal = { status: 500, body: {} };
    const seen: string[] = [];

    const ok = await publishManagerListingSubmissionToServer(
      "mgr-x",
      submission("Broken House"),
      nextManager(),
      { onError: (m) => seen.push(m) },
    );

    expect(ok).toBe(false);
    expect(seen).toEqual([]);
  });

  it("still publishes normally when the server accepts", async () => {
    const manager = nextManager();

    const ok = await publishManagerListingSubmissionToServer(
      "mgr-first-listing",
      submission("First House"),
      manager,
      { onError: () => expect.unreachable("an accepted publish must not report an error") },
    );

    expect(ok).toBe(true);
    expect(readExtraListingsForUser(manager).map((p) => p.id)).toEqual(["mgr-first-listing"]);
  });
});

/**
 * Regression: mirror-parallel-upserts-race-and-swallow-403.
 *
 * `mirrorLocalPropertyPipelineToServer` used to fire every locally known row as
 * a concurrent `fetch` and ignore every response. Both halves broke the cap:
 * N simultaneous creates each read the slot count before any of them wrote, so
 * a one-listing plan accepted all N; and a genuine refusal was dropped on the
 * floor, leaving a listing that existed in this browser and nowhere else with
 * no explanation.
 */
describe("mirroring locally held rows back to the server", () => {
  let inFlight = 0;
  let maxConcurrent = 0;
  let upsertedIds: string[] = [];

  /** Records concurrency and order; answers `failFor` ids with that failure. */
  function mirrorFetch(failFor: (id: string) => { status: number; body: unknown } | null) {
    return vi.fn(async (url: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { action?: string; id?: string };
      if (!String(url).includes("/api/property-records") || body.action !== "upsert") {
        return { ok: true, status: 200, json: async () => ({ snapshot: null }) } as unknown as Response;
      }
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      upsertedIds.push(String(body.id));
      await new Promise((resolve) => setTimeout(resolve, 0));
      inFlight -= 1;
      const failure = failFor(String(body.id));
      return failure
        ? ({ ok: false, status: failure.status, json: async () => failure.body } as unknown as Response)
        : ({ ok: true, status: 200, json: async () => ({}) } as unknown as Response);
    });
  }

  const planRefusal = { status: 403, body: { error: LIMIT_MESSAGE, code: "property_limit_reached" } };

  async function seedTwoLocalListings(manager: string) {
    vi.stubGlobal("fetch", mockFetch());
    await publishManagerListingSubmissionToServer("mgr-local-a", submission("Local A"), manager, {});
    await publishManagerListingSubmissionToServer("mgr-local-b", submission("Local B"), manager, {});
  }

  beforeEach(() => {
    inFlight = 0;
    maxConcurrent = 0;
    upsertedIds = [];
  });

  it("sends the writes one at a time so the cap cannot be raced", async () => {
    const manager = nextManager();
    await seedTwoLocalListings(manager);
    vi.stubGlobal("fetch", mirrorFetch(() => null));

    await mirrorLocalPropertyPipelineToServer(manager);

    expect(upsertedIds).toEqual(["mgr-local-a", "mgr-local-b"]);
    expect(maxConcurrent).toBe(1);
  });

  it("reports a plan refusal once, not once per row", async () => {
    const manager = nextManager();
    await seedTwoLocalListings(manager);
    vi.stubGlobal("fetch", mirrorFetch(() => planRefusal));
    const seen: string[] = [];

    await mirrorLocalPropertyPipelineToServer(manager, undefined, { onError: (m) => seen.push(m) });

    expect(upsertedIds).toHaveLength(2);
    expect(seen).toEqual([LIMIT_MESSAGE]);
  });

  it("stays silent when every row the server already has is re-mirrored", async () => {
    const manager = nextManager();
    await seedTwoLocalListings(manager);
    vi.stubGlobal("fetch", mirrorFetch(() => null));

    await mirrorLocalPropertyPipelineToServer(manager, undefined, {
      onError: () => expect.unreachable("an accepted mirror must not report an error"),
    });

    expect(upsertedIds).toHaveLength(2);
  });

  /**
   * Regression: mirror-surfaces-any-server-error-text. This runs on page load
   * from work the manager never asked for, so anything that is not the plan
   * refusal it was built for must stay silent — the route answers 500 with raw
   * Postgres text and with "Could not read this account's plan."
   */
  it("never toasts a server error it was not built to explain", async () => {
    const manager = nextManager();
    await seedTwoLocalListings(manager);
    vi.stubGlobal(
      "fetch",
      mirrorFetch(() => ({
        status: 500,
        body: { error: 'null value in column "id" violates not-null constraint' },
      })),
    );

    await mirrorLocalPropertyPipelineToServer(manager, undefined, {
      onError: () => expect.unreachable("a background mirror must not surface internal error text"),
    });

    expect(upsertedIds).toHaveLength(2);
  });

  it("stays silent on a plan the server could not read", async () => {
    const manager = nextManager();
    await seedTwoLocalListings(manager);
    vi.stubGlobal(
      "fetch",
      mirrorFetch(() => ({ status: 500, body: { error: "Could not read this account's plan." } })),
    );

    await mirrorLocalPropertyPipelineToServer(manager, undefined, {
      onError: () => expect.unreachable("a fail-closed 500 is not a plan refusal"),
    });

    expect(upsertedIds).toHaveLength(2);
  });
});
