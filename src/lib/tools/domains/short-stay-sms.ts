/**
 * Booking a short stay by text, on the PropLane line and on a workspace's own number.
 *
 *   quote_short_stays   (read)   dates + guests (+ area, budget) -> up to 3 homes that are really free, each
 *                                with its total, from the stored listing: nightly x nights, the same figure
 *                                `createShortStayRows` writes and the `stay_total` charge bills (and the
 *                                `resolveStayPricing` short-stay daily rate). Saves the options server-side.
 *   prepare_short_stay  (read)   they picked option N -> the exact question that ends in "Reply YES <code>".
 *   request_short_stay  (write)  their YES -> the ONE core (`bookGuestStays` -> `createShortStayRows`), a
 *                                24-hour hold the host answers, or an instant confirm for a returning guest,
 *                                then the phone-bound pay link as soon as there is a charge to pay.
 *
 * `request_short_stay` is inline-allowed on SMS like `request_tour`: the stay it writes is a hold the host
 * confirms and nothing is charged by it. It books only the stored option the texter picked in an EARLIER turn
 * and then affirmed, so the model supplies no room, date or price and a pick plus its YES in one text is refused.
 * The guest is the phone that texted (`ensureGuestLogin`), never a field of the call.
 */
import { z } from "zod";
import { defineTool, defineWriteTool } from "../registry";
import type { AgentContext } from "../context";
import { loadShortStayHomes, publicOrigin } from "./leasing-sms";
import { buildManagerListingUrl } from "@/lib/manager-property-links";
import { normalizeConsentPhone } from "@/lib/sms-consent";
import { pacificTodayKey } from "@/lib/room-availability-range";
import {
  SHORT_STAY_MAX_GUESTS,
  SHORT_STAY_MAX_NIGHTS,
  formatShortStayMoney,
  listingOffersShortStay,
  shortStayRangeLabel,
  validateShortStayDates,
} from "@/lib/short-stay-request";
import { createShortStayRows, loadShortStayListing } from "@/lib/short-stay-request.server";
import { SHORT_STAY_HOLD_HOURS, SMS_SHORT_STAY_SOURCE } from "@/lib/short-stay/guest-stays";
import { parseArrivalTime, parseStayDates } from "@/lib/short-stay/sms-stay-intent";
import { normalizeListingIdentity } from "@/lib/listing-identity";
import { bookStayForTexter, confirmStayRequestCode, issueStayRequestCode, stayRequestCodedLine } from "@/lib/short-stay/sms-stay-book.server";
import {
  claimPreparedStayOffer,
  finishStayOffer,
  loadLiveStayOffer,
  pickIsFromEarlierTurn,
  prepareStayOffer,
  saveStayOffer,
  type StayOfferOption,
} from "@/lib/short-stay/sms-stay-offers.server";

const MAX_OPTIONS = 3;
/** Rooms checked per quote. Each is one calendar read; a text must not fan out across a whole catalog. */
const MAX_ROOMS_CHECKED = 14;

type TexterScope = { phoneKey: string; phoneE164: string };

function texter(ctx: AgentContext): TexterScope | null {
  const scope = ctx.leasingScope;
  if (!scope || scope.channel !== "sms" || !scope.prospectPhoneE164 || scope.testActorUserId) return null;
  const phoneKey = normalizeConsentPhone(scope.prospectPhoneE164);
  return /^\d{10}$/.test(phoneKey) ? { phoneKey, phoneE164: scope.prospectPhoneE164 } : null;
}

function turnOf(ctx: AgentContext): string | null {
  const burst = ctx.leasingScope?.prospectBurst;
  return burst ? `${burst.burstId}:${burst.revision}` : null;
}

/** The one room whose name is the texter's ("Room 8" for "8" or "room 8"); null when none or several match. */
function matchRoomByName<T extends { name?: string }>(rooms: readonly T[], wanted: string): T | null {
  const strip = (value: string) => normalizeListingIdentity(value).replace(/^room/, "");
  const target = strip(wanted);
  if (!target) return null;
  const hits = rooms.filter((room) => strip(room.name ?? "") === target);
  return hits.length === 1 ? hits[0]! : null;
}

const NOT_SMS = { ok: false as const, error: "sms_only" as const, message: "Short stays can only be booked from a text conversation." };

/* ───────────────────────────── quote ───────────────────────────── */

const quoteInput = z
  .object({
    datesText: z.string().max(300).optional().describe("The guest's own words about the dates, copied verbatim (\"Nov 3-10\", \"for 2 weeks starting tomorrow\"). Never convert them yourself."),
    checkIn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Check-in, only when the guest gave a full unambiguous date."),
    checkOut: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Check-out (the morning they leave), only with checkIn."),
    guests: z.number().int().min(1).max(SHORT_STAY_MAX_GUESTS).optional().describe("How many people. Defaults to 1."),
    area: z.string().max(200).optional().describe("A place the guest named, in their words."),
    budgetPerNight: z.number().positive().max(100_000).optional().describe("Their nightly budget in dollars, if they gave one."),
    home: z.string().max(200).optional().describe("The home the texter named, in their words: the street address or listing title from a \"Hi, I'd like to book 4709A 8th Ave · Room 8 · Oct 20–21 · …\" text (\"4709A 8th Ave\"). Looked up on the server among this line's own homes; when it resolves, ONLY that home is quoted."),
    room: z.string().max(120).optional().describe("The room they named at that home (\"Room 8\"), copied as written. Only used with home."),
    arrivalText: z.string().max(120).optional().describe("Their arrival words, verbatim (\"arrive 1 pm\"). Kept on the stay; never convert it yourself."),
  })
  .strict();

type QuoteResult =
  | { ok: true; options: Array<StayOfferOption & { number: number; distanceMiles?: number | null }>; checkIn: string; checkOut: string; nights: number; guests: number; holdHours: number; next: string; requestedHome?: "resolved" | "unresolved"; requestedRoom?: "matched" | "unmatched" | "unavailable" }
  | { ok: false; error: string; message?: string; ask?: string; maxNights?: number };

export const quoteShortStaysTool = defineTool<z.infer<typeof quoteInput>, QuoteResult, AgentContext>({
  name: "quote_short_stays",
  description:
    "Quote a SHORT stay (nights or a few weeks, 1 to 28 nights) for a texter: up to 3 homes that are free for those dates with the exact total, plus each home's link. Use when they ask for a room for nights, a few weeks, 'short term', 'nightly' or 'Airbnb style'. Pass their date words as datesText and let the tool read them. When the newest text is a 'Hi, I'd like to book <home> · <room> · <dates> · <n> guests · arrive <time>' draft, pass the home (and room, guests, arrivalText) from it and the tool quotes that exact home and room instead of searching an area. If it says need_dates, ask ONE question for the missing date. Numbers come only from this tool: never work out a price. Afterwards list the options with dates, total and link, and ask which one they want.",
  kind: "read",
  inputSchema: quoteInput,
  handler: async (ctx, input): Promise<QuoteResult> => {
    const who = texter(ctx);
    if (!who) return NOT_SMS;
    const today = pacificTodayKey();

    let checkIn = input.checkIn ?? null;
    let checkOut = input.checkOut ?? null;
    if (!(checkIn && checkOut)) {
      const parsed = parseStayDates(input.datesText ?? "", today);
      checkIn = checkIn ?? parsed.checkIn;
      checkOut = checkOut ?? parsed.checkOut;
      if (!checkIn) return { ok: false, error: "need_dates", ask: parsed.nights ? `What day do you want to check in? (I have ${parsed.nights} nights.)` : "What dates are you looking at? A check-in and check-out day." };
      if (!checkOut) return { ok: false, error: "need_dates", ask: "What day do you check out?" };
    }
    const dates = validateShortStayDates(checkIn, checkOut, today);
    if (!dates.ok) {
      const tooLong = dates.error.includes(String(SHORT_STAY_MAX_NIGHTS));
      return { ok: false, error: tooLong ? "too_long" : "invalid_dates", message: dates.error, ...(tooLong ? { maxNights: SHORT_STAY_MAX_NIGHTS } : {}) };
    }
    const guests = input.guests ?? 1;

    const { homes, area, home: homeOutcome } = await loadShortStayHomes(ctx, { area: input.area, home: input.home });
    const homePinned = homeOutcome?.resolved === true;
    if (!homePinned && area && area.resolved === false) return { ok: false, error: "unknown_area", message: `I can't place "${String(area.requested)}". Ask which Seattle neighborhood, landmark or zip they mean.` };
    const ranked = homes.slice(0, 10);
    const candidates: Array<{ home: (typeof ranked)[number]; roomId: string }> = [];
    // When the texter named a room at the named home, it goes first and alone; the home's other rooms are the fallback.
    const fallbackCandidates: typeof candidates = [];
    let roomOutcome: "matched" | "unmatched" | undefined;
    const wantedRoom = homePinned ? (input.room ?? "").trim() : "";
    if (ranked.length > 0) {
      const { data } = await ctx.db
        .from("manager_property_records")
        .select("id, property_data")
        .in("id", ranked.map((h) => h.id))
        .eq("status", "live")
        .is("test_workspace_id", null);
      const submissions = new Map(
        ((data ?? []) as Array<{ id: string; property_data?: { listingSubmission?: { rooms?: Array<{ id?: string; name?: string }> } } | null }>).map((row) => [row.id, row.property_data?.listingSubmission ?? null] as const),
      );
      for (const home of ranked) {
        const submission = submissions.get(home.id);
        if (!submission || !listingOffersShortStay(submission as never)) continue;
        const rooms = (submission.rooms ?? []).filter((room) => room.id);
        const named = wantedRoom ? matchRoomByName(rooms, wantedRoom) : null;
        if (wantedRoom) roomOutcome = named ? "matched" : "unmatched";
        for (const room of rooms) (named && room !== named ? fallbackCandidates : candidates).push({ home, roomId: room.id! });
      }
    }

    const range = { checkIn: dates.checkIn, checkOut: dates.checkOut, nights: dates.nights };
    const evaluate = (list: typeof candidates) => Promise.all(
      list.slice(0, MAX_ROOMS_CHECKED).map(async ({ home, roomId }) => {
        const loaded = await loadShortStayListing(ctx.db, { propertyId: home.id, roomId, guests });
        if (!loaded.ok) return null;
        const { listing } = loaded;
        if (input.budgetPerNight && listing.nightly > input.budgetPerNight) return null;
        const [row] = await createShortStayRows(ctx.db, {
          actor: { source: SMS_SHORT_STAY_SOURCE, name: "", phone: "", email: "", residentUserId: null },
          listing,
          guests,
          ranges: [range],
          status: "hold",
          dryRun: true,
        });
        if (!row || !row.ok) return null;
        return { home, listing, total: row.total };
      }),
    );
    let evaluated = await evaluate(candidates);
    let roomUnavailable = false;
    if (roomOutcome === "matched" && !evaluated.some(Boolean) && fallbackCandidates.length > 0) {
      // The room they named is not free (or not bookable) for those nights: say so and offer the same home's others.
      roomUnavailable = true;
      evaluated = await evaluate(fallbackCandidates);
    }

    // One room per home (the cheapest that is free), homes in the order the area ranked them.
    const origin = publicOrigin();
    const options: StayOfferOption[] = [];
    const seen = new Set<string>();
    for (const home of ranked) {
      if (options.length >= MAX_OPTIONS) break;
      const rooms = evaluated.filter((e): e is NonNullable<typeof e> => Boolean(e) && e!.home.id === home.id && !seen.has(home.id));
      const best = rooms.sort((a, b) => a.total - b.total)[0];
      if (!best) continue;
      seen.add(home.id);
      options.push({
        propertyId: home.id,
        roomId: best.listing.room.id,
        homeName: best.listing.propertyLabel,
        roomLabel: best.listing.roomLabel,
        nightly: best.listing.nightly,
        nights: dates.nights,
        total: best.total,
        checkIn: dates.checkIn,
        checkOut: dates.checkOut,
        guests,
        listingUrl: buildManagerListingUrl(origin, home.id),
      });
    }
    const arrival = parseArrivalTime(input.arrivalText ?? "");
    if (arrival) for (const option of options) option.arrival = arrival;
    const named = homeOutcome
      ? {
          requestedHome: homePinned ? ("resolved" as const) : ("unresolved" as const),
          ...(homePinned && wantedRoom ? { requestedRoom: roomUnavailable ? ("unavailable" as const) : roomOutcome === "matched" ? ("matched" as const) : ("unmatched" as const) } : {}),
        }
      : {};
    if (options.length === 0) return { ok: true, options: [], checkIn: dates.checkIn, checkOut: dates.checkOut, nights: dates.nights, guests, holdHours: SHORT_STAY_HOLD_HOURS, next: "Nothing is free for those dates. Say so, and offer other dates or a long-term room.", ...named };

    const saved = await saveStayOffer(ctx.db, { managerUserId: ctx.landlordId, phoneKey: who.phoneKey, options });
    if (!saved) return { ok: false, error: "unavailable", message: "I could not save these options. A teammate will follow up." };
    const distances = new Map(homes.map((h) => [h.id, h.area?.distanceMiles ?? null] as const));
    return {
      ok: true,
      options: options.map((o, i) => ({ ...o, number: i + 1, distanceMiles: distances.get(o.propertyId) ?? null })),
      checkIn: dates.checkIn,
      checkOut: dates.checkOut,
      nights: dates.nights,
      guests,
      holdHours: SHORT_STAY_HOLD_HOURS,
      next: homePinned
        ? roomUnavailable
          ? "The room they named is not free for those dates, but this is the same home. Say so plainly, then offer this option (home, room, dates, total, link) and ask if they want it. When they say yes, call prepare_short_stay with its number."
          : "They named this exact home. Offer just this option (home, room, dates, total, link) and ask if they want it; do not ask about dates, guests or area again. When they say yes, call prepare_short_stay with its number."
        : "List each option on its own line: home, room, dates, the total, then its link. Then ask which one they want. When they pick, call prepare_short_stay with its number.",
      ...named,
    };
  },
});

/* ───────────────────────────── pick ───────────────────────────── */

const prepareInput = z.object({ option: z.number().int().min(1).max(MAX_OPTIONS) }).strict();

export const prepareShortStayTool = defineTool<
  z.infer<typeof prepareInput>,
  { ok: true; confirmationQuestion: string; next: string } | { ok: false; error: string; message?: string },
  AgentContext
>({
  name: "prepare_short_stay",
  description:
    "After the texter picks one of the options quote_short_stays returned, call this with that option's number. It returns the exact question to send, which ends in 'Reply YES <4-digit code>' (the code is for the texter's phone only). Send confirmationQuestion verbatim as your whole reply. Never call request_short_stay in the same turn.",
  kind: "read",
  inputSchema: prepareInput,
  handler: async (ctx, input) => {
    const who = texter(ctx);
    if (!who) return NOT_SMS;
    const offer = await loadLiveStayOffer(ctx.db, { managerUserId: ctx.landlordId, phoneKey: who.phoneKey });
    const option = offer?.options[input.option - 1];
    if (!offer || !option) return { ok: false, error: "no_offer", message: "Those options expired. Quote the dates again." };
    if (!(await prepareStayOffer(ctx.db, { offerId: offer.id, index: input.option - 1, turn: turnOf(ctx) }))) {
      return { ok: false, error: "no_offer", message: "Those options expired. Quote the dates again." };
    }
    // The code travels only in this question, which goes to the phone that texted: a caller ID alone never books a stay.
    const code = await issueStayRequestCode(ctx.db, offer.id);
    if (!code) return { ok: false, error: "unavailable", message: "I could not set up the confirmation just now. A teammate will follow up." };
    const guests = `${option.guests} ${option.guests === 1 ? "guest" : "guests"}`;
    const confirmationQuestion = `${option.roomLabel} at ${option.homeName}, ${shortStayRangeLabel(option.checkIn, option.checkOut).replace(/\s*–\s*/, " to ")} (${option.nights} ${option.nights === 1 ? "night" : "nights"}, ${guests}): ${formatShortStayMoney(option.total)} total. ${stayRequestCodedLine(code)} The host has ${SHORT_STAY_HOLD_HOURS} hours to confirm, then I text you a link to pay. Nothing is charged until then.`;
    return { ok: true, confirmationQuestion, next: "Send confirmationQuestion exactly, then stop." };
  },
});

/* ───────────────────────────── book ───────────────────────────── */

const requestInput = z
  .object({ name: z.string().trim().min(1).max(120).optional().describe("The guest's name, only if they told you. Never guess one.") })
  .strict();

type RequestResult =
  | { ok: true; status: "hold" | "confirmed"; reply: string; retrySafe?: undefined }
  | { ok: false; error: string; message: string; retrySafe: true; sideEffects: "none"; total?: number };

const refused = (error: string, message: string, total?: number): RequestResult => ({ ok: false, error, message, retrySafe: true, sideEffects: "none", ...(total ? { total } : {}) });

export const requestShortStayTool = defineWriteTool<z.infer<typeof requestInput>, RequestResult, AgentContext>({
  name: "request_short_stay",
  description:
    "Book the stay the texter picked, ONLY after prepare_short_stay asked them to reply YES with its 4-digit code in an earlier text. It reads the code from their newest text itself (never pass or guess one); without the right code nothing is booked. It takes no room, date or price: it books the exact stored option. Send the returned reply verbatim. If it refuses, tell the texter what the message says and offer to re-quote.",
  inputSchema: requestInput,
  preview: async (ctx) => {
    const who = texter(ctx);
    const offer = who ? await loadLiveStayOffer(ctx.db, { managerUserId: ctx.landlordId, phoneKey: who.phoneKey }) : null;
    const option = offer && offer.selectedIndex !== null ? offer.options[offer.selectedIndex] : null;
    return {
      kind: "request_short_stay",
      title: "Request a short stay",
      fields: option
        ? [
            { label: "Home", value: `${option.roomLabel} at ${option.homeName}` },
            { label: "Dates", value: shortStayRangeLabel(option.checkIn, option.checkOut) },
            { label: "Total", value: formatShortStayMoney(option.total) },
          ]
        : [],
      warnings: [`The host has ${SHORT_STAY_HOLD_HOURS} hours to confirm. Nothing is charged by this request.`],
      confirmLabel: "Send stay request",
    };
  },
  handler: async (ctx, input): Promise<RequestResult> => {
    const who = texter(ctx);
    if (!who) return refused("sms_only", NOT_SMS.message);
    const offer = await loadLiveStayOffer(ctx.db, { managerUserId: ctx.landlordId, phoneKey: who.phoneKey });
    const option = offer && offer.status === "prepared" && offer.selectedIndex !== null ? offer.options[offer.selectedIndex] : null;
    if (!offer || !option) return refused("not_prepared", "No stay is waiting for a YES. Quote the dates and ask which option they want first.");
    if (!pickIsFromEarlierTurn(offer, { turn: turnOf(ctx) })) return refused("same_turn", "They have not answered the question yet. Send the confirmation question and wait for their YES.");

    // A caller ID is not an identity: the stay is requested only when the text repeats the code from the confirmation
    // question (sent to the phone that texted). A bare YES re-asks with a fresh code; three wrong codes cancel the offer.
    const coded = await confirmStayRequestCode(ctx.db, { offerId: offer.id, text: ctx.leasingScope?.currentInboundText ?? "", phone: who.phoneE164 });
    if (!coded.ok) {
      if (coded.error === "cancelled") await finishStayOffer(ctx.db, { offerId: offer.id, status: "superseded" });
      return refused(coded.error, coded.message);
    }

    if (!(await claimPreparedStayOffer(ctx.db, offer.id))) return refused("already_claimed", "That request was already sent.");
    let booked: Awaited<ReturnType<typeof bookStayForTexter>>;
    try {
      booked = await bookStayForTexter(ctx.db, { option, phone: who.phoneE164, name: input.name, offerId: offer.id, proof: coded.proof });
    } catch (error) {
      await finishStayOffer(ctx.db, { offerId: offer.id, status: "prepared" });
      throw error;
    }
    if (!booked.ok) {
      // Nothing was written: the pick stays usable for a retry or a re-quote.
      await finishStayOffer(ctx.db, { offerId: offer.id, status: "prepared" });
      return refused(booked.error, booked.message, booked.total);
    }
    await finishStayOffer(ctx.db, { offerId: offer.id, status: "booked", blockId: booked.blockId });
    if (ctx.leasingScope) {
      const { tagProspectThreadFromAgent } = await import("@/lib/sms/conversation-houses.server");
      await tagProspectThreadFromAgent(ctx.db, {
        landlordId: ctx.landlordId,
        prospectPhoneE164: ctx.leasingScope.prospectPhoneE164,
        channel: "sms",
        propertyId: option.propertyId,
        propertyOwnerUserId: null,
        source: "leasing",
      }).catch(() => undefined);
    }
    return { ok: true, status: booked.status, reply: booked.reply };
  },
});
