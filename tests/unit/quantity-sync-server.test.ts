/**
 * Per-door billing, step 3: `src/lib/billing/quantity-sync.server.ts` is the
 * ONE path that changes a door-overage Stripe subscription quantity. These
 * tests are hermetic — `loadManagerDoorCount` is mocked so no real database
 * or Stripe API is ever touched — and pin the contract the brief cares about
 * most: a door change never becomes a tier/plan change, is idempotent, and
 * fails closed when the door count itself cannot be resolved.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { loadManagerDoorCount } = vi.hoisted(() => ({ loadManagerDoorCount: vi.fn() }));

vi.mock("@/lib/billing/door-count.server", () => ({ loadManagerDoorCount }));

import {
  doorOverageLookupKey,
  doorOverageQuantity,
  syncManagerDoorQuantity,
} from "@/lib/billing/quantity-sync.server";

type FakePrice = { id: string; lookup_key: string | null };
type FakeItem = { id: string; quantity?: number; price: FakePrice };

function fakeSub(items: FakeItem[]) {
  return { id: "sub_test", items: { data: items } } as never;
}

const FLOOR_ITEM: FakeItem = { id: "si_floor", quantity: 1, price: { id: "price_pro_monthly", lookup_key: null } };

function fakeStripe(over: Partial<Record<"retrieve" | "update" | "list" | "create" | "productCreate", ReturnType<typeof vi.fn>>> = {}) {
  const retrieve = over.retrieve ?? vi.fn();
  const update = over.update ?? vi.fn().mockResolvedValue({});
  const list = over.list ?? vi.fn().mockResolvedValue({ data: [] });
  const create = over.create ?? vi.fn().mockResolvedValue({ id: "price_door_created" });
  const productCreate = over.productCreate ?? vi.fn().mockResolvedValue({ id: doorOverageLookupKey("pro") });
  return {
    stripe: {
      subscriptions: { retrieve, update },
      prices: { list, create },
      products: { create: productCreate },
    } as never,
    retrieve,
    update,
    list,
    create,
    productCreate,
  };
}

const db = {} as never; // never touched directly — loadManagerDoorCount is mocked

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("doorOverageQuantity", () => {
  it("is 0 under the included allowance (12 doors on Pro, 20 included)", () => {
    expect(doorOverageQuantity("pro", 12)).toBe(0);
  });

  it("is doors above the allowance (25 doors on Pro, 20 included -> 5)", () => {
    expect(doorOverageQuantity("pro", 25)).toBe(5);
  });

  it("recomputes to the new tier's allowance on a tier change (25 doors on Business, 120 included -> 0)", () => {
    expect(doorOverageQuantity("business", 25)).toBe(0);
  });

  it("is always 0 for Free, which has no overage rate (hard cap instead)", () => {
    expect(doorOverageQuantity("free", 999)).toBe(0);
  });
});

describe("syncManagerDoorQuantity", () => {
  it("12 doors on Pro: quantity 0, no existing item, no Stripe call at all — floor only", async () => {
    loadManagerDoorCount.mockResolvedValue({ ok: true, totalDoors: 12, breakdown: [] });
    const { stripe, update } = fakeStripe({ retrieve: vi.fn().mockResolvedValue(fakeSub([FLOOR_ITEM])) });

    const result = await syncManagerDoorQuantity({
      stripe,
      db,
      managerUserId: "mgr-1",
      stripeSubscriptionId: "sub_test",
      tier: "pro",
    });

    expect(result).toEqual({ ok: true, doors: 12, quantity: 0, changed: false });
    expect(update).not.toHaveBeenCalled();
  });

  it("25 doors on Pro: creates the door item at quantity 5, touching ONLY the door line", async () => {
    loadManagerDoorCount.mockResolvedValue({ ok: true, totalDoors: 25, breakdown: [] });
    const { stripe, update, list, create } = fakeStripe({
      retrieve: vi.fn().mockResolvedValue(fakeSub([FLOOR_ITEM])),
      list: vi.fn().mockResolvedValue({ data: [] }),
      create: vi.fn().mockResolvedValue({ id: "price_door_pro_new" }),
    });

    const result = await syncManagerDoorQuantity({
      stripe,
      db,
      managerUserId: "mgr-1",
      stripeSubscriptionId: "sub_test",
      tier: "pro",
    });

    expect(result).toEqual({ ok: true, doors: 25, quantity: 5, changed: true });
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ lookup_keys: [doorOverageLookupKey("pro")] }));
    expect(create).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith("sub_test", {
      items: [{ price: "price_door_pro_new", quantity: 5 }],
      proration_behavior: "create_prorations",
    });
  });

  it("moving Pro -> Business recomputes the allowance: 25 doors -> quantity 0, and the stale Pro door item is removed (not repriced)", async () => {
    loadManagerDoorCount.mockResolvedValue({ ok: true, totalDoors: 25, breakdown: [] });
    const staleProDoorItem: FakeItem = {
      id: "si_door_pro",
      quantity: 5,
      price: { id: "price_door_pro", lookup_key: doorOverageLookupKey("pro") },
    };
    const { stripe, update } = fakeStripe({
      retrieve: vi.fn().mockResolvedValue(fakeSub([FLOOR_ITEM, staleProDoorItem])),
    });

    const result = await syncManagerDoorQuantity({
      stripe,
      db,
      managerUserId: "mgr-1",
      stripeSubscriptionId: "sub_test",
      tier: "business",
    });

    expect(result).toEqual({ ok: true, doors: 25, quantity: 0, changed: true });
    // ONLY the quantity update: exactly one item touched (the stale door
    // item, deleted), no reference anywhere to the floor item's id/price,
    // and no tier/plan/price field alongside it.
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith("sub_test", {
      items: [{ id: "si_door_pro", deleted: true }],
      proration_behavior: "create_prorations",
    });
  });

  it("a door change never sends a tier/price/plan field — only the door item's id/quantity or price/quantity", async () => {
    loadManagerDoorCount.mockResolvedValue({ ok: true, totalDoors: 30, breakdown: [] });
    const existingDoorItem: FakeItem = {
      id: "si_door_pro",
      quantity: 5,
      price: { id: "price_door_pro", lookup_key: doorOverageLookupKey("pro") },
    };
    const { stripe, update } = fakeStripe({ retrieve: vi.fn().mockResolvedValue(fakeSub([FLOOR_ITEM, existingDoorItem])) });

    await syncManagerDoorQuantity({
      stripe,
      db,
      managerUserId: "mgr-1",
      stripeSubscriptionId: "sub_test",
      tier: "pro",
    });

    expect(update).toHaveBeenCalledTimes(1);
    const [, params] = update.mock.calls[0] as [string, Record<string, unknown>];
    expect(Object.keys(params).sort()).toEqual(["items", "proration_behavior"]);
    const items = params.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({ id: "si_door_pro", quantity: 10 });
    // Never the floor item.
    expect(items.some((i) => i.id === FLOOR_ITEM.id || i.price === FLOOR_ITEM.price.id)).toBe(false);
  });

  it("is idempotent: syncing unchanged doors makes NO Stripe call at all, not even a retrieve", async () => {
    loadManagerDoorCount.mockResolvedValue({ ok: true, totalDoors: 25, breakdown: [] });
    const matchingDoorItem: FakeItem = {
      id: "si_door_pro",
      quantity: 5,
      price: { id: "price_door_pro", lookup_key: doorOverageLookupKey("pro") },
    };
    const { stripe, retrieve, update } = fakeStripe();

    const result = await syncManagerDoorQuantity({
      stripe,
      db,
      managerUserId: "mgr-1",
      stripeSubscriptionId: "sub_test",
      tier: "pro",
      // Pre-fetched, exactly like a caller that just did its own price-change
      // update and already has the fresh subscription in hand.
      subscription: fakeSub([FLOOR_ITEM, matchingDoorItem]),
    });

    expect(result).toEqual({ ok: true, doors: 25, quantity: 5, changed: false });
    expect(retrieve).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("fails closed on an unresolvable door count: no Stripe call at all, and a failure result", async () => {
    loadManagerDoorCount.mockResolvedValue({ ok: false, error: "manager_property_records read failed" });
    const { stripe, retrieve, update } = fakeStripe();

    const result = await syncManagerDoorQuantity({
      stripe,
      db,
      managerUserId: "mgr-1",
      stripeSubscriptionId: "sub_test",
      tier: "pro",
    });

    expect(result).toEqual({ ok: false, error: "manager_property_records read failed" });
    expect(retrieve).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});
