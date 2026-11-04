import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PRP-254 #2 — a vendor can decline an offer.
 *
 * The offer status allowed only `sent` and `withdrawn`, and `withdrawn` is the MANAGER pulling
 * the offer back. So a vendor who was booked, or did not cover that trade, had no way to say
 * no: the offer sat in their list indefinitely while the manager waited for a reply the
 * product gave no way to send, unable to tell "not interested" from "hasn't looked yet".
 */

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  user: null as { id: string } | null,
  role: "vendor",
  admin: false,
  offers: [] as Row[],
  directory: [] as Row[],
  workOrders: [] as Row[],
  recipients: ["mgr-1"] as string[],
  notifications: [] as Row[],
  rpcResult: true as boolean,
  rpcError: null as string | null,
}));

function table(rows: Row[], onUpdate?: (row: Row, patch: Row) => void) {
  const filters: [string, unknown][] = [];
  let patch: Row | null = null;
  let mode: "select" | "update" = "select";
  const matched = () => rows.filter((r) => filters.every(([c, v]) => r[c] === v));
  const api = {
    select: () => api,
    update: (vals: Row) => {
      mode = "update";
      patch = vals;
      return api;
    },
    eq: (c: string, v: unknown) => {
      filters.push([c, v]);
      return api;
    },
    maybeSingle: async () => {
      const hit = matched()[0] ?? null;
      if (mode === "update" && hit && patch) {
        Object.assign(hit, patch);
        onUpdate?.(hit, patch);
      }
      return { data: hit ? { ...hit } : null, error: null };
    },
    then: (resolve: (v: { data: Row[]; error: null }) => unknown) => resolve({ data: matched(), error: null }),
  };
  return api;
}

const db = {
  rpc: vi.fn(async (name: string, args: Row) => {
    if (name !== "decline_vendor_service_quote") throw new Error(`Unexpected RPC: ${name}`);
    if (state.rpcError) return { data: null, error: { message: state.rpcError } };
    if (!state.rpcResult) return { data: false, error: null };
    const directory = state.directory.find((d) => d.id === args.p_vendor_directory_id && d.manager_user_id === args.p_manager_user_id);
    const work = state.workOrders.find((w) => w.id === args.p_work_order_id && w.manager_user_id === args.p_manager_user_id);
    if (!work || !directory || (args.p_actor_user_id !== args.p_manager_user_id && args.p_actor_user_id !== directory.vendor_user_id)) return { data: null, error: { message: "vendor identity unverified" } };
    const offer = state.offers.find((o) => o.work_order_id === args.p_work_order_id && o.manager_user_id === args.p_manager_user_id && o.vendor_directory_id === args.p_vendor_directory_id);
    if (!offer || offer.status !== "sent") return { data: false, error: null };
    Object.assign(offer, { status: "declined", declined_reason: args.p_reason, declined_at: new Date().toISOString(), declined_source_message_id: args.p_source_message_id });
    return { data: true, error: null };
  }),
  from: (name: string) => {
    if (name === "work_order_vendor_offers") return table(state.offers);
    if (name === "manager_vendor_records") return table(state.directory);
    return table(state.workOrders);
  },
};

vi.mock("@/lib/co-manager-notification-recipients.server", () => ({
  resolvePropertyScopedManagerRecipientIds: async () => state.recipients,
}));

vi.mock("@/lib/work-order-notification.server", () => ({
  notifyWorkOrderEvent: async (_db: unknown, input: Row) => {
    state.notifications.push(input);
  },
}));

vi.mock("@/lib/vendor-notification-delivery", () => ({ sendVendorNotification: async () => {} }));
vi.mock("@/lib/vendor-visit-email", () => ({ buildVendorBidOfferEmail: () => ({ subject: "", html: "" }) }));

const VENDOR = "vendor-1";
const OTHER = "vendor-2";

async function decline(body: Row, actorOver: Row = {}) {
  const { declineWorkOrderVendorOffer } = await import("@/lib/work-order-offers.server");
  return declineWorkOrderVendorOffer(
    db as never,
    { userId: VENDOR, role: state.role, admin: state.admin, fullName: "Vic Vendor", email: "v@x.test", ...actorOver },
    body,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  state.rpcResult = true;
  state.rpcError = null;
  state.role = "vendor";
  state.admin = false;
  state.recipients = ["mgr-1"];
  state.notifications = [];
  state.directory = [{ id: "dir-1", manager_user_id: "mgr-1", vendor_user_id: VENDOR }];
  state.workOrders = [{ id: "wo-1", manager_user_id: "mgr-1", row_data: { title: "Leaking tap", propertyLabel: "12 Elm" } }];
  state.offers = [
    {
      id: "offer-1",
      work_order_id: "wo-1",
      vendor_directory_id: "dir-1",
      vendor_user_id: VENDOR,
      manager_user_id: "mgr-1",
      status: "sent",
      declined_reason: null,
      declined_at: null,
    },
  ];
});

describe("vendor declines a work-order offer", () => {
  it("records the decline with the reason", async () => {
    const res = await decline({ offerId: "offer-1", reason: "Booked until March" });

    expect(res.ok).toBe(true);
    expect(state.offers[0]?.status).toBe("declined");
    expect(state.offers[0]?.declined_reason).toBe("Booked until March");
    expect(state.offers[0]?.declined_at).toBeTruthy();
    expect(db.rpc).toHaveBeenCalledWith("decline_vendor_service_quote", {
      p_work_order_id: "wo-1", p_manager_user_id: "mgr-1", p_vendor_directory_id: "dir-1",
      p_actor_user_id: VENDOR, p_verified_phone_e164: null, p_reason: "Booked until March",
      p_source_message_id: "portal-offer-decline:offer-1",
    });
  });

  it("returns a conflict without notifying when the atomic RPC reports a changed offer", async () => {
    state.rpcResult = false;
    expect(await decline({ offerId: "offer-1" })).toMatchObject({ ok: false, status: 409 });
    expect(state.offers[0]?.status).toBe("sent"); expect(state.notifications).toEqual([]);
  });

  it("keeps state and notifications unchanged when the RPC refuses identity or commitment", async () => {
    state.rpcError = "approved commitment requires manager cancellation";
    expect(await decline({ offerId: "offer-1" })).toMatchObject({ ok: false, status: 500, error: state.rpcError });
    expect(state.offers[0]?.status).toBe("sent"); expect(state.notifications).toEqual([]);
  });

  it("tells the manager, so they can send the job elsewhere", async () => {
    await decline({ offerId: "offer-1", reason: "Not my trade" });

    expect(state.notifications).toHaveLength(1);
    expect(state.notifications[0]?.event).toBe("vendor_declined");
    expect(String(state.notifications[0]?.text)).toContain("Not my trade");
  });

  it("accepts a decline with no reason", async () => {
    const res = await decline({ offerId: "offer-1" });

    expect(res.ok).toBe(true);
    expect(state.offers[0]?.declined_reason).toBeNull();
  });

  it("recognises an offer addressed to the vendor's directory row before they claimed an account", async () => {
    state.offers[0]!.vendor_user_id = null;

    expect((await decline({ offerId: "offer-1" })).ok).toBe(true);
  });

  it("reads another vendor's offer as missing, never forbidden", async () => {
    state.directory = [{ id: "dir-1", vendor_user_id: OTHER }];
    state.offers[0]!.vendor_user_id = OTHER;

    const res = await decline({ offerId: "offer-1" });

    expect(res).toMatchObject({ ok: false, status: 404 });
    expect(state.offers[0]?.status).toBe("sent");
  });

  it("refuses to decline an offer the manager already withdrew", async () => {
    state.offers[0]!.status = "withdrawn";

    expect(await decline({ offerId: "offer-1" })).toMatchObject({ ok: false, status: 409 });
  });

  it("refuses to decline the same offer twice", async () => {
    await decline({ offerId: "offer-1" });
    state.notifications = [];

    expect(await decline({ offerId: "offer-1" })).toMatchObject({ ok: false, status: 409 });
    expect(state.notifications).toHaveLength(0);
  });

  it("refuses a non-vendor caller", async () => {
    state.role = "manager";

    expect(await decline({ offerId: "offer-1" })).toMatchObject({ ok: false, status: 403 });
  });

  it("requires an offer id", async () => {
    expect(await decline({})).toMatchObject({ ok: false, status: 400 });
  });

  it("keeps the decline even when the manager cannot be notified", async () => {
    state.recipients = [];

    expect((await decline({ offerId: "offer-1" })).ok).toBe(true);
    expect(state.offers[0]?.status).toBe("declined");
    expect(state.notifications).toHaveLength(0);
  });
});
