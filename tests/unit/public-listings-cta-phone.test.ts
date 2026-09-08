/**
 * Catalog-level coverage for listing CTA phone routing: `getPublicListings()`
 * must stamp EACH listing with ITS OWN manager's work number, never a personal
 * cell and never a catalog-wide default.
 *
 * This is the cross-routing guard — a multi-manager fleet must never send a
 * prospect looking at Bob's house to Alice's phone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const queryQueue: Array<{ data: unknown[] | null; error: null }> = [];
function chain(result: { data: unknown[] | null; error: null }) {
  const q: Record<string, unknown> = {};
  const ret = () => q;
  for (const m of ["select", "eq", "in", "order", "limit", "not"]) q[m] = ret;
  q.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(res, rej);
  return q;
}
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: () => chain(queryQueue.shift() ?? { data: [], error: null }),
  }),
}));

import { getPublicListings } from "@/lib/public-listings.server";

const CLAW_LINE = "+12053690702";
const ALICE_CELL = "+14258909021";
const BOB_CELL = "+12064710000";
const ALICE_WORK = "+14258909100";
const BOB_WORK = "+12064710200";

function listingRow(id: string, managerId: string, buildingName: string) {
  return {
    id,
    manager_user_id: managerId,
    property_data: {
      id,
      title: buildingName,
      buildingName,
      address: `${buildingName} St`,
      adminPublishLive: true,
      // A number baked into the stored blob must never win — it is
      // manager-editable and could point at anyone.
      contactSmsPhone: "+19995550000",
    },
  };
}

/** Two managers, each owning one live listing. */
function seedCatalog() {
  queryQueue.push({
    data: [
      listingRow("lst-alice", "mgr-alice", "Alder Row"),
      listingRow("lst-bob", "mgr-bob", "Birch House"),
    ],
    error: null,
  });
  queryQueue.push({
    data: [
      {
        id: "mgr-alice",
        email: "alice@landlord.com",
        phone: ALICE_CELL,
        phone_verified_at: "2026-01-04T00:00:00Z",
        sms_from_number: ALICE_WORK,
      },
      {
        id: "mgr-bob",
        email: "bob@landlord.com",
        phone: BOB_CELL,
        phone_verified_at: "2026-02-11T00:00:00Z",
        sms_from_number: BOB_WORK,
      },
    ],
    error: null,
  });
}

function byBuilding(listings: Awaited<ReturnType<typeof getPublicListings>>) {
  return new Map(listings.map((l) => [l.buildingName, l.contactSmsPhone]));
}

let priorVercelEnv: string | undefined;
let priorClawFlag: string | undefined;

beforeEach(() => {
  queryQueue.length = 0;
  priorVercelEnv = process.env.VERCEL_ENV;
  priorClawFlag = process.env.NEXT_PUBLIC_CLAW_MESSENGER_ENABLED;
  process.env.NEXT_PUBLIC_CLAW_MESSENGER_ENABLED = "1";
});

afterEach(() => {
  if (priorVercelEnv === undefined) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = priorVercelEnv;
  if (priorClawFlag === undefined) delete process.env.NEXT_PUBLIC_CLAW_MESSENGER_ENABLED;
  else process.env.NEXT_PUBLIC_CLAW_MESSENGER_ENABLED = priorClawFlag;
});

describe("getPublicListings — CTA phone per listing", () => {
  it("gives every production listing its OWN manager's work number", async () => {
    process.env.VERCEL_ENV = "production";
    seedCatalog();
    const phones = byBuilding(await getPublicListings());
    expect(phones.get("Alder Row")).toBe(ALICE_WORK);
    expect(phones.get("Birch House")).toBe(BOB_WORK);
  });

  it("keeps each listing on its own manager's work number outside production", async () => {
    process.env.VERCEL_ENV = "preview";
    seedCatalog();
    const phones = byBuilding(await getPublicListings());
    expect(phones.get("Alder Row")).toBe(ALICE_WORK);
    expect(phones.get("Birch House")).toBe(BOB_WORK);
  });

  it("drops the CTA number when the manager has no usable work number", async () => {
    process.env.VERCEL_ENV = "production";
    queryQueue.push({ data: [listingRow("lst-alice", "mgr-alice", "Alder Row")], error: null });
    queryQueue.push({
      data: [
        {
          id: "mgr-alice",
          email: "alice@landlord.com",
          phone: ALICE_CELL,
          phone_verified_at: "2026-01-04T00:00:00Z",
          // Shared Claw stamp — not a real per-manager work number.
          sms_from_number: CLAW_LINE,
        },
      ],
      error: null,
    });
    const [listing] = await getPublicListings();
    // Not the personal cell, not the stored blob, not the shared line —
    // nothing, so the CTA falls back to "Schedule a tour" / "Apply".
    expect(listing.contactSmsPhone).toBeUndefined();
  });
});
