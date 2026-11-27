import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  invalidateManagerFactCaches,
  invalidateManagerPlanFacts,
  rememberDedicatedWorkspaceIds,
  rememberManagerPurchaseRow,
} from "@/lib/manager-fact-caches";
import { invalidateManagerTierCache } from "@/lib/manager-tier-sync-cache";

/**
 * Which writes drop which cached manager facts. The dedicated-number set is derived from the plans of the people who
 * own a working number, so only a plan change of one of them can change it; any other account's plan change, and a
 * Stripe event that names no account, must leave it (and the other accounts' rows) in place.
 */
const NUMBER_OWNER = "owner-with-number";
const OTHER = "owner-without-number";

async function primeAll() {
  await rememberDedicatedWorkspaceIds(async () => ({ workspaceIds: ["ws-before"], numberOwnerIds: [NUMBER_OWNER] }));
  await rememberManagerPurchaseRow(NUMBER_OWNER, async () => ({ value: "before", cacheable: true }));
  await rememberManagerPurchaseRow(OTHER, async () => ({ value: "before", cacheable: true }));
}

async function rereadAll() {
  return {
    dedicated: await rememberDedicatedWorkspaceIds(async () => ({ workspaceIds: ["ws-after"], numberOwnerIds: [NUMBER_OWNER] })),
    numberOwner: await rememberManagerPurchaseRow(NUMBER_OWNER, async () => ({ value: "after", cacheable: true })),
    other: await rememberManagerPurchaseRow(OTHER, async () => ({ value: "after", cacheable: true })),
  };
}

beforeEach(() => {
  process.env.MANAGER_FACT_CACHE_IN_TEST = "1";
  invalidateManagerFactCaches();
});
afterEach(() => {
  invalidateManagerFactCaches();
  delete process.env.MANAGER_FACT_CACHE_IN_TEST;
});

describe("manager fact cache invalidation scope", () => {
  it("a plan change of an account with no working number drops only that account's row", async () => {
    await primeAll();
    invalidateManagerPlanFacts(OTHER);
    expect(await rereadAll()).toEqual({ dedicated: ["ws-before"], numberOwner: "before", other: "after" });
  });

  it("a plan change of a number owner drops its row and the dedicated set", async () => {
    await primeAll();
    invalidateManagerPlanFacts(NUMBER_OWNER);
    expect(await rereadAll()).toEqual({ dedicated: ["ws-after"], numberOwner: "after", other: "before" });
  });

  it("a plan change while the dedicated set is still loading keeps that load from being stored", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const loading = rememberDedicatedWorkspaceIds(async () => {
      await gate;
      return { workspaceIds: ["ws-stale"], numberOwnerIds: [NUMBER_OWNER] };
    });
    invalidateManagerPlanFacts(OTHER);
    release();
    expect(await loading).toEqual(["ws-stale"]);
    expect(await rereadAll()).toMatchObject({ dedicated: ["ws-after"] });
  });

  it("a Stripe event that names no account (the reconcile memo reset) keeps every cached fact", async () => {
    await primeAll();
    invalidateManagerTierCache();
    expect(await rereadAll()).toEqual({ dedicated: ["ws-before"], numberOwner: "before", other: "before" });
  });
});
