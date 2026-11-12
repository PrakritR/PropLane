import { describe, expect, it } from "vitest";
import {
  PROSPECT_INTENTS,
  classifyProspectIntents,
  composeFirstReply,
  composeProspectReply,
  ensureProspectReplyLinks,
  finalizeProspectReply,
  identifyHome,
  prospectContextFromEvidence,
  prospectIntentPlaybook,
  smsSegmentsOf,
  type PickableHome,
  type ProspectLinks,
  type ProspectReplyFacts,
} from "./support/prospect-reply-helpers";
import { isGsm7 } from "@/lib/one-number/segments";

/**
 * Fixtures are the real thing: the three Ambika Seattle houses with their real production property ids and listing
 * slugs (the slugs are legacy copy-names that look SWAPPED: 4709A carries a "5259-brooklyn" slug and 5259 a "5257" one,
 * so a link must be chosen by property id, never by the text of the slug), and the questions prospects really asked
 * (Zillow, Roomies, SpareRoom, Facebook, Craigslist and the 206 line, Nov 9-12 2026).
 */
const ORIGIN = "https://proplane.ai";

function links(id: string, slug: string): ProspectLinks {
  return {
    listing: `${ORIGIN}/rent/listings/${slug}`,
    tour: `${ORIGIN}/rent/tours-contact?propertyId=${id}`,
    apply: `${ORIGIN}/rent/apply?propertyId=${id}`,
    stay: `${ORIGIN}/resident/applications/stay?listing=${id}`,
    message: `${ORIGIN}/rent/tours-contact?propertyId=${id}&tab=message`,
    browse: `${ORIGIN}/rent/browse`,
  };
}

function facts(title: string, over: Partial<ProspectReplyFacts>): ProspectReplyFacts {
  return {
    title,
    neighborhood: "University District",
    rooms: [
      { name: "Room 1", monthlyRent: 1000, flexiblePrice: false, furnishing: "Furnished single room", residentCapacity: 1 },
      { name: "Room 8", monthlyRent: 1200, flexiblePrice: false, furnishing: "Furnished single room", residentCapacity: 2 },
    ],
    roomCount: 10,
    availableNowCount: 3,
    leaseTerms: ["6-Month", "12-Month", "Month-to-Month"],
    shortStayOffered: true,
    securityDeposit: "$250",
    utilities: "included in rent",
    petFriendly: null,
    applicationFee: { free: true, amount: "$0" },
    ...over,
  };
}

function checkedRooms(spec: Array<[string, number, string | null]>) {
  // [name, rent, first free day]: "now" is today (2026-11-12); a later date is a room that frees up then.
  return spec.map(([name, monthlyRent, from]) => ({ name, monthlyRent, flexiblePrice: false, furnishing: "Furnished single room", residentCapacity: 1, freeNow: from === "now", freeFrom: from === "now" ? "2026-11-12" : from }));
}

const H4709: PickableHome = {
  propertyId: "mgr-5259-brooklyn-ave-copy-9-rooms-7mdlyj0h2vfg",
  title: "4709A 8th Ave NE",
  links: links("mgr-5259-brooklyn-ave-copy-9-rooms-7mdlyj0h2vfg", "mgr-5259-brooklyn-ave-copy-9-rooms-7mdlyj0h2vfg"),
  facts: facts("4709A 8th Ave NE", { rooms: [...checkedRooms([["Room 6", 1000, "now"], ["Room 9", 1000, "now"], ["Room 4", 1000, "2026-11-28"]]), { name: "Room 8", monthlyRent: 1200, flexiblePrice: false, furnishing: "Furnished single room", residentCapacity: 2, freeNow: false, freeFrom: null }] }),
};
const H5257: PickableHome = {
  propertyId: "mgr-listing-1x3tiu0489ha",
  title: "5257 Brooklyn Ave NE",
  links: links("mgr-listing-1x3tiu0489ha", "mgr-listing-1x3tiu0489ha"),
  // This listing's occupancy read failed: the count is unverified and the reply must say so, never a number.
  facts: facts("5257 Brooklyn Ave NE", { roomCount: 9, availableNowCount: null, rooms: checkedRooms([["Room 2", 1050, "now"], ["Room 5", 1050, "now"], ["Room 6", 1050, "2026-11-30"]]) }),
};
const H5259: PickableHome = {
  propertyId: "mgr-5257-brooklyn-ave-copy-9-rooms-7mbwr0uza0nq",
  title: "5259 Brooklyn Ave NE",
  links: links("mgr-5257-brooklyn-ave-copy-9-rooms-7mbwr0uza0nq", "mgr-5257-brooklyn-ave-copy-9-rooms-7mbwr0uza0nq"),
  facts: facts("5259 Brooklyn Ave NE", { roomCount: 9, availableNowCount: 2, rooms: checkedRooms([["Room 3", 1050, "now"], ["Room 1", 1050, "2026-11-29"]]) }),
};
const HOMES = [H4709, H5257, H5259];
const BROWSE = `${ORIGIN}/rent/browse`;

type Fixture = {
  /** Where the prospect wrote from, for the reader. */
  from: string;
  say: string;
  /** The listing the prospect came from, when the platform tells us. */
  known?: PickableHome;
  /** The home the reply must be about; "ask" = the one question; "browse" = no home. */
  about: PickableHome | "ask" | "rundown" | "browse";
  /** Pages that MUST ride the reply (each is one of the home's own minted links). */
  has: Array<"listing" | "tour" | "apply" | "stay" | "message">;
  contains?: string[];
  never?: RegExp[];
  tight?: boolean;
};

const FIXTURES: Fixture[] = [
  { from: "Roomies (Raunak)", say: "Hi, is this room still available?", known: H4709, about: H4709, has: ["tour", "apply", "listing"], contains: ["3 of 10 rooms"] },
  { from: "Zillow lead", say: "Is this still available?", about: "rundown", has: [], contains: ["4709A 8th Ave NE (from $1,000/mo): Rooms 6 and 9 now, Room 4 Nov 28.", "5257 Brooklyn Ave NE ($1,050/mo): Rooms 2 and 5 now, Room 6 Nov 30.", "5259 Brooklyn Ave NE ($1,050/mo): Room 3 now, Room 1 Nov 29.", "Which one are you interested in?"] },
  { from: "Zillow lead (Raul)", say: "hi is the 5259 room still available?", about: H5259, has: ["tour", "apply", "listing"], contains: ["2 of 9 rooms"] },
  { from: "Facebook seeker", say: "I'm interested in the Brooklyn house", about: "ask", has: [] },
  { from: "SpareRoom", say: "Hi, interested in room 9 at 8th Ave, is it still free Nov 16?", about: H4709, has: ["tour", "apply", "listing"] },
  { from: "Craigslist relay", say: "do you have anything near UW under $1,100", about: "rundown", has: [] },
  { from: "Facebook Marketplace (Ikshita)", say: "Hello please share more details of accommodation along with photos or videos", about: "rundown", has: [], contains: ["Rooms 6 and 9 now"] },
  { from: "5259 Q&A", say: "Does the $250 deposit apply to a one night stay? And is 8:30pm arrival ok?", known: H5259, about: H5259, has: ["stay", "listing"], contains: ["$250", "arrival and check-in"], never: [/\bat 8:30/i] },
  { from: "Facebook seeker (Gwen)", say: "Moving to Seattle, want Dec 1 to Jan 1 near transit, budget up to $1,300", known: H4709, about: H4709, has: ["listing"], contains: ["$1,000 to $1,200/mo"], never: [/\b\d+ ?(min|minute)s? (walk|away)/i] },
  { from: "Facebook seeker (Shira)", say: "need a non-smoking no pets house, I commute to Redmond", known: H4709, about: H4709, has: ["listing"], contains: ["confirm"], never: [/pets are (welcome|fine|ok)/i, /no pets/i] },
  { from: "Facebook seeker (Nayan)", say: "my budget is $700-1000, is there anything at that price?", known: H5257, about: H5257, has: ["listing"], contains: ["$1,050/mo"], never: [/\$700|\$900/] },
  { from: "Booking.com guest", say: "Can I get an invoice for my employer?", known: H5259, about: H5259, has: ["listing"], contains: ["cancellation and refunds"], never: [/\b(yes|we can|will be emailed)\b/i] },
  { from: "Airbnb inquiry (Thomas)", say: "any discount if I leave a review? and are the sheets clean?", known: H5257, about: H5257, has: ["listing"], contains: ["house rules"], never: [/\bdiscount (is|of)\b/i, /%/] },
  { from: "206 line", say: "how do I book a tour", known: H4709, about: H4709, has: ["tour"] },
  { from: "206 line", say: "do you do nightly stays? I saw $55", known: H4709, about: H4709, has: ["stay"], never: [/\$55/] },
  { from: "206 line", say: "is there an application fee", known: H5257, about: H5257, has: ["apply"], contains: ["free"] },
  { from: "206 line", say: "what do I need to apply, any income requirement?", known: H5257, about: H5257, has: ["apply"], contains: ["Apply (free)"] },
  { from: "206 line", say: "is it furnished and are utilities and wifi included?", known: H4709, about: H4709, has: ["listing"], contains: ["Furnished single room", "included in rent"] },
  { from: "206 line", say: "is there parking or a bike room", known: H4709, about: H4709, has: ["listing"], contains: ["confirm parking"], never: [/\b(yes|garage|free parking)\b/i] },
  { from: "206 line", say: "can my partner and I share room 8?", known: H4709, about: H4709, has: ["listing"], contains: ["Room 8 is listed for 2 or more residents"] },
  { from: "206 line", say: "how long is the lease, can I do month to month", known: H5259, about: H5259, has: ["listing"], contains: ["Month-to-Month"] },
  { from: "206 line", say: "can I see pictures of 4709", about: H4709, has: ["listing"] },
  { from: "206 line", say: "what other houses do you have", about: "browse", has: [], contains: [BROWSE], tight: true },
  { from: "206 line", say: "I'd like to talk to the manager about the 5257 house", about: H5257, has: ["message", "tour"] },
];

function allowedNumbers(home: PickableHome | null): Set<string> {
  const out = new Set<string>(["2", "3"]);
  const add = (value: unknown) => {
    for (const match of String(value ?? "").replace(/,/g, "").matchAll(/\d+/g)) out.add(match[0]);
  };
  for (const h of HOMES) add(h.title);
  if (home) add(JSON.stringify(home.facts));
  return out;
}

describe("first replies from the real prospect messages: right house, right links, no invented fact", () => {
  for (const fixture of FIXTURES) {
    it(`${fixture.from}: "${fixture.say}"`, () => {
      const reply = composeFirstReply({ message: fixture.say, homes: HOMES, knownPropertyId: fixture.known?.propertyId, browseUrl: BROWSE });
      const text = reply.text;
      const urls = [...text.matchAll(/https?:\/\/\S+/g)].map((m) => m[0]);

      if (fixture.about === "ask") {
        // Never a guess: one question naming the homes, and each home's OWN page keyed by its property id.
        expect(reply.pick.kind).toBe("ask");
        expect(text).toMatch(/^Which house are you asking about/);
        if (reply.pick.kind === "ask") {
          expect(reply.pick.candidates.length).toBeGreaterThanOrEqual(2);
          for (const home of reply.pick.candidates) expect(text).toContain(`${home.title}: ${home.links.listing}`);
        }
        expect(text).not.toMatch(/\$\d|available now/);
      } else if (fixture.about === "rundown") {
        // The captain's own answer, as several quick texts: one per house with ITS listing and tour page, then one question.
        expect(reply.bubbles.length).toBe(4);
        for (const bubble of reply.bubbles) expect(smsSegmentsOf(bubble), bubble).toBeLessThanOrEqual(3);
        for (const home of HOMES) {
          const bubble = reply.bubbles.find((b) => b.startsWith(home.title))!;
          expect(bubble, home.title).toContain(home.links.listing as string);
          expect(bubble).toContain(home.links.tour as string);
          for (const other of HOMES.filter((h) => h !== home)) expect(bubble).not.toContain(other.propertyId);
        }
        expect(text).not.toMatch(/This is PropLane|STOP|Which house are you asking about/);
      } else if (fixture.about === "browse") {
        expect(text).toContain(BROWSE);
        for (const home of HOMES) expect(text).not.toContain(home.links.tour as string);
      } else {
        expect(reply.pick.kind).toBe("one");
        const home = fixture.about;
        for (const kind of fixture.has) expect(text, `${kind} link`).toContain(home.links[kind] as string);
        // Every link in the reply belongs to THIS home (rotation check): no other house's id or listing page anywhere.
        for (const other of HOMES.filter((h) => h !== home)) {
          expect(text).not.toContain(other.propertyId);
          expect(text).not.toContain(other.links.listing as string);
        }
        for (const url of urls) expect(Object.values({ ...home.links, browse: BROWSE })).toContain(url);
      }

      for (const needle of fixture.contains ?? []) expect(text).toContain(needle);
      for (const pattern of fixture.never ?? []) expect(text).not.toMatch(pattern);

      // Canonical origin only; no phone number (the /rent web channel never carries one); plain, GSM-7, within 3 segments.
      for (const url of urls) expect(url.startsWith(`${ORIGIN}/`)).toBe(true);
      expect(text).not.toMatch(/localhost|127\.0\.0\.1|vercel\.app/);
      expect(text).not.toMatch(/\(?\b\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b/);
      expect(text).not.toMatch(/\*|^#|work order/im);
      expect(isGsm7(text)).toBe(true);
      expect(text).not.toMatch(/[–—]/);
      if (fixture.about !== "rundown") expect(smsSegmentsOf(text), text).toBeLessThanOrEqual(3);
      if (fixture.tight) expect(smsSegmentsOf(text), text).toBeLessThanOrEqual(2);

      // No number outside the facts it was given.
      const prose = text.replace(/https?:\/\/\S+/g, "");
      const allowed = allowedNumbers(fixture.about !== "ask" && fixture.about !== "browse" && fixture.about !== "rundown" ? fixture.about : null);
      if (fixture.about === "rundown") for (const home of HOMES) for (const match of JSON.stringify(home.facts).replace(/,/g, "").matchAll(/\d+/g)) allowed.add(match[0]);
      for (const match of prose.replace(/,/g, "").matchAll(/\d+/g)) expect(allowed.has(match[0]), `number ${match[0]} in "${prose}"`).toBe(true);
    });
  }

  it("covers at least twenty real messages and every registered intent", () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(20);
    const covered = new Set<string>();
    for (const fixture of FIXTURES) for (const id of classifyProspectIntents(fixture.say)) covered.add(id);
    for (const extra of ["photos", "browse", "human", "tour", "apply"]) covered.add(extra);
    const missing = PROSPECT_INTENTS.filter((def) => !covered.has(def.id)).map((def) => def.id);
    expect(missing).toEqual([]);
  });
});

describe("identifying the house", () => {
  it("a street number names the house, with or without the unit letter", () => {
    expect(identifyHome({ message: "is 4709 available", homes: HOMES })).toMatchObject({ kind: "one", via: "named", home: { propertyId: H4709.propertyId } });
    expect(identifyHome({ message: "4709a room 9", homes: HOMES })).toMatchObject({ kind: "one", home: { propertyId: H4709.propertyId } });
    expect(identifyHome({ message: "the 5257 place", homes: HOMES })).toMatchObject({ kind: "one", home: { propertyId: H5257.propertyId } });
  });

  it("a street that two houses share is a question, never a guess", () => {
    const pick = identifyHome({ message: "the one on Brooklyn", homes: HOMES });
    expect(pick.kind).toBe("ask");
    if (pick.kind === "ask") expect(pick.candidates.map((h) => h.propertyId).sort()).toEqual([H5257.propertyId, H5259.propertyId].sort());
  });

  it("a named house beats the listing the prospect came from", () => {
    expect(identifyHome({ message: "actually asking about 5259", homes: HOMES, knownPropertyId: H4709.propertyId })).toMatchObject({ kind: "one", home: { propertyId: H5259.propertyId } });
  });

  it("with no name and no known listing, every home is a candidate", () => {
    const pick = identifyHome({ message: "hi", homes: HOMES });
    expect(pick.kind).toBe("ask");
    if (pick.kind === "ask") expect(pick.candidates).toHaveLength(3);
  });

  it("the two-house question carries only the two houses' own pages", () => {
    const reply = composeFirstReply({ message: "interested in the Brooklyn house", homes: HOMES });
    expect(reply.text).toContain(H5257.links.listing as string);
    expect(reply.text).toContain(H5259.links.listing as string);
    expect(reply.text).not.toContain(H4709.links.listing as string);
  });
});

describe("the link guard on a reply the model wrote", () => {
  const links = H4709.links;

  it("appends the tour link the model forgot, from the tool's own links", () => {
    const out = ensureProspectReplyLinks({ reply: "Sure, weekends work. Pick whatever time suits you.", message: "Can I tour on Saturday?", links });
    expect(out.appended).toEqual(["tour"]);
    expect(out.text).toContain(links.tour);
  });

  it("never duplicates a link kind the reply already carries", () => {
    const reply = `Rooms run $1,000 to $1,200. Listing: ${links.listing}`;
    expect(ensureProspectReplyLinks({ reply, message: "how much is rent?", links })).toEqual({ text: reply, appended: [] });
  });

  it("adds at most two links and puts the action before the listing", () => {
    const out = ensureProspectReplyLinks({ reply: "Happy to help with all of that.", message: "I want to tour, apply, and see photos", links });
    expect(out.appended).toEqual(["tour", "apply"]);
  });

  it("never appends a link the tools did not return, or one a phone cannot open", () => {
    expect(ensureProspectReplyLinks({ reply: "Happy to help.", message: "can I tour?", links: {} }).appended).toEqual([]);
    const local = ensureProspectReplyLinks({ reply: "Happy to help.", message: "can I tour?", links: { tour: "http://localhost:3002/rent/tours-contact?propertyId=x" } });
    expect(local.appended).toEqual([]);
  });

  it("leaves a booking confirmation question and an empty quiet-handoff reply alone", () => {
    expect(ensureProspectReplyLinks({ reply: "Book Tue 2pm at 4709A 8th Ave NE? Reply YES to confirm.", message: "tue 2pm works for the tour", links }).appended).toEqual([]);
    expect(ensureProspectReplyLinks({ reply: "", message: "can I tour?", links })).toEqual({ text: "", appended: [] });
  });
});

describe("finalizing a model reply: the production bugs of Nov 9-12", () => {
  const links = H4709.links;

  it("(a) swaps another house's tour, apply and listing link for the matched home's, by property id", () => {
    const wrong = [`Tour: ${H5259.links.tour}`, `Apply: ${H5259.links.apply}`, `Listing: ${H5259.links.listing}`].join("\n");
    const out = finalizeProspectReply({ reply: `Here you go.\n${wrong}`, message: "how do I tour and apply", links });
    expect(out.text).toContain(links.tour);
    expect(out.text).toContain(links.apply);
    expect(out.text).toContain(links.listing);
    expect(out.text).not.toContain(H5259.propertyId);
    expect(out.text).not.toContain(H5259.links.listing as string);
    expect(out.changes).toContain("rotated_links");
  });

  it("(a) replaces a 'no tour slots' claim with the live tour page", () => {
    for (const claim of ["There are no tour slots currently published for this home.", "No tour times are available right now.", "Nothing is open for tours."]) {
      const out = finalizeProspectReply({ reply: `${claim} Anything else?`, message: "any tour times?", links });
      expect(out.text).not.toMatch(/no tour|no .*slots|nothing is open/i);
      expect(out.text).toContain(links.tour);
    }
  });

  it("(b) makes the reply plain text and drops a person's sign-off", () => {
    const out = finalizeProspectReply({ reply: "**Room 1** is $1,000/mo, *furnished*.\n- Ambika Mago", message: "how much is room 1", links });
    expect(out.text).not.toMatch(/\*/);
    expect(out.text).not.toMatch(/Ambika|Mago/);
    expect(out.text).toContain("Room 1 is $1,000/mo, furnished.");
    expect(out.changes).toEqual(expect.arrayContaining(["markdown", "sign_off"]));
  });

  it("(d) turns the retired /rent/tour address into the working tour page", () => {
    const out = finalizeProspectReply({ reply: `Book here: ${ORIGIN}/rent/tour`, message: "can I tour", links });
    expect(out.text).toContain(links.tour);
    expect(out.text).not.toMatch(/\/rent\/tour(?!s)/);
  });

  it("leaves a reply that lists several homes alone", () => {
    const reply = `4709A: ${H4709.links.listing}\n5259: ${H5259.links.listing}`;
    expect(finalizeProspectReply({ reply, message: "which houses do you have", links }).text).toBe(reply);
  });
});

describe("the intent registry is the one place a new canned intent is added", () => {
  it("every intent has patterns, a link, a topic, a hint, and shows up in the prompt playbook", () => {
    const playbook = prospectIntentPlaybook();
    for (const def of PROSPECT_INTENTS) {
      expect(def.patterns.length).toBeGreaterThan(0);
      expect(def.links.length).toBeGreaterThan(0);
      expect(def.topic).toBeTruthy();
      expect(playbook).toContain(def.hint);
    }
    expect(playbook).toMatch(/free unless get_listing_details says otherwise/);
    expect(playbook).toMatch(/never guess/);
  });

  it("an application-fee question is not also a price or an apply question", () => {
    expect(classifyProspectIntents("is there an application fee")).toEqual(["application_fee"]);
    expect(classifyProspectIntents("how much is the deposit")).toEqual(["deposit"]);
  });

  it("an empty or filler message selects nothing", () => {
    expect(classifyProspectIntents("")).toEqual([]);
    expect(classifyProspectIntents("ok thanks!")).toEqual([]);
  });
});

describe("facts and links are read from the turn's tool results only", () => {
  const evidence = [
    {
      tool: "get_listing_details",
      output: {
        found: true,
        listing: {
          propertyId: H4709.propertyId,
          title: "4709A 8th Ave NE",
          neighborhood: "University District",
          rooms: [
            { name: "Room 1", monthlyRent: 1000, pricingMode: "fixed", rentBasis: "monthly", furnishing: "Furnished", residentCapacity: 1 },
            { name: "Nightly room", monthlyRent: null, pricingMode: "fixed", rentBasis: "daily", furnishing: null, residentCapacity: 1 },
          ],
          roomCount: 10,
          availableNowCount: null,
          petFriendly: null,
          leaseTerms: { available: ["12-Month", "Short-Term Stay"] },
          securityDeposit: { listingAmount: "$250", rooms: [{ name: "Room 1", standardLeaseEffectiveAmount: "$250" }] },
          utilities: { costNotes: null, rooms: [{ name: "Room 1", estimate: null, paymentModel: "included_in_rent" }] },
          applicationFee: { amount: "$0", free: true },
        },
      },
    },
    { tool: "build_prospect_links", output: { ok: true, propertyId: H4709.propertyId, listingUrl: H4709.links.listing, tourUrl: H4709.links.tour, applyUrl: H4709.links.apply, messageUrl: H4709.links.message, browseUrl: BROWSE } },
  ];

  it("maps the tool output and leaves an unverified count and an unknown pet policy unknown", () => {
    const { facts: f, links: l } = prospectContextFromEvidence(evidence, ORIGIN);
    expect(f?.availableNowCount).toBeNull();
    expect(f?.petFriendly).toBeNull();
    expect(f?.rooms.map((r) => r.monthlyRent)).toEqual([1000, null]);
    expect(f?.leaseTerms).toEqual(["12-Month"]);
    expect(f?.shortStayOffered).toBe(true);
    expect(f?.utilities).toBe("included in rent");
    expect(l.stay).toBe(`${ORIGIN}/resident/applications/stay?listing=${H4709.propertyId}`);
    expect(l.tour).toBe(H4709.links.tour);
  });

  it("a reply built from it never says the room is available or pets are fine", () => {
    const { facts: f, links: l } = prospectContextFromEvidence(evidence, ORIGIN);
    const reply = composeProspectReply({ message: "is it available and do you allow pets?", facts: f, links: l });
    expect(reply.text).not.toMatch(/available now|welcome|no pets/i);
    expect(reply.text).toContain("confirm");
    expect(reply.text).toContain(H4709.links.listing as string);
  });

  it("ignores a failed lookup", () => {
    expect(prospectContextFromEvidence([{ tool: "get_listing_details", output: { ok: false, error: "x" } }], ORIGIN).facts).toBeNull();
  });
});

describe("the captain's voice", () => {
  it("opens with the first name when the line knows it, and never with a business preamble", () => {
    const reply = composeFirstReply({ message: "Is this still available?", homes: HOMES, firstName: "ikshita" });
    expect(reply.bubbles[0]).toMatch(/^Hi Ikshita! 4709A 8th Ave NE \(from \$1,000\/mo\): Rooms 6 and 9 now/);
    const one = composeFirstReply({ message: "how much is the 5259 room", homes: HOMES, firstName: "Ikshita" });
    expect(one.text).toMatch(/^Hi Ikshita! /);
    expect(`${reply.text}\n${one.text}`).not.toMatch(/This is PropLane|PropLane here|STOP|814|679-3694/);
  });

  it("a house whose availability could not be checked is left out of the rundown, never guessed", () => {
    const unchecked = { ...H5257, facts: { ...(H5257.facts as ProspectReplyFacts), rooms: (H5257.facts as ProspectReplyFacts).rooms.map((r) => ({ ...r, freeNow: null, freeFrom: null })) } };
    const reply = composeFirstReply({ message: "what's available?", homes: [H4709, unchecked, H5259] });
    expect(reply.text).not.toContain("5257 Brooklyn");
    expect(reply.bubbles).toHaveLength(3);
  });

  it("with nothing checked anywhere it asks which house instead of rundown-ing nothing", () => {
    const blank = HOMES.map((h) => ({ ...h, facts: { ...(h.facts as ProspectReplyFacts), rooms: [] } }));
    expect(composeFirstReply({ message: "is this available", homes: blank }).text).toMatch(/^Which house are you asking about/);
  });
});

describe("the guard removes the old robot openers and footers", () => {
  const links = H4709.links;
  it("strips 'Hi! This is PropLane.', 'PropLane here.' and a STOP footer from a conversational reply", () => {
    expect(finalizeProspectReply({ reply: "Hi! This is PropLane. Rooms are $1,000 to $1,200. Reply STOP to opt out.", message: "ok", links }).text).toBe("Rooms are $1,000 to $1,200.");
    expect(finalizeProspectReply({ reply: "PropLane here. Room 6 is open now.", message: "ok", links }).text).toBe("Room 6 is open now.");
  });
});
