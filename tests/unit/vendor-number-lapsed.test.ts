// PropLane Number, vendor side: a lapsed subscription pauses the number (managers' texts fall back to the
// vendor's own phone), the number is released after 30 days lapsed, a paying vendor's idle number is kept,
// and deleting the account cancels the Stripe subscription before its row is purged.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createFakeDb, type Row } from "../helpers/fake-table-db";

vi.mock("@/lib/twilio-provisioning", () => ({ releaseTwilioNumber: vi.fn() }));
vi.mock("@/lib/twilio-client.server", () => ({ createTwilioRestClient: () => null }));

import { getRoutableVendorNumber, responseFor } from "@/lib/vendor-work-identity.server";
import { providerDestinationFor } from "@/lib/sms/owner-sms-dispatcher.server";
import { releaseIdleVendorWorkNumbers, releaseLapsedVendorWorkNumbers } from "@/lib/vendor-work-identity-release.server";
import { cancelNumberSubscriptionForAccount } from "@/lib/number-subscription/cancel.server";

const NOW = new Date("2026-10-08T18:00:00Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

const identity = (vendor: string, extra: Row = {}): Row => ({
  id: `identity-${vendor}`, vendor_user_id: vendor, phone_number: "+14255550177", phone_number_sid: `PN-${vendor}`, messaging_service_sid: "MG1",
  sms_state: "ready", attachment_state: "attached", sms_send_ready: true, sms_receive_ready: true, email_state: "ready", updated_at: ago(1), ...extra,
});
const subscription = (vendor: string, status: string, updatedDaysAgo: number, extra: Row = {}): Row => ({
  owner_user_id: vendor, owner_role: "vendor", status, updated_at: ago(updatedDaysAgo), stripe_customer_id: "cus_1", stripe_subscription_id: `sub_${vendor}`, ...extra,
});
const asDb = (db: unknown) => db as SupabaseClient;

beforeEach(() => vi.stubEnv("NUMBER_SUBSCRIPTION_ENABLED", "1"));
afterEach(() => vi.unstubAllEnvs());

describe("a lapsed subscription pauses the number", () => {
  const row = { counterparty_role: "vendor", purpose: "vendor_conversation", recipient_user_id: "vendor-1", recipient_phone: "+12065550142" } as never;

  it("managers' texts go to the vendor's own phone while lapsed, and to the number while entitled", async () => {
    const lapsed = createFakeDb({ vendor_work_identities: [identity("vendor-1")], number_subscriptions: [subscription("vendor-1", "canceled", 3)] });
    expect(await providerDestinationFor(asDb(lapsed), row)).toBe("+12065550142");
    const incomplete = createFakeDb({ vendor_work_identities: [identity("vendor-1")], number_subscriptions: [subscription("vendor-1", "incomplete", 3)] });
    expect(await providerDestinationFor(asDb(incomplete), row)).toBe("+12065550142");
    const active = createFakeDb({ vendor_work_identities: [identity("vendor-1")], number_subscriptions: [subscription("vendor-1", "active", 3)] });
    expect(await providerDestinationFor(asDb(active), row)).toBe("+14255550177");
    const pastDue = createFakeDb({ vendor_work_identities: [identity("vendor-1")], number_subscriptions: [subscription("vendor-1", "past_due", 3)] });
    expect(await providerDestinationFor(asDb(pastDue), row)).toBe("+14255550177");
  });

  it("getRoutableVendorNumber: null when lapsed or never subscribed, the number when entitled", async () => {
    const make = (subs: Row[]) => asDb(createFakeDb({ vendor_work_identities: [identity("vendor-1")], number_subscriptions: subs }));
    expect(await getRoutableVendorNumber(make([subscription("vendor-1", "canceled", 3)]), "vendor-1")).toBeNull();
    expect(await getRoutableVendorNumber(make([]), "vendor-1")).toBeNull();
    expect((await getRoutableVendorNumber(make([subscription("vendor-1", "active", 3)]), "vendor-1"))?.phoneNumber).toBe("+14255550177");
  });

  it("flag off: the number routes exactly as it always did, subscription or not", async () => {
    vi.stubEnv("NUMBER_SUBSCRIPTION_ENABLED", "");
    const db = asDb(createFakeDb({ vendor_work_identities: [identity("vendor-1")], number_subscriptions: [] }));
    expect((await getRoutableVendorNumber(db, "vendor-1"))?.phoneNumber).toBe("+14255550177");
  });

  it("the work-identity response shows the number paused: not send-ready, blocked as subscription_required", () => {
    const base = {
      identity: {
        id: "i", vendor_user_id: "vendor-1", lifecycle_state: "ready", email_state: "ready", sms_state: "ready", email_address: null, email_provider_id: null,
        email_send_ready: false, email_receive_ready: false, phone_number: "+14255550177", phone_number_sid: "PN1", messaging_service_sid: "MG1", carrier_ready: true,
        sms_send_ready: true, sms_receive_ready: true, attachment_state: "attached", quarantined_at: null, released_at: null,
      },
      runtime: { enabled: true, max_active_identities: 10, outbound_message_cap: 1000 },
      emailConfigured: false, smsConfigured: true, outboundUsed: 0, phoneVerified: true,
    } as never;
    const paused = responseFor({ ...(base as object), numberBilling: { entitled: false } } as never);
    expect(paused.sms.sendReady).toBe(false);
    expect(paused.sms.receiveReady).toBe(true);
    expect(paused.sms.blockedReason).toBe("subscription_required");
    const live = responseFor({ ...(base as object), numberBilling: { entitled: true } } as never);
    expect(live.sms.sendReady).toBe(true);
    expect(live.sms.blockedReason).toBe("none");
    const free = responseFor(base);
    expect(free.sms.sendReady).toBe(true);
  });

  it("an unsubscribed vendor with no number cannot start a claim (canSetup false)", () => {
    const view = responseFor({
      identity: null, runtime: { enabled: true, max_active_identities: 10, outbound_message_cap: 1000 },
      emailConfigured: false, smsConfigured: true, outboundUsed: 0, phoneVerified: true, numberBilling: { entitled: false },
    } as never);
    expect(view.sms.canSetup).toBe(false);
    expect(view.sms.blockedReason).toBe("subscription_required");
  });
});

describe("releaseLapsedVendorWorkNumbers", () => {
  const run = (db: ReturnType<typeof createFakeDb>, release = vi.fn().mockResolvedValue(true)) =>
    releaseLapsedVendorWorkNumbers(asDb(db), { now: NOW, release }).then((result) => ({ result, release }));

  it("releases the number of a vendor lapsed more than 30 days, and only that one", async () => {
    const db = createFakeDb({
      vendor_work_identities: [identity("v-old"), identity("v-recent"), identity("v-active")],
      number_subscriptions: [subscription("v-old", "canceled", 31), subscription("v-recent", "canceled", 5), subscription("v-active", "active", 90)],
    });
    const { result, release } = await run(db);
    expect(result).toEqual({ released: 1, failed: 0, kept: 0 });
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith("PN-v-old");
    const old = db.tables.vendor_work_identities!.find((r) => r.vendor_user_id === "v-old")!;
    expect(old).toMatchObject({ phone_number: null, phone_number_sid: null, sms_state: "not_started" });
    expect(db.tables.vendor_work_identities!.find((r) => r.vendor_user_id === "v-recent")).toMatchObject({ sms_state: "ready" });
    expect(db.tables.vendor_work_identities!.find((r) => r.vendor_user_id === "v-active")).toMatchObject({ sms_state: "ready" });
  });

  it("an incomplete subscription lapses the same way", async () => {
    const db = createFakeDb({ vendor_work_identities: [identity("v-1")], number_subscriptions: [subscription("v-1", "incomplete", 40)] });
    expect((await run(db)).result.released).toBe(1);
  });

  it("never touches a resident subscription, a vendor with no subscription row, or an unconfirmed remove", async () => {
    const db = createFakeDb({
      vendor_work_identities: [identity("v-res"), identity("v-free"), identity("v-stuck")],
      number_subscriptions: [subscription("v-res", "canceled", 90, { owner_role: "resident" }), subscription("v-stuck", "canceled", 90)],
    });
    const { result, release } = await run(db, vi.fn().mockResolvedValue(false));
    expect(result).toEqual({ released: 0, failed: 1, kept: 0 });
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith("PN-v-stuck");
    // An unconfirmed remove parks the row for reconciliation: never re-bought, never freed.
    expect(db.tables.vendor_work_identities!.find((r) => r.vendor_user_id === "v-stuck")).toMatchObject({ sms_state: "reconciling", quarantine_reason: "lapsed_release_unconfirmed" });
    expect(db.tables.vendor_work_identities!.find((r) => r.vendor_user_id === "v-free")).toMatchObject({ sms_state: "ready" });
  });

  it("flag off: releases nothing", async () => {
    vi.stubEnv("NUMBER_SUBSCRIPTION_ENABLED", "");
    const db = createFakeDb({ vendor_work_identities: [identity("v-old")], number_subscriptions: [subscription("v-old", "canceled", 90)] });
    const { result, release } = await run(db);
    expect(result).toEqual({ released: 0, failed: 0, kept: 0 });
    expect(release).not.toHaveBeenCalled();
  });

  it("a paying vendor's quiet number is not released by the 60-day idle rule; a non-paying one still is", async () => {
    const db = createFakeDb({
      vendor_work_identities: [identity("v-paying", { updated_at: ago(70) }), identity("v-free", { updated_at: ago(70) })],
      vendor_work_identity_usage_events: [],
      vendor_work_number_conversations: [],
      number_subscriptions: [subscription("v-paying", "active", 70)],
    });
    const release = vi.fn().mockResolvedValue(true);
    const result = await releaseIdleVendorWorkNumbers(asDb(db), { now: NOW, release });
    expect(result).toEqual({ released: 1, failed: 0, active: 1 });
    expect(release).toHaveBeenCalledWith("PN-v-free");
  });
});

describe("deleting an account cancels the number subscription", () => {
  const fakeStripe = (cancel: ReturnType<typeof vi.fn>, retrieve = vi.fn()) => ({ subscriptions: { cancel, retrieve } }) as never;

  it("cancels the Stripe subscription named by the user's own row", async () => {
    const cancel = vi.fn().mockResolvedValue({});
    const db = createFakeDb({ number_subscriptions: [subscription("vendor-1", "active", 3), subscription("vendor-2", "active", 3)] });
    expect(await cancelNumberSubscriptionForAccount(asDb(db), "vendor-1", { stripe: fakeStripe(cancel) })).toBe("canceled");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith("sub_vendor-1");
  });

  it("is a no-op for a user with no subscription", async () => {
    const cancel = vi.fn();
    const db = createFakeDb({ number_subscriptions: [] });
    expect(await cancelNumberSubscriptionForAccount(asDb(db), "vendor-1", { stripe: fakeStripe(cancel) })).toBe("none");
    expect(cancel).not.toHaveBeenCalled();
  });

  it("a subscription already gone at Stripe, or already canceled, counts as cancelled", async () => {
    const db = createFakeDb({ number_subscriptions: [subscription("vendor-1", "active", 3)] });
    const missing = vi.fn().mockRejectedValue(Object.assign(new Error("No such subscription"), { code: "resource_missing" }));
    expect(await cancelNumberSubscriptionForAccount(asDb(db), "vendor-1", { stripe: fakeStripe(missing) })).toBe("canceled");
    const already = vi.fn().mockRejectedValue(new Error("canceled subscription can only update cancellation details"));
    const retrieve = vi.fn().mockResolvedValue({ status: "canceled" });
    expect(await cancelNumberSubscriptionForAccount(asDb(db), "vendor-1", { stripe: fakeStripe(already, retrieve) })).toBe("canceled");
  });

  it("any other Stripe failure THROWS, so the delete aborts and can be retried", async () => {
    const db = createFakeDb({ number_subscriptions: [subscription("vendor-1", "active", 3)] });
    const cancel = vi.fn().mockRejectedValue(new Error("stripe unavailable"));
    const retrieve = vi.fn().mockResolvedValue({ status: "active" });
    await expect(cancelNumberSubscriptionForAccount(asDb(db), "vendor-1", { stripe: fakeStripe(cancel, retrieve) })).rejects.toThrow("stripe unavailable");
  });

  it("an unreadable subscription row aborts the delete; a missing table does not", async () => {
    const failing = (code: string) => ({
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { code, message: "x" } }) }) }) }),
    });
    await expect(cancelNumberSubscriptionForAccount(failing("XX000") as never, "vendor-1", { stripe: fakeStripe(vi.fn()) })).rejects.toThrow();
    expect(await cancelNumberSubscriptionForAccount(failing("42P01") as never, "vendor-1", { stripe: fakeStripe(vi.fn()) })).toBe("none");
  });

  it("a role filter leaves the other role's subscription alone", async () => {
    const cancel = vi.fn();
    const db = createFakeDb({ number_subscriptions: [subscription("user-1", "active", 3, { owner_role: "resident" })] });
    expect(await cancelNumberSubscriptionForAccount(asDb(db), "user-1", { role: "vendor", stripe: fakeStripe(cancel) })).toBe("none");
    expect(cancel).not.toHaveBeenCalled();
  });
});
