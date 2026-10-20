import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/action-events.server", () => ({ emitActionEvent: async () => ({}) }));
vi.mock("@/lib/sms/owner-sms-dispatcher.server", () => ({ enqueueOwnerSms: async () => ({ ok: true }) }));
vi.mock("@/lib/resend-delivery.server", () => ({ postResendEmail: async () => new Response("{}", { status: 200 }) }));
vi.mock("@/lib/manager-outbound-identity.server", () => ({ managerOutboundFromHeader: async () => "PropLane <work@proplane.test>" }));
const availability = vi.fn();
vi.mock("@/lib/room-availability-range.server", () => ({ roomAvailabilityForRange: (...args: unknown[]) => availability(...args) }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: async () => ({ ok: true }) }));
vi.mock("@/lib/public-listings.server", () => ({ getPublicListings: async () => [] }));
vi.mock("@/lib/service/service-catalog.server", () => ({ getServicePublicListings: async () => [], isPropLaneServiceLine: async () => false }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({}) }));
const ensureGuestLogin = vi.fn();
vi.mock("@/lib/short-stay/guest-login.server", async () => {
  const actual = await vi.importActual<typeof import("@/lib/short-stay/guest-login.server")>("@/lib/short-stay/guest-login.server");
  return { ...actual, ensureGuestLogin: (...args: unknown[]) => ensureGuestLogin(...args) };
});
vi.mock("@/lib/sms/conversation-houses.server", () => ({ tagProspectThreadFromAgent: async () => undefined }));

import { buildSmsDeepLink, extractPropertyLabelHint, listingTextUsBody, looksLikeProspectLeasingCta } from "@/lib/claw-leasing-links";
import { parseArrivalTime, parseStayDates } from "@/lib/short-stay/sms-stay-intent";
import { LEASING_SMS_STAY_PROMPT } from "@/lib/agent/leasing-sms-stay-prompt";
import { listLiveListingsTool } from "@/lib/tools/domains/leasing-sms";
import { prepareShortStayTool, quoteShortStaysTool, requestShortStayTool } from "@/lib/tools/domains/short-stay-sms";
import { GUEST, OWNER, seedShortStayDb } from "../helpers/short-stay-seed";
import { withSmsConfirmationReserveRpc } from "../helpers/sms-confirmation-rpc";

const NOW = new Date("2026-10-14T20:00:00Z");
const PHONE = "+12065550142";
const BODY = "Hi, I'd like to book 4709A 8th Ave · Room 8 · Oct 20–21 · 1 guest · arrive 1 pm";
const OTHER_OWNER = "owner-2";

/** Two homes of OWNER (one the texter names) and one home of a DIFFERENT workspace owner. */
function seeded() {
  const db = withSmsConfirmationReserveRpc(seedShortStayDb({ submission: { rooms: [{ id: "r8", name: "Room 8", occupancyCapacity: 1 }, { id: "r3", name: "Room 3", occupancyCapacity: 1 }] } }));
  const submission = (rooms: Array<{ id: string; name: string }>) => ({ v: 1, shortTermRentalsAllowed: true, shortTermDailyCost: "140", rooms: rooms.map((r) => ({ ...r, occupancyCapacity: 1 })) });
  db.tables.manager_property_records = [
    { id: "prop-8th", manager_user_id: OWNER, status: "live", test_workspace_id: null, property_data: { address: "4709A 8th Ave NE, Seattle, WA", listingSubmission: submission([{ id: "r8", name: "Room 8" }, { id: "r3", name: "Room 3" }]) } },
    { id: "prop-other", manager_user_id: OWNER, status: "live", test_workspace_id: null, property_data: { address: "12 Pine St, Seattle, WA", listingSubmission: submission([{ id: "p1", name: "Loft" }]) } },
    { id: "prop-foreign", manager_user_id: OTHER_OWNER, status: "live", test_workspace_id: null, property_data: { address: "5000 Foreign Way, Seattle, WA", listingSubmission: submission([{ id: "f1", name: "Room 8" }]) } },
  ];
  db.tables.portal_workspaces = [{ id: "ws-1", owner_user_id: OWNER, is_default: true, is_service: true }];
  db.tables.profile_roles = [{ user_id: GUEST, role: "resident" }];
  db.tables.sms_confirmation_codes = [];
  return db;
}
const ctxFor = (db: ReturnType<typeof seeded>, text = BODY) =>
  ({ db, landlordId: OWNER, leasingScope: { channel: "sms", prospectPhoneE164: PHONE, currentInboundText: text, workNumber: "+12065550199" } }) as never;
const run = (tool: { handler: (...a: never[]) => Promise<unknown> }, ctx: unknown, input: unknown) => (tool.handler as (c: unknown, i: unknown) => Promise<any>)(ctx, input); // eslint-disable-line @typescript-eslint/no-explicit-any

const BOOK_INPUT = { home: "4709A 8th Ave", room: "Room 8", datesText: "Oct 20–21", guests: 1, arrivalText: "arrive 1 pm" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("PHONE_OTP_HMAC_SECRET", "");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-key");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  availability.mockImplementation(async (input: { roomId: string }) => ({ ok: true, rooms: [{ roomId: input.roomId, available: true }] }));
  ensureGuestLogin.mockResolvedValue({ userId: GUEST, loginEmail: "guest@import.proplane.local", created: false, signInUrl: null });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("the book-by-text draft is read by the helpers", () => {
  it("the listing page's text round-trips: label hint, CTA recognition, dates, arrival", () => {
    expect(listingTextUsBody({ kind: "book", propertyLabel: "4709A 8th Ave", roomName: "Room 8", checkIn: "2026-10-20", checkOut: "2026-10-21", guests: 1, arrival: "13:00" })).toBe(BODY);
    expect(buildSmsDeepLink({ intent: "book", propertyLabel: "4709A 8th Ave", roomName: "Room 8", stay: { checkIn: "2026-10-20", checkOut: "2026-10-21", guests: 1, arrival: "13:00" }, toPhone: "+12532220199" })).toContain(encodeURIComponent(BODY));
    expect(extractPropertyLabelHint(BODY)).toBe("4709A 8th Ave");
    expect(looksLikeProspectLeasingCta(BODY)).toBe(true);
    const monthly = "Hi, I'd like to tour or apply for 4534 Darrow Ct · Room 2 · move-in Nov 1";
    expect(extractPropertyLabelHint(monthly)).toBe("4534 Darrow Ct");
    expect(looksLikeProspectLeasingCta(monthly)).toBe(true);
  });

  it("parseStayDates reads an en dash range, within a month and across months", () => {
    expect(parseStayDates("Oct 20–21", "2026-10-14")).toEqual({ checkIn: "2026-10-20", checkOut: "2026-10-21", nights: 1 });
    expect(parseStayDates("Oct 30–Nov 2", "2026-10-14")).toEqual({ checkIn: "2026-10-30", checkOut: "2026-11-02", nights: 3 });
    expect(parseStayDates("Dec 30–Jan 2", "2026-10-14")).toEqual({ checkIn: "2026-12-30", checkOut: "2027-01-02", nights: 3 });
  });

  it("parseArrivalTime turns a clock time into HH:MM and ignores a bare number", () => {
    expect(parseArrivalTime("arrive 1 pm")).toBe("13:00");
    expect(parseArrivalTime("around 9:30 am")).toBe("09:30");
    expect(parseArrivalTime("12 am")).toBe("00:00");
    expect(parseArrivalTime("12 pm")).toBe("12:00");
    expect(parseArrivalTime("arrive 1")).toBeNull();
  });

  it("the stay prompt tells the agent to quote at once from the draft, asking nothing first", () => {
    expect(LEASING_SMS_STAY_PROMPT).toContain("Hi, I'd like to book 4709A 8th Ave · Room 8 · Oct 20–21 · 1 guest · arrive 1 pm");
    expect(LEASING_SMS_STAY_PROMPT).toMatch(/ask nothing first/i);
    expect(LEASING_SMS_STAY_PROMPT).toMatch(/quote_short_stays at once/);
    // The monthly draft: resolve the home with the existing listing tool and continue the tour/apply flow without re-asking.
    expect(LEASING_SMS_STAY_PROMPT).toContain("Hi, I'd like to tour or apply for 4534 Darrow Ct · Room 2 · move-in Nov 1");
    expect(LEASING_SMS_STAY_PROMPT).toMatch(/list_live_listings with query/);
    expect(LEASING_SMS_STAY_PROMPT).toMatch(/build_prospect_links/);
  });
});

describe("quote_short_stays with a named home", () => {
  it("resolves the home and room from the draft and quotes only that room, keeping the arrival", async () => {
    const db = seeded();
    const result = await run(quoteShortStaysTool, ctxFor(db), BOOK_INPUT);
    expect(result).toMatchObject({ ok: true, checkIn: "2026-10-20", checkOut: "2026-10-21", nights: 1, guests: 1, requestedHome: "resolved", requestedRoom: "matched" });
    expect(result.options).toHaveLength(1);
    expect(result.options[0]).toMatchObject({ number: 1, propertyId: "prop-8th", roomId: "r8", roomLabel: "Room 8", nights: 1, total: 140, arrival: "13:00" });
    // The stored offer is what prepare/request book: the arrival rides on it.
    expect((db.tables.sms_stay_offers![0]!.options as Array<{ arrival?: string }>)[0]!.arrival).toBe("13:00");
  });

  it("an unavailable named room offers the same home's other room and says so", async () => {
    const db = seeded();
    availability.mockImplementation(async (input: { roomId: string }) => ({ ok: true, rooms: [{ roomId: input.roomId, available: input.roomId !== "r8" }] }));
    const result = await run(quoteShortStaysTool, ctxFor(db), BOOK_INPUT);
    expect(result).toMatchObject({ ok: true, requestedHome: "resolved", requestedRoom: "unavailable" });
    expect(result.options.map((o: { propertyId: string; roomId: string }) => [o.propertyId, o.roomId])).toEqual([["prop-8th", "r3"]]);
  });

  it("a home it cannot resolve falls back to the area flow (nothing is pinned)", async () => {
    const db = seeded();
    const result = await run(quoteShortStaysTool, ctxFor(db), { ...BOOK_INPUT, home: "99 Nowhere Blvd", room: undefined });
    expect(result).toMatchObject({ ok: true, requestedHome: "unresolved" });
    expect(result.options.length).toBeGreaterThan(0);
    expect(result.next).not.toMatch(/exact home/);
    // An unresolvable home with an unplaceable area still asks about the area, as before.
    expect(await run(quoteShortStaysTool, ctxFor(db), { ...BOOK_INPUT, home: "99 Nowhere Blvd", area: "Atlantis" })).toMatchObject({ ok: false, error: "unknown_area" });
  });

  it("an ambiguous name (two homes match) is not guessed", async () => {
    const db = seeded();
    (db.tables.manager_property_records as Array<Record<string, unknown>>).push({ id: "prop-8th-b", manager_user_id: OWNER, status: "live", test_workspace_id: null, property_data: { address: "4709B 8th Ave NE, Seattle, WA", listingSubmission: { v: 1, shortTermRentalsAllowed: true, shortTermDailyCost: "140", rooms: [{ id: "b1", name: "Room 1", occupancyCapacity: 1 }] } } });
    const result = await run(quoteShortStaysTool, ctxFor(db), { ...BOOK_INPUT, home: "8th Ave NE" });
    expect(result.requestedHome).toBe("unresolved");
  });

  it("a workspace number cannot reach another workspace's home, even by its exact address", async () => {
    const db = seeded();
    const result = await run(quoteShortStaysTool, ctxFor(db), { ...BOOK_INPUT, home: "5000 Foreign Way", room: "Room 8" });
    expect(result.requestedHome).toBe("unresolved");
    expect(result.options.map((o: { propertyId: string }) => o.propertyId)).not.toContain("prop-foreign");
    expect((db.tables.sms_stay_offers![0]!.options as Array<{ propertyId: string }>).every((o) => o.propertyId !== "prop-foreign")).toBe(true);
  });
});

describe("the confirm flow keeps the arrival", () => {
  it("quote -> pick -> YES writes the hold for that room with estimatedArrival 13:00", async () => {
    const db = seeded();
    await run(quoteShortStaysTool, ctxFor(db), BOOK_INPUT);
    const picked = await run(prepareShortStayTool, ctxFor(db, "yes please"), { option: 1 });
    expect(picked.confirmationQuestion).toContain("Room 8");
    const code = /Reply YES (\d{4})/.exec(picked.confirmationQuestion)![1]!;
    vi.setSystemTime(new Date(NOW.getTime() + 60_000));
    const booked = await run(requestShortStayTool, ctxFor(db, `YES ${code}`), {});
    expect(booked).toMatchObject({ ok: true, status: "hold" });
    const block = db.tables.portal_schedule_records!.find((r) => r.record_type === "room_date_block")!;
    expect(block.row_data).toMatchObject({ propertyId: "prop-8th", roomId: "r8", checkIn: "2026-10-20", checkOut: "2026-10-21", stayDetails: { estimatedArrival: "13:00", source: "sms_short_stay" } });
  });
});

describe("the monthly draft resolves its home with the existing listing tool, scoped to the workspace", () => {
  it("list_live_listings(query: home) finds the named home and never another workspace's", async () => {
    const db = seeded();
    const found = await run(listLiveListingsTool, ctxFor(db, "Hi, I'd like to tour or apply for 4709A 8th Ave · Room 8 · move-in Nov 1"), { query: "4709A 8th Ave" });
    expect(found.listings.map((l: { propertyId: string }) => l.propertyId)).toEqual(["prop-8th"]);
    const foreign = await run(listLiveListingsTool, ctxFor(db), { query: "5000 Foreign Way" });
    expect(foreign).toMatchObject({ count: 0, resolution: "none" });
  });
});
