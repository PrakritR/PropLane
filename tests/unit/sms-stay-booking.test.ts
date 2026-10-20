import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const emitActionEvent = vi.fn(async (..._args: unknown[]) => ({}));
vi.mock("@/lib/action-events.server", () => ({ emitActionEvent: (...args: unknown[]) => emitActionEvent(...args) }));
const enqueueOwnerSms = vi.fn(async (..._args: unknown[]) => ({ ok: true }));
vi.mock("@/lib/sms/owner-sms-dispatcher.server", () => ({ enqueueOwnerSms: (...args: unknown[]) => enqueueOwnerSms(...args) }));
const postResendEmail = vi.fn(async (..._args: unknown[]) => new Response("{}", { status: 200 }));
vi.mock("@/lib/resend-delivery.server", () => ({ postResendEmail: (...args: unknown[]) => postResendEmail(...args) }));
vi.mock("@/lib/manager-outbound-identity.server", () => ({ managerOutboundFromHeader: async () => "PropLane <work@proplane.test>" }));
const availability = vi.fn();
vi.mock("@/lib/room-availability-range.server", () => ({ roomAvailabilityForRange: (...args: unknown[]) => availability(...args) }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: async () => ({ ok: true }) }));
const chargeWrites: Array<Record<string, unknown>> = [];
let chargeDb: { tables: Record<string, Array<Record<string, unknown>>> } | null = null;
vi.mock("@/lib/household-charges.server", () => ({
  upsertManagerCharges: async (_db: unknown, _owner: string, charges: Array<Record<string, unknown>>) => {
    for (const charge of charges) {
      chargeWrites.push(charge);
      chargeDb?.tables.portal_household_charge_records!.push({ id: charge.id, status: charge.status, row_data: charge });
    }
  },
}));
const ensureGuestLogin = vi.fn();
vi.mock("@/lib/short-stay/guest-login.server", async () => {
  const actual = await vi.importActual<typeof import("@/lib/short-stay/guest-login.server")>("@/lib/short-stay/guest-login.server");
  return { ...actual, ensureGuestLogin: (...args: unknown[]) => ensureGuestLogin(...args) };
});
const mintPhoneBoundLink = vi.fn(async (_db: unknown, input: Record<string, unknown>) => ({
  url: `https://proplane.ai/l/TOKEN-${String(input.targetId).slice(0, 12)}`,
  linkId: "link-1",
  token: "TOKEN",
  expiresAt: null,
}));
vi.mock("@/lib/one-number/links.server", async () => {
  const actual = await vi.importActual<typeof import("@/lib/one-number/links.server")>("@/lib/one-number/links.server");
  return { ...actual, mintPhoneBoundLink: (db: unknown, input: Record<string, unknown>) => mintPhoneBoundLink(db, input) };
});
vi.mock("@/lib/tools/domains/leasing-sms", () => ({
  publicOrigin: () => "https://proplane.ai",
  loadShortStayHomes: async () => ({ homes: [{ id: "prop-1", name: "Cedar Court", area: { distanceMiles: 0.4 } }] }),
  resolveLiveListingForSms: async () => null,
}));
vi.mock("@/lib/sms/conversation-houses.server", () => ({ tagProspectThreadFromAgent: async () => undefined }));

import { decideShortStayHold } from "@/lib/short-stay/hold-decisions.server";
import { bookStayForTexter } from "@/lib/short-stay/sms-stay-book.server";
import { mintStayPayLink } from "@/lib/short-stay/stay-pay-link.server";
import { guestStayChargeId } from "@/lib/short-stay/stay-charge.server";
import { prepareShortStayTool, quoteShortStaysTool, requestShortStayTool } from "@/lib/tools/domains/short-stay-sms";
import { leasingSendPaymentLinkTool } from "@/lib/tools/domains/one-number-links";
import { resolveStayPricing } from "@/lib/room-pricing";
import { GUEST, OWNER, PROPERTY, completedStay, seedShortStayDb } from "../helpers/short-stay-seed";

const NOW = new Date("2026-10-14T20:00:00Z");
const PHONE = "+12065550142";
const option = (over: Record<string, unknown> = {}) => ({
  propertyId: PROPERTY, roomId: "r1", homeName: "Cedar Court", roomLabel: "Attic Nook", nightly: 140, nights: 3, total: 420,
  checkIn: "2026-10-20", checkOut: "2026-10-23", guests: 1, listingUrl: "https://proplane.ai/rent/x", ...over,
});

function seeded(opts: Parameters<typeof seedShortStayDb>[0] = {}) {
  const db = seedShortStayDb(opts);
  db.tables.portal_workspaces = [{ id: "ws-1", owner_user_id: OWNER, is_default: true, is_service: true }];
  db.tables.profile_roles = [{ user_id: GUEST, role: "resident" }];
  chargeDb = db;
  return db;
}

const ctxFor = (db: ReturnType<typeof seeded>, text = "ok", extra: Record<string, unknown> = {}) =>
  ({
    db,
    landlordId: OWNER,
    leasingScope: { channel: "sms", prospectPhoneE164: PHONE, currentInboundText: text, workNumber: null, ...extra },
  }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  chargeWrites.length = 0;
  chargeDb = null;
  availability.mockImplementation(async (input: { roomId: string }) => ({ ok: true, rooms: [{ roomId: input.roomId, available: true }] }));
  ensureGuestLogin.mockResolvedValue({ userId: GUEST, loginEmail: "guest@import.proplane.local", created: false, signInUrl: null });
});
afterEach(() => vi.useRealTimers());

const run = (tool: { handler: (...a: never[]) => Promise<unknown> }, ctx: unknown, input: unknown) => (tool.handler as (c: unknown, i: unknown) => Promise<any>)(ctx, input); // eslint-disable-line @typescript-eslint/no-explicit-any

describe("quote_short_stays", () => {
  it("quotes nights x the room's nightly rate, equal to resolveStayPricing's short-stay daily rate", async () => {
    const db = seeded();
    const result = await run(quoteShortStaysTool, ctxFor(db), { datesText: "short term stay Oct 20-23" });
    expect(result.ok).toBe(true);
    const [first] = result.options;
    const submission = (db.tables.manager_property_records![0]!.property_data as { listingSubmission: never }).listingSubmission as { rooms: Array<{ id: string }> };
    const pricing = resolveStayPricing({ room: submission.rooms.find((r) => r.id === first.roomId) as never, submission: submission as never, application: { rentalType: "short_term" } as never });
    expect(first.nightly).toBe(pricing.dailyRate);
    expect(first.total).toBe((pricing.dailyRate as number) * 3);
    expect(first).toMatchObject({ number: 1, homeName: "Cedar Court", checkIn: "2026-10-20", checkOut: "2026-10-23", nights: 3 });
    expect(first.listingUrl).toMatch(/^https:\/\/proplane\.ai\/.+prop-1/);
    // The options are stored server-side for the pick.
    expect(db.tables.sms_stay_offers).toHaveLength(1);
  });

  it("asks one question for the missing date, and says when a month is too long", async () => {
    const db = seeded();
    expect(await run(quoteShortStaysTool, ctxFor(db), { datesText: "I need a room for 2 weeks" })).toMatchObject({ ok: false, error: "need_dates" });
    expect(await run(quoteShortStaysTool, ctxFor(db), { datesText: "nov 3 for a month" })).toMatchObject({ ok: false, error: "too_long", maxNights: 28 });
    expect(db.tables.sms_stay_offers ?? []).toHaveLength(0);
  });

  it("leaves out a room that is taken for those nights (blocks) and one that cannot sleep the party (capacity)", async () => {
    const db = seeded();
    availability.mockImplementation(async (input: { roomId: string }) => ({ ok: true, rooms: [{ roomId: input.roomId, available: input.roomId !== "r1" }] }));
    const taken = await run(quoteShortStaysTool, ctxFor(db), { checkIn: "2026-10-20", checkOut: "2026-10-23" });
    expect(taken.options).toHaveLength(1);
    expect(taken.options[0].roomId).toBe("r4");
    availability.mockImplementation(async (input: { roomId: string }) => ({ ok: true, rooms: [{ roomId: input.roomId, available: true }] }));
    const party = await run(quoteShortStaysTool, ctxFor(db), { checkIn: "2026-10-20", checkOut: "2026-10-23", guests: 3 });
    expect(party.options.map((o: { roomId: string }) => o.roomId)).toEqual(["r4"]);
    const none = await run(quoteShortStaysTool, ctxFor(db), { checkIn: "2026-10-20", checkOut: "2026-10-23", guests: 3, budgetPerNight: 100 });
    expect(none.options).toEqual([]);
  });

  it("never invents a nightly price: a home with no rate or no short stays offers nothing", async () => {
    const db = seeded({ submission: { shortTermRentalsAllowed: false, shortTermDailyCost: "", rooms: [{ id: "r1", name: "Attic Nook", occupancyCapacity: 1 }] } });
    const result = await run(quoteShortStaysTool, ctxFor(db), { checkIn: "2026-10-20", checkOut: "2026-10-23" });
    expect(result.options).toEqual([]);
  });

  it("refuses outside a real text conversation", async () => {
    const db = seeded();
    expect(await run(quoteShortStaysTool, { db, landlordId: OWNER, leasingScope: { channel: "email", prospectPhoneE164: "" } }, { checkIn: "2026-10-20", checkOut: "2026-10-23" })).toMatchObject({ ok: false, error: "sms_only" });
  });
});

describe("pick, YES, hold", () => {
  async function quoted() {
    const db = seeded();
    await run(quoteShortStaysTool, ctxFor(db), { checkIn: "2026-10-20", checkOut: "2026-10-23" });
    return db;
  }

  it("needs a YES: nothing is written before it, a same-turn pick+YES is refused, a hedged reply is refused", async () => {
    const db = await quoted();
    const picked = await run(prepareShortStayTool, ctxFor(db), { option: 1 });
    expect(picked.confirmationQuestion).toContain("Reply YES");
    expect(picked.confirmationQuestion).toContain("$420");

    const sameTurn = await run(requestShortStayTool, ctxFor(db, "yes"), {});
    expect(sameTurn).toMatchObject({ ok: false, error: "same_turn", sideEffects: "none" });

    vi.setSystemTime(new Date(NOW.getTime() + 60_000));
    expect(await run(requestShortStayTool, ctxFor(db, "yes but can we do friday"), {})).toMatchObject({ ok: false, error: "not_confirmed" });
    expect(await run(requestShortStayTool, ctxFor(db, "maybe"), {})).toMatchObject({ ok: false, error: "not_confirmed" });
    const blocks = db.tables.portal_schedule_records!.filter((r) => r.record_type === "room_date_block");
    expect(blocks).toHaveLength(0);
  });

  it("nothing to book without a prepared pick", async () => {
    const db = await quoted();
    expect(await run(requestShortStayTool, ctxFor(db, "yes"), {})).toMatchObject({ ok: false, error: "not_prepared" });
  });

  it("YES writes the 24-hour hold through the one core, bound to the texter's login, and says what happens next", async () => {
    const db = await quoted();
    await run(prepareShortStayTool, ctxFor(db), { option: 1 });
    vi.setSystemTime(new Date(NOW.getTime() + 60_000));
    const booked = await run(requestShortStayTool, ctxFor(db, "YES"), { name: "Priya" });
    expect(booked).toMatchObject({ ok: true, status: "hold" });
    expect(booked.reply).toContain("$420");
    expect(booked.reply).toContain("24 hours");
    expect(booked.reply).not.toMatch(/https?:/);

    const block = db.tables.portal_schedule_records!.find((r) => r.record_type === "room_date_block")!;
    expect(block.row_data).toMatchObject({
      bookingStatus: "hold", checkIn: "2026-10-20", checkOut: "2026-10-23", residentUserId: GUEST, residentPhone: PHONE,
      quotedTotal: 420, rate: 140, rateBasis: "daily", stayDetails: { source: "sms_short_stay", guests: 1 },
    });
    expect((block.row_data as { stayDetails: { holdExpiresAt: string } }).stayDetails.holdExpiresAt).toBe(new Date(NOW.getTime() + 60_000 + 24 * 3600_000).toISOString());
    // The guest was the phone that texted: login minted for that number, nothing from the call named anyone else.
    expect(ensureGuestLogin).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ phone: PHONE }));
    // Hold created -> the spine hears "short_stay_requested"; the reply is the only text to the guest.
    expect(emitActionEvent.mock.calls.map((c) => (c[1] as { event: string }).event)).toEqual(["short_stay_requested"]);
    expect(enqueueOwnerSms).not.toHaveBeenCalled();
    expect(chargeWrites).toHaveLength(0);
    expect(db.tables.sms_stay_offers![0]).toMatchObject({ status: "booked" });
  });

  it("a second YES books nothing more", async () => {
    const db = await quoted();
    await run(prepareShortStayTool, ctxFor(db), { option: 1 });
    vi.setSystemTime(new Date(NOW.getTime() + 60_000));
    await run(requestShortStayTool, ctxFor(db, "yes"), {});
    expect(await run(requestShortStayTool, ctxFor(db, "yes"), {})).toMatchObject({ ok: false, error: "not_prepared" });
    expect(db.tables.portal_schedule_records!.filter((r) => r.record_type === "room_date_block")).toHaveLength(1);
  });

  it("a price changed since the quote is a new quote, not a booking", async () => {
    const db = await quoted();
    await run(prepareShortStayTool, ctxFor(db), { option: 1 });
    (db.tables.manager_property_records![0]!.property_data as { listingSubmission: { shortTermDailyCost: string } }).listingSubmission.shortTermDailyCost = "200";
    vi.setSystemTime(new Date(NOW.getTime() + 60_000));
    const result = await run(requestShortStayTool, ctxFor(db, "yes"), {});
    expect(result).toMatchObject({ ok: false, error: "price_changed" });
    expect(db.tables.portal_schedule_records!.filter((r) => r.record_type === "room_date_block")).toHaveLength(0);
  });

  it("nights taken between the quote and the YES are refused", async () => {
    const db = await quoted();
    await run(prepareShortStayTool, ctxFor(db), { option: 1 });
    availability.mockImplementation(async (input: { roomId: string }) => ({ ok: true, rooms: [{ roomId: input.roomId, available: false }] }));
    vi.setSystemTime(new Date(NOW.getTime() + 60_000));
    expect(await run(requestShortStayTool, ctxFor(db, "yes"), {})).toMatchObject({ ok: false, error: "unavailable" });
  });
});

describe("pay link", () => {
  it("a returning guest is confirmed at once, the stay_total is raised and the reply carries the in-page pay link (purpose rent on that charge)", async () => {
    const db = seeded({ history: [completedStay()] });
    const result = await bookStayForTexter(db as never, { option: option(), phone: PHONE, now: NOW });
    expect(result).toMatchObject({ ok: true, status: "confirmed", total: 420 });
    expect(chargeWrites).toHaveLength(1);
    expect(chargeWrites[0]).toMatchObject({ kind: "stay_total", amountLabel: "$420.00", residentUserId: GUEST });
    const mint = mintPhoneBoundLink.mock.calls[0]![1];
    expect(mint).toMatchObject({ purpose: "rent", targetType: "charge", phoneKey: "2065550142", workspaceId: "ws-1" });
    expect(String(mint.targetId)).toBe(guestStayChargeId((result as { blockId: string }).blockId));
    expect((result as { reply: string }).reply).toMatch(/Pay here, we text you a code when you open it: https:\/\/proplane\.ai\/l\//);
    expect(emitActionEvent.mock.calls.map((c) => (c[1] as { event: string }).event)).toContain("short_stay_confirmed");
  });

  it("a held stay gets its pay link the moment the host approves, texted and never emailed", async () => {
    const db = seeded();
    db.tables.profiles!.find((p) => p.id === GUEST)!.residentEmail = undefined;
    const held = await bookStayForTexter(db as never, { option: option(), phone: PHONE, now: NOW });
    expect(held).toMatchObject({ ok: true, status: "hold" });
    expect(mintPhoneBoundLink).not.toHaveBeenCalled();
    const blockId = (held as { blockId: string }).blockId;
    await decideShortStayHold(db as never, { blockId, decision: "approve" });
    const sms = enqueueOwnerSms.mock.calls.at(-1)![0] as { body: string; purpose: string };
    expect(sms.purpose).toBe("short_stay_confirmed");
    expect(sms.body).toMatch(/^PropLane: Confirmed, Oct 20 to 23 at Cedar Court\. Pay \$420 here, we text you a code when you open it: https:\/\/proplane\.ai\/l\//);
    for (const call of postResendEmail.mock.calls) expect(JSON.stringify(call)).not.toContain("/l/TOKEN");
  });

  it("mints nothing when there is no unpaid charge", async () => {
    const db = seeded();
    expect(await mintStayPayLink(db as never, { blockId: "axis_room_block_x", ownerId: OWNER, propertyId: PROPERTY, phone: PHONE })).toBeNull();
    db.tables.portal_household_charge_records!.push({ id: guestStayChargeId("axis_room_block_x"), status: "paid", row_data: {} });
    expect(await mintStayPayLink(db as never, { blockId: "axis_room_block_x", ownerId: OWNER, propertyId: PROPERTY, phone: PHONE })).toBeNull();
    expect(mintPhoneBoundLink).not.toHaveBeenCalled();
  });
});

describe("send_payment_link (long term and stays)", () => {
  const PLACEHOLDER = "guest.12065550142@import.proplane.local";
  function withCharges(extra: Array<Record<string, unknown>> = []) {
    const db = seeded();
    db.tables.profiles!.find((p) => p.id === GUEST)!.email = PLACEHOLDER;
    db.tables.portal_household_charge_records = [
      { id: "hc-dep", resident_user_id: GUEST, manager_user_id: OWNER, status: "pending", row_data: { id: "hc-dep", title: "Security deposit", amountLabel: "$500.00", balanceLabel: "$500.00", propertyId: PROPERTY, propertyLabel: "Cedar Court" } },
      { id: "hc-first", resident_user_id: GUEST, manager_user_id: OWNER, status: "pending", row_data: { id: "hc-first", title: "First month", amountLabel: "$1,200.00", balanceLabel: "$1,200.00", propertyId: PROPERTY, propertyLabel: "Cedar Court" } },
      { id: "hc-paid", resident_user_id: GUEST, manager_user_id: OWNER, status: "paid", row_data: { id: "hc-paid", title: "Application fee", amountLabel: "$50.00", propertyId: PROPERTY } },
      ...extra,
    ];
    chargeDb = db;
    return db;
  }

  it("sends one phone-bound link for the open deposit and first month, with each exact amount", async () => {
    const db = withCharges();
    const result = await run(leasingSendPaymentLinkTool, ctxFor(db, "send me the payment link"), {});
    expect(result).toMatchObject({ ok: true, requiresCode: true, total: "$1,700.00" });
    expect(result.charges).toEqual([
      { title: "Security deposit", amount: "$500.00", property: "Cedar Court" },
      { title: "First month", amount: "$1,200.00", property: "Cedar Court" },
    ]);
    expect(mintPhoneBoundLink.mock.calls[0]![1]).toMatchObject({ purpose: "rent", targetType: "charge", targetId: "hc-dep,hc-first", phoneKey: "2065550142", workspaceId: "ws-1" });
  });

  it("a charge not yet visible to the resident is not offered", async () => {
    const db = withCharges([{ id: "hc-future", resident_user_id: GUEST, manager_user_id: OWNER, status: "pending", row_data: { id: "hc-future", title: "Later", amountLabel: "$9.00", propertyId: PROPERTY, residentVisibleAt: "2027-01-01T00:00:00Z" } }]);
    const result = await run(leasingSendPaymentLinkTool, ctxFor(db), {});
    expect(result.charges.map((c: { title: string }) => c.title)).not.toContain("Later");
  });

  it("says nothing is waiting for a number that owns no login, or whose only match is an unverified phone", async () => {
    const db = withCharges();
    expect(await run(leasingSendPaymentLinkTool, ctxFor(db, "pay", { prospectPhoneE164: "+12065559999" }), {})).toMatchObject({ ok: false, error: "nothing_to_link" });
    // A profile that only STORES the digits (never verified) is not possession.
    db.tables.profiles!.find((p) => p.id === GUEST)!.email = "priya@example.com";
    expect(await run(leasingSendPaymentLinkTool, ctxFor(db), {})).toMatchObject({ ok: false, error: "nothing_to_link" });
    db.tables.profiles!.find((p) => p.id === GUEST)!.phone_verified_at = "2026-10-01T00:00:00Z";
    expect(await run(leasingSendPaymentLinkTool, ctxFor(db), {})).toMatchObject({ ok: true });
    expect(mintPhoneBoundLink).toHaveBeenCalledTimes(1);
  });

  it("another workspace's charges are never linked from this line", async () => {
    const db = withCharges();
    db.tables.portal_workspaces![0]!.is_service = false;
    expect(await run(leasingSendPaymentLinkTool, ctxFor(db), {})).toMatchObject({ ok: true });
    db.tables.portal_household_charge_records!.forEach((r) => (r.manager_user_id = "someone-else"));
    expect(await run(leasingSendPaymentLinkTool, ctxFor(db), {})).toMatchObject({ ok: false, error: "nothing_to_link" });
  });
});
