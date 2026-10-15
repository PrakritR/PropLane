/**
 * The whole guest short-stay journey end to end over one in-memory database, with the identity chain
 * UNMOCKED: the public "Request to book" card -> `ensureGuestLogin` -> `provisionResidentAccountByEmail`
 * -> the texted one-time link -> the guest's own Stays list -> the host's Approve -> the `stay_total`
 * charge -> Book again (instant confirm for a returning guest) -> a taken range refused on its own ->
 * the 24-hour hold expiry cron.
 *
 * Why it exists next to the per-module suites: the security rule only holds if it holds ACROSS the
 * modules. The guest here types a VICTIM's address into the public card while the victim's account
 * already stores the same (unverified) phone number and has an approved application on file - the exact
 * takeover this batch closes. Nothing may leak: the login is the phone-keyed placeholder, the victim's
 * application / inbox / auth account are never inherited, the typed address lives on the stay row only,
 * and the charge is keyed on the guest's own login.
 *
 * Only the edges are stood in for: SMS / email delivery, the notice bus, the charge writer, and the
 * occupancy read (which opens its own service-role client) - the last one answers from this very table,
 * so a "taken" night is a row that is really there. Set `GUEST_STAY_JOURNEY_TRANSCRIPT=<path>` to write
 * the narrated walkthrough out as evidence.
 */
import { writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createFakeDb, type Row } from "../helpers/fake-table-db";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/action-events.server", () => ({ emitActionEvent: vi.fn(async () => ({})) }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: async () => ({ ok: true }) }));

const sms: Array<{ recipientPhone: string; recipientEmail?: string; body: string; purpose: string }> = [];
vi.mock("@/lib/sms/owner-sms-dispatcher.server", () => ({
  enqueueOwnerSms: async (input: { recipientPhone: string; recipientEmail?: string; body: string; purpose: string }) => {
    sms.push(input);
    return { ok: true };
  },
}));

const emails: Array<{ to: string[]; subject: string; text: string }> = [];
vi.mock("@/lib/resend-delivery.server", () => ({
  postResendEmail: async (input: { payload: { to: string[]; subject: string; text: string } }) => {
    emails.push(input.payload);
    return new Response("{}", { status: 200 });
  },
}));
vi.mock("@/lib/manager-outbound-identity.server", () => ({ managerOutboundFromHeader: async () => "Cedar Court <work@proplane.test>" }));

const inboxAttach = vi.fn(async () => undefined);
vi.mock("@/lib/tour-resident-link.server", () => ({ attachInboxThreadsToResident: (...a: unknown[]) => inboxAttach(...(a as [])) }));
const migratePortalUserId = vi.fn(async () => undefined);
vi.mock("@/lib/auth/migrate-portal-user-id", () => ({ migratePortalUserId: (...a: unknown[]) => migratePortalUserId(...(a as [])) }));

const charges: Array<Record<string, unknown>> = [];
vi.mock("@/lib/household-charges.server", () => ({
  upsertManagerCharges: async (_db: unknown, _owner: string, rows: Array<Record<string, unknown>>) => {
    for (const charge of rows) {
      charges.push(charge);
      db.tables.portal_household_charge_records!.push({ id: charge.id, resident_email: charge.residentEmail, row_data: charge });
    }
  },
}));

/**
 * The real occupancy read opens its own service-role client, so it is stood in for - but it answers
 * from the journey's own `portal_schedule_records`, so "those nights are taken" means a live hold or
 * confirmed stay really overlaps.
 */
vi.mock("@/lib/room-availability-range.server", () => ({
  roomAvailabilityForRange: async (input: { roomId: string; moveIn: string; moveOut: string }) => {
    const taken = (db.tables.portal_schedule_records ?? []).some((record) => {
      if (record.record_type !== "room_date_block") return false;
      const row = (record.row_data ?? {}) as Record<string, unknown>;
      if (row.roomId !== input.roomId) return false;
      if (!["hold", "confirmed"].includes(String(row.bookingStatus))) return false;
      return String(row.checkIn) < input.moveOut && input.moveIn < String(row.checkOut);
    });
    return { ok: true, rooms: [{ roomId: input.roomId, roomLabel: "Attic Nook", available: !taken, rentLabel: null }] };
  },
}));

import { provisionResidentAccountByEmail } from "@/lib/auth/provision-resident-account";
import { guestPlaceholderEmail } from "@/lib/short-stay/guest-login.server";
import { listGuestStays, bookGuestStays } from "@/lib/short-stay/guest-stays.server";
import { guestStayChargeId } from "@/lib/short-stay/stay-charge.server";
import { guestStayStatusLabel } from "@/lib/short-stay/guest-stays";
import { decideShortStayHold } from "@/lib/short-stay/hold-decisions.server";
import { expireShortStayHolds } from "@/lib/short-stay-hold-expiry.server";
import { submitShortStayRequest } from "@/lib/short-stay-request.server";

const OWNER = "owner-1";
const VICTIM = "victim-1";
const PROPERTY = "prop-1";
const TODAY = "2026-10-14";
const GUEST_PHONE = "+12065550142";
const TYPED_EMAIL = "victim@example.com";
const PLACEHOLDER = guestPlaceholderEmail(GUEST_PHONE);

/* ─────────── transcript ─────────── */
const lines: string[] = [];
const say = (line = "") => lines.push(line);
const step = (title: string) => {
  say();
  say(`━━ ${title} ${"━".repeat(Math.max(0, 74 - title.length))}`);
};
const show = (label: string, value: unknown) => say(`   ${label.padEnd(34)} ${typeof value === "string" ? value : JSON.stringify(value)}`);

/* ─────────── the world ─────────── */
type AuthUser = { id: string; email: string; user_metadata: Record<string, unknown> };
const authUsers: AuthUser[] = [];
const mintedLinks: Array<{ email: string; token: string }> = [];

function listing() {
  return {
    v: 1,
    shortTermRentalsAllowed: true,
    shortTermDailyCost: "140",
    shortStayInstantBookReturning: true,
    rooms: [
      { id: "r1", name: "Attic Nook", occupancyCapacity: 1 },
      { id: "r4", name: "Garden Suite", occupancyCapacity: 4 },
    ],
  };
}

function build() {
  const fake = createFakeDb({
    manager_property_records: [
      {
        id: PROPERTY,
        manager_user_id: OWNER,
        status: "live",
        test_workspace_id: null,
        property_data: { buildingName: "Cedar Court", listingSubmission: listing() },
      },
    ],
    profiles: [
      { id: OWNER, email: "owner@proplane.test", full_name: "Ambika Mago", role: "manager" },
      // The victim: a resident whose Settings page stores the SAME mobile number, never verified.
      { id: VICTIM, email: TYPED_EMAIL, full_name: "Dana Whitfield", phone: GUEST_PHONE, phone_verified_at: null, role: "resident", application_approved: true },
    ],
    profile_roles: [{ user_id: VICTIM, role: "resident" }],
    // The bait: an APPROVED application on the typed address.
    manager_application_records: [
      { id: "PROPLANE-APP1", resident_email: TYPED_EMAIL, updated_at: "2026-09-01", row_data: { bucket: "approved", name: "Dana Whitfield", application: { phone: "+12065559999" } } },
    ],
    portal_schedule_records: [],
    portal_household_charge_records: [],
    account_recovery_requests: [],
  });
  authUsers.length = 0;
  authUsers.push({ id: VICTIM, email: TYPED_EMAIL, user_metadata: { role: "resident" } });
  let n = 0;
  const admin = {
    createUser: async ({ email, user_metadata }: { email: string; user_metadata?: Record<string, unknown> }) => {
      const user: AuthUser = { id: `auth-${++n}`, email: String(email).toLowerCase(), user_metadata: user_metadata ?? {} };
      authUsers.push(user);
      return { data: { user }, error: null };
    },
    getUserById: async (id: string) => ({ data: { user: authUsers.find((u) => u.id === id) ?? null }, error: null }),
    updateUserById: async (id: string, patch: { user_metadata?: Record<string, unknown> }) => {
      const user = authUsers.find((u) => u.id === id);
      if (user && patch.user_metadata) user.user_metadata = patch.user_metadata;
      return { data: { user }, error: null };
    },
    listUsers: async () => ({ data: { users: authUsers }, error: null }),
    generateLink: async ({ email }: { email: string }) => {
      const token = `tok_${mintedLinks.length + 1}`;
      mintedLinks.push({ email: String(email).toLowerCase(), token });
      return { data: { properties: { hashed_token: token } }, error: null };
    },
  };
  return Object.assign(fake, { auth: { admin } });
}

const db = build();
const blocks = () => (db.tables.portal_schedule_records ?? []) as Array<Row & { row_data: Record<string, unknown> }>;
const blockFor = (checkIn: string) => blocks().find((row) => row.row_data.checkIn === checkIn)!;
const profile = (id: string) => (db.tables.profiles ?? []).find((row) => row.id === id) as Record<string, unknown> | undefined;

const publicRequest = (over: Record<string, unknown> = {}) =>
  submitShortStayRequest(
    db as never,
    { propertyId: PROPERTY, roomId: "r1", checkIn: "2026-10-20", checkOut: "2026-10-23", guests: 1, name: "Priya Natarajan", phone: GUEST_PHONE, email: TYPED_EMAIL, honeypot: "", ...over },
    { today: TODAY },
  );

beforeAll(() => {
  process.env.RESEND_API_KEY = "re_journey";
  say("PropLane · guest short-stay journey, end to end on one database");
  say(`today ${TODAY} (Pacific) · listing "Cedar Court" · room "Attic Nook" $140/night · instant book for returning guests: on`);
  say(`the guest types phone ${GUEST_PHONE} and the address ${TYPED_EMAIL} - which belongs to resident "Dana Whitfield",`);
  say("whose account stores that same number UNVERIFIED and has an APPROVED application on file.");
});

afterAll(() => {
  const out = process.env.GUEST_STAY_JOURNEY_TRANSCRIPT?.trim();
  if (!out) return;
  writeFileSync(out, `${lines.join("\n")}\n`, "utf8");
});

let guestUserId = "";

describe("the guest short-stay journey", () => {
  it("1 · the public card: the hold is saved, and the login it mints is keyed on the PHONE, never the typed address", async () => {
    step("1 · Public listing card -> Request to book (POST /api/public/short-stay-request)");
    const result = await publicRequest();
    expect(result).toEqual({ ok: true });
    show("route answer", result);

    const hold = blockFor("2026-10-20");
    guestUserId = String(hold.row_data.residentUserId);
    const account = authUsers.find((user) => user.id === guestUserId)!;

    show("stay row written", `${String(hold.row_data.reason)} · ${String(hold.row_data.checkIn)} → ${String(hold.row_data.checkOut)} · $${String(hold.row_data.quotedTotal)}`);
    show("  bookingStatus", hold.row_data.bookingStatus);
    show("  stayDetails", hold.row_data.stayDetails);
    show("  residentPhone", hold.row_data.residentPhone);
    show("  residentEmail (host's copy)", hold.row_data.residentEmail);
    show("  residentUserId", guestUserId);
    say();
    show("auth login created", account.email);
    show("profiles.email for that login", profile(guestUserId)!.email);
    show("profiles.full_name", profile(guestUserId)!.full_name);
    show("profiles.application_approved", profile(guestUserId)!.application_approved);
    show("victim's own profile row", `${String(profile(VICTIM)!.email)} (id ${VICTIM}, untouched)`);
    show("application inherited?", migratePortalUserId.mock.calls.length === 0 && profile(guestUserId)!.application_approved === false ? "no" : "YES - LEAK");
    show("victim inbox threads attached?", inboxAttach.mock.calls.length ? "YES - LEAK" : "no");

    // The login is the phone-keyed placeholder, and the typed address is nobody's login here.
    expect(account.email).toBe(PLACEHOLDER);
    expect(profile(guestUserId)!.email).toBe(PLACEHOLDER);
    expect(account.email).not.toBe(TYPED_EMAIL);
    expect(guestUserId).not.toBe(VICTIM);
    // emailProven:false -> no application, no auth-account merge, no inbox threads.
    expect(profile(guestUserId)!.application_approved).toBe(false);
    expect(profile(guestUserId)!.full_name).toBe("Priya Natarajan");
    expect(migratePortalUserId).not.toHaveBeenCalled();
    expect(inboxAttach).not.toHaveBeenCalled();
    // The victim's row is exactly as it was.
    expect(profile(VICTIM)).toMatchObject({ email: TYPED_EMAIL, full_name: "Dana Whitfield", application_approved: true });
    // The typed address lives on the stay row only.
    expect(hold.row_data.residentEmail).toBe(TYPED_EMAIL);
    expect(hold.row_data.bookingStatus).toBe("hold");
    expect((hold.row_data.stayDetails as Record<string, unknown>).holdExpiresAt).toBeTruthy();
  });

  it("2 · the one-time sign-in link is TEXTED to the typed phone and is absent from the email", async () => {
    step("2 · Delivery: the link goes to the phone, the typed address gets an informational note");
    const texted = sms.at(-1)!;
    const mailed = emails.at(-1)!;
    show("text to", texted.recipientPhone);
    for (const line of texted.body.split("\n")) say(`     | ${line}`);
    say();
    show("email to", mailed.to.join(", "));
    show("email subject", mailed.subject);
    show("email contains token_hash?", mailed.text.includes("token_hash") ? "YES - LEAK" : "no");
    show("email contains 'Sign in'?", /Sign in/.test(mailed.text) ? "YES - LEAK" : "no");
    show("links minted for", mintedLinks.map((link) => link.email));

    expect(texted.recipientPhone).toBe(GUEST_PHONE);
    expect(texted.body).toContain("Sign in to see your stays: https://");
    expect(texted.body).toContain("token_hash=");
    expect(texted.body).toContain("type=magiclink");
    expect(texted.body).not.toContain("code=");
    expect(mailed.to).toEqual([TYPED_EMAIL]);
    expect(mailed.text).not.toContain("token_hash");
    expect(mailed.text).not.toMatch(/Sign in/);
    // Every link minted in this journey is for the placeholder login, never the typed address.
    expect(mintedLinks.every((link) => link.email === PLACEHOLDER)).toBe(true);
  });

  it("3 · the guest opens the link and sees their own stay; the victim sees nothing", async () => {
    step("3 · GET /api/resident/stays as each account");
    const mine = await listGuestStays(db as never, { userId: guestUserId });
    const theirs = await listGuestStays(db as never, { userId: VICTIM });
    for (const stay of mine) {
      show("guest's Stays row", `${stay.propertyLabel} · ${stay.roomLabel} | ${stay.checkIn} → ${stay.checkOut} | ${stay.nights} nights | $${stay.total} | ${guestStayStatusLabel(stay, TODAY, new Date("2026-10-14T20:00:00Z"))}`);
    }
    show("victim's Stays rows", theirs.length);

    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ propertyLabel: "Cedar Court", roomLabel: "Attic Nook", status: "pending", nights: 3, total: 420 });
    expect(theirs).toEqual([]);
  });

  it("4 · the host taps Approve: the stay confirms and raises a stay_total keyed on the guest's own login", async () => {
    step("4 · Manager Bookings -> Approve (POST /api/portal/bookings/short-stay-decision)");
    const hold = blockFor("2026-10-20");
    const answered = await decideShortStayHold(db as never, { blockId: String(hold.id), decision: "approve", now: new Date("2026-10-14T21:00:00Z") });
    show("decision answer", answered);
    const confirmed = blockFor("2026-10-20");
    show("row now", `${String(confirmed.row_data.bookingStatus)} · ${JSON.stringify(confirmed.row_data.stayDetails)}`);
    const charge = charges.at(-1)!;
    show("charge id", charge.id);
    show("charge kind / title", `${String(charge.kind)} · ${String(charge.title)}`);
    show("charge amount", charge.amountLabel);
    show("charge residentUserId", charge.residentUserId);
    show("charge residentEmail", charge.residentEmail);
    show("charge guestStayBlockId", charge.guestStayBlockId);
    show("charge shortStayBookingId", charge.shortStayBookingId ?? "(absent - never minted a lease)");
    const again = await decideShortStayHold(db as never, { blockId: String(hold.id), decision: "approve" });
    show("Approve tapped twice", again);
    show("charges raised in total", charges.length);

    expect(answered).toEqual({ ok: true, outcome: "confirmed", decision: "approve", chargeCreated: true });
    expect(confirmed.row_data.bookingStatus).toBe("confirmed");
    expect(charge.id).toBe(guestStayChargeId(String(hold.id)));
    expect(charge.kind).toBe("stay_total");
    // The payable charge is keyed on the guest's own login - never the unverified typed address.
    expect(charge.residentUserId).toBe(guestUserId);
    expect(charge.residentEmail).toBe(PLACEHOLDER);
    expect(charge.residentEmail).not.toBe(TYPED_EMAIL);
    expect(charge.guestStayBlockId).toBe(String(hold.id));
    expect(charge.shortStayBookingId).toBeUndefined();
    expect(again).toMatchObject({ ok: false, status: 409 });
    expect(charges).toHaveLength(1);
  });

  it("5 · after checkout the guest Books again and is confirmed instantly, with its own charge", async () => {
    step("5 · Book again sheet -> POST /api/resident/stays (dry run, then book)");
    // The stay is behind them now: today is the day after their checkout.
    const later = "2026-10-24";
    const body = { propertyId: PROPERTY, roomId: "r1", guests: 1, ranges: [{ checkIn: "2026-10-25", checkOut: "2026-10-27" }] };
    const dry = await bookGuestStays(db as never, { userId: guestUserId, today: later, body: { ...body, dryRun: true } });
    show("dry run (what the button says)", dry.ok ? `${dry.action} -> "${dry.summary}"` : dry);
    const booked = await bookGuestStays(db as never, { userId: guestUserId, today: later, body });
    show("booked", booked.ok ? booked.results : booked);
    const row = blockFor("2026-10-25");
    show("new row", `${String(row.row_data.bookingStatus)} · guests ${JSON.stringify(row.row_data.stayDetails)}`);
    show("second charge", `${String(charges.at(-1)!.id)} · ${String(charges.at(-1)!.amountLabel)} · ${String(charges.at(-1)!.residentEmail)}`);
    show("guest text", sms.at(-1)!.body.split("\n")[0]);

    expect(dry.ok && dry.action).toBe("confirm");
    expect(booked.ok && booked.results[0]).toMatchObject({ outcome: "confirmed", nights: 2, total: 280 });
    expect(row.row_data.bookingStatus).toBe("confirmed");
    expect(charges).toHaveLength(2);
    expect(charges.at(-1)!.residentEmail).toBe(PLACEHOLDER);
  });

  it("6 · a taken range is refused on its own (409) while the free range in the same request still books", async () => {
    step("6 · Those nights are asked for again, by the portal and by the public card");
    const mixed = await bookGuestStays(db as never, {
      userId: guestUserId,
      today: "2026-10-24",
      body: { propertyId: PROPERTY, roomId: "r1", guests: 1, ranges: [{ checkIn: "2026-10-25", checkOut: "2026-10-26" }, { checkIn: "2026-10-28", checkOut: "2026-10-29" }] },
    });
    if (!mixed.ok) throw new Error("expected a per-range answer");
    mixed.results.forEach((range, index) => show(`range ${index + 1}`, `${range.checkIn} → ${range.checkOut} · ${range.outcome}${range.error ? ` · "${range.error}"` : ""}`));
    show("summary", mixed.summary);
    const refused = await publicRequest({ phone: "+12065550199", name: "Someone Else", email: "", checkIn: "2026-10-25", checkOut: "2026-10-26" });
    show("public card, same nights", refused);

    expect(mixed.results[0]).toMatchObject({ outcome: "unavailable", error: "That room was just booked for those dates." });
    expect(mixed.results[1]).toMatchObject({ outcome: "confirmed" });
    expect(refused).toEqual({ ok: false, status: 409, error: "That room was just booked for those dates." });
  });

  it("7 · the 24-hour hold expiry cron answers a request the host left alone", async () => {
    step("7 · Cron /api/cron/short-stay-hold-expiry, 25 hours after a request");
    const fresh = await publicRequest({ phone: "+12065550177", name: "Omar Haddad", email: "", checkIn: "2026-11-02", checkOut: "2026-11-04" });
    expect(fresh).toEqual({ ok: true });
    const hold = blockFor("2026-11-02");
    const expires = String((hold.row_data.stayDetails as Record<string, unknown>).holdExpiresAt);
    show("hold expires at", expires);
    const early = await expireShortStayHolds(db as never, new Date(Date.parse(expires) - 60_000));
    show("cron one minute early", early);
    const run = await expireShortStayHolds(db as never, new Date(Date.parse(expires) + 60_000));
    show("cron one minute late", run);
    const after = blocks().find((row) => row.row_data.checkIn === "2026-11-02")!;
    show("row now", `${String(after.record_type)} · ${String(after.row_data.bookingStatus)} · ${JSON.stringify(after.row_data.stayDetails)}`);
    const guestId = String(after.row_data.residentUserId);
    show("guest's Stays row now", (await listGuestStays(db as never, { userId: guestId })).map((stay) => `${stay.checkIn} → ${stay.checkOut} · ${guestStayStatusLabel(stay, "2026-11-01")}`));
    show("text to the guest", sms.at(-1)!.body.split("\n")[0]);
    say();
    say("Every assertion above is enforced by this test; a leak would fail it.");

    expect(early).toMatchObject({ checked: 0, released: 0, failed: 0 });
    expect(run).toMatchObject({ checked: 1, released: 1, failed: 0 });
    expect(after.record_type).toBe("cancelled_room_date_block");
    expect((after.row_data.stayDetails as Record<string, unknown>).decision).toBe("expired");
    expect((await listGuestStays(db as never, { userId: guestId }))[0]!.status).toBe("expired");
  });
});
