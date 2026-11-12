import { describe, expect, it } from "vitest";

import { parseChannelFinanceEmail } from "@/lib/channel-finance/email-parsers";
import { previewChannelCsv } from "@/lib/channel-finance/csv-import";
import { matchFinanceFacts, type FinanceRoomCandidate } from "@/lib/channel-finance/match";
import { channelIncomeRows, directRentFromLedger, rollupChannelIncome } from "@/lib/channel-finance/income";
import { moneyToCents, readDate } from "@/lib/channel-finance/money-dates";
import { gmailFilterQuery } from "@/lib/channel-finance/gmail-filter";
import type { ChannelFinanceRecord } from "@/lib/channel-finance/types";

const AIRBNB_CONFIRMED = {
  subject: "Reservation confirmed - Juan Angel arrives Oct 7",
  text: `Reservation confirmed
Juan Angel is arriving Oct 7
Confirmation code: HMABC12345
Check-in
Wed, Oct 7, 2026
Check-out
Sun, Oct 11, 2026
4 nights
Guest paid $480.00
Host service fee -$14.40
You earn $465.60`,
  receivedAt: "2026-09-20T10:00:00Z",
};
const AIRBNB_PAYOUT = {
  subject: "Your payout of $465.60 was sent",
  text: `We've sent your payout
Payout for Juan's stay HMABC12345
Check-in: Oct 7, 2026
Check-out: Oct 11, 2026
Guest paid $480.00
Host service fee -$14.40
Total payout $465.60
Payout date: Oct 8, 2026`,
  receivedAt: "2026-10-08T15:00:00Z",
};
const BOOKING_RESERVATION = {
  subject: "New booking! (1234567890, Tue 14 Oct 2026)",
  text: `You have a new reservation
Reservation number: 1234567890
Guest name: Maria Lopez
Property: 5257 Brooklyn Ave Room 6
Check-in: Oct 14, 2026
Check-out: Oct 17, 2026
Total price: US$ 300.00
Commission: US$ 45.00 (15%)`,
  receivedAt: "2026-09-30T10:00:00Z",
};
const BOOKING_PAYOUT = {
  subject: "Payout sent for reservation 1234567890",
  text: `Your payout has been sent
Reservation number: 1234567890
Total price: US$ 300.00
Commission: US$ 45.00
Payment service fee: US$ 6.00
Payout amount: US$ 249.00
Payout date: 2026-10-20`,
  receivedAt: "2026-10-20T08:00:00Z",
};

describe("money and dates", () => {
  it("reads exact cents and refuses ambiguous formats", () => {
    expect(moneyToCents("$1,234.56")).toBe(123456);
    expect(moneyToCents("US$ 12")).toBe(1200);
    expect(moneyToCents("(12.50)")).toBe(-1250);
    expect(moneyToCents("0.1")).toBe(10);
    expect(moneyToCents("1.234,56")).toBeNull();
    expect(moneyToCents("abc")).toBeNull();
  });
  it("reads dates", () => {
    expect(readDate("10/05/2026")).toBe("2026-10-05");
    expect(readDate("Tue, Oct 5, 2026")).toBe("2026-10-05");
    expect(readDate("13/45/2026")).toBeNull();
  });
});

describe("email parsers", () => {
  it("airbnb reservation confirmed: facts + cross-checked money", () => {
    const r = parseChannelFinanceEmail({ platform: "airbnb", ...AIRBNB_CONFIRMED });
    expect(r.status).toBe("parsed");
    if (r.status !== "parsed") return;
    expect(r.facts).toMatchObject({ kind: "reservation", confirmationCode: "HMABC12345", checkIn: "2026-10-07", checkOut: "2026-10-11", grossCents: 48000, hostFeeCents: 1440, payoutCents: 46560 });
    expect(r.certain).toBe(true);
    expect(r.crossChecked).toBe(true);
  });
  it("airbnb payout sent", () => {
    const r = parseChannelFinanceEmail({ platform: "airbnb", ...AIRBNB_PAYOUT });
    expect(r.status).toBe("parsed");
    if (r.status !== "parsed") return;
    expect(r.facts).toMatchObject({ kind: "payout", payoutCents: 46560, paidOn: "2026-10-08" });
    expect(r.crossChecked).toBe(true);
  });
  it("booking.com reservation and payout (fee = commission + payment fee)", () => {
    const a = parseChannelFinanceEmail({ platform: "booking_com", ...BOOKING_RESERVATION });
    expect(a.status === "parsed" && a.facts).toMatchObject({ kind: "reservation", confirmationCode: "1234567890", grossCents: 30000, hostFeeCents: 4500, checkIn: "2026-10-14", checkOut: "2026-10-17", listingHint: "5257 Brooklyn Ave Room 6" });
    const b = parseChannelFinanceEmail({ platform: "booking_com", ...BOOKING_PAYOUT });
    expect(b.status).toBe("parsed");
    if (b.status !== "parsed") return;
    expect(b.facts).toMatchObject({ kind: "payout", grossCents: 30000, hostFeeCents: 5100, payoutCents: 24900, paidOn: "2026-10-20" });
    expect(b.crossChecked).toBe(true);
  });
  it("never guesses an amount: one unlabelled dollar sign is not a payout", () => {
    const r = parseChannelFinanceEmail({ platform: "airbnb", subject: "Your payout was sent", text: "We've sent your payout for HMABC12345. It should arrive soon. $465.60" });
    expect(r.status === "parsed" && r.facts.payoutCents).toBeUndefined();
    expect(r.status === "parsed" && r.certain).toBe(false);
  });
  it("different values under one label, a foreign currency, or numbers that do not add up are uncertain", () => {
    const twice = parseChannelFinanceEmail({ platform: "airbnb", subject: "Payout sent", text: "Payout HMABC12345\nTotal payout $100.00\nTotal payout $120.00" });
    expect(twice.status === "parsed" && twice.certain).toBe(false);
    const eur = parseChannelFinanceEmail({ platform: "booking_com", subject: "Payout sent", text: "Reservation number: 1234567890\nPayout amount: €200.00" });
    expect(eur.status === "parsed" && eur.certain).toBe(false);
    const off = parseChannelFinanceEmail({ platform: "airbnb", subject: "Payout sent", text: "Payout HMABC12345\nGuest paid $480.00\nHost service fee $14.40\nTotal payout $400.00" });
    expect(off.status === "parsed" && off.certain).toBe(false);
    expect(off.status === "parsed" && off.reasons.join()).toMatch(/do not add up/);
  });
  it("a guest message or a mail with no code is never a record", () => {
    expect(parseChannelFinanceEmail({ platform: "booking_com", subject: "New message from Maria", text: "Reservation number: 1234567890 payout" }).status).toBe("not_finance");
    expect(parseChannelFinanceEmail({ platform: "airbnb", subject: "Payout sent", text: "Total payout $10.00" }).status).toBe("unreadable");
  });
});

const csvAirbnb = `Date,Type,Confirmation Code,Start date,End date,Nights,Guest,Listing,Details,Reference,Currency,Amount,Paid out,Service fee,Gross earnings,Occupancy taxes
10/08/2026,Reservation,HMABC12345,10/07/2026,10/11/2026,4,Juan Angel,5257 Brooklyn Ave Room 6,,,USD,465.60,465.60,14.40,480.00,0.00
10/08/2026,Payout,,,,,,,Transfer to bank,,USD,,465.60,,,
10/09/2026,Reservation,HMXYZ98765,10/20/2026,10/18/2026,,Bad Dates,Room 2,,,USD,100.00,100.00,3.00,103.00,
10/09/2026,Reservation,HMNOPE00001,10/20/2026,10/22/2026,2,Bad Money,Room 2,,,USD,"1.234,56",,3.00,103.00,
10/10/2026,Reservation,HMABC12345,10/07/2026,10/11/2026,4,Juan Angel,5257 Brooklyn Ave Room 6,,,USD,465.60,465.60,14.40,480.00,0.00
10/10/2026,Reservation,HMFUT00002,11/20/2026,11/22/2026,2,Future Guest,Room 3,,,USD,200.00,0,6.00,206.00,
`;
const csvBookingPayouts = `Type,Reservation number,Check-in date,Check-out date,Guest name,Gross amount,Commission,Payment service fee,Net amount,Payout date,Currency
Reservation,1234567890,2026-10-14,2026-10-17,Maria Lopez,300.00,45.00,6.00,249.00,2026-10-20,USD
Reservation,1234567891,2026-10-18,2026-10-19,Sam Kim,100.00,15.00,2.00,83.00,not a date,USD
Payout,,,,,,,,249.00,2026-10-20,USD
`;
const csvBookingReservations = `Book number,Booked by,Guest name(s),Check-in,Check-out,Status,Price,Commission %,Commission amount,Payment status,Currency
1234567890,Maria,Maria Lopez,2026-10-14,2026-10-17,ok,300.00,15%,45.00,paid,USD
1234567892,Pat,Pat Roe,2026-10-20,2026-10-21,cancelled_by_guest,80.00,15%,12.00,,USD
`;

describe("csv import", () => {
  it("airbnb transaction history: ready rows, per-row errors, skips, in-file duplicate", () => {
    const p = previewChannelCsv("airbnb", csvAirbnb);
    expect(p.fatal).toBeNull();
    const codes = p.rows.map((r) => r.facts.confirmationCode);
    expect(codes).toEqual(["HMABC12345", "HMFUT00002"]);
    expect(p.rows[0]!.facts).toMatchObject({ kind: "payout", grossCents: 48000, hostFeeCents: 1440, payoutCents: 46560, paidOn: "2026-10-10", checkIn: "2026-10-07", checkOut: "2026-10-11" });
    expect(p.rows[1]!.facts.paidOn).toBeUndefined();
    expect(p.errors.map((e) => e.line).sort()).toEqual([4, 5]);
    expect(p.skipped.some((s) => /Payout/.test(s.reason))).toBe(true);
    expect(p.skipped.some((s) => /Duplicate/.test(s.reason))).toBe(true);
  });
  it("booking.com payouts export", () => {
    const p = previewChannelCsv("booking_com", csvBookingPayouts);
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0]!.facts).toMatchObject({ kind: "payout", grossCents: 30000, hostFeeCents: 5100, payoutCents: 24900, paidOn: "2026-10-20" });
    expect(p.errors).toHaveLength(1);
    expect(p.errors[0]!.line).toBe(3);
  });
  it("booking.com reservations export: reservation kind, cancelled skipped, tolerant headers", () => {
    const p = previewChannelCsv("booking_com", csvBookingReservations);
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0]!.facts).toMatchObject({ kind: "reservation", grossCents: 30000, hostFeeCents: 4500 });
    expect(p.skipped).toHaveLength(1);
  });
  it("a wrong file is a fatal message, not a crash", () => {
    expect(previewChannelCsv("airbnb", "a,b\n1,2\n").fatal).toMatch(/Confirmation Code/);
  });
});

const candidates: FinanceRoomCandidate[] = [
  { propertyId: "p1", propertyLabel: "5257 Brooklyn Ave", roomId: "r6", roomLabel: "Room 6", reservationCodes: ["HMABC12345"], connectionId: "c6", ranges: [{ code: "HMABC12345", start: "2026-10-07", end: "2026-10-10", sourceUid: "uid-6" }] },
  { propertyId: "p1", propertyLabel: "5257 Brooklyn Ave", roomId: "r7", roomLabel: "Room 7", reservationCodes: [], connectionId: "c7", ranges: [{ code: null, start: "2026-10-14", end: "2026-10-16", sourceUid: "uid-7" }] },
  { propertyId: "p2", propertyLabel: "4709A 8th Ave", roomId: "r1", roomLabel: "Room 1", reservationCodes: [], connectionId: "c1", ranges: [{ code: null, start: "2026-10-14", end: "2026-10-16", sourceUid: "uid-1" }] },
];

describe("matching", () => {
  const facts = (over: object) => ({ platform: "airbnb" as const, kind: "payout" as const, confirmationCode: "X", currency: "USD", ...over });
  it("by code onto the synced stay", () => {
    expect(matchFinanceFacts(facts({ confirmationCode: "HMABC12345" }), candidates)).toMatchObject({ roomId: "r6", sourceUid: "uid-6", via: "reservation_code" });
  });
  it("by unique dates; ambiguous dates are no match; a contradicting listing blocks it", () => {
    expect(matchFinanceFacts(facts({ checkIn: "2026-10-07", checkOut: "2026-10-11" }), candidates)).toMatchObject({ roomId: "r6", via: "dates" });
    expect(matchFinanceFacts(facts({ checkIn: "2026-10-14", checkOut: "2026-10-17" }), candidates)).toBeNull();
    expect(matchFinanceFacts(facts({ checkIn: "2026-10-14", checkOut: "2026-10-17", listingHint: "4709A 8th Ave Room 1" }), candidates)).toMatchObject({ propertyId: "p2", roomId: "r1" });
  });
  it("no evidence = null (filed Needs a room)", () => {
    expect(matchFinanceFacts(facts({ checkIn: "2027-01-01", checkOut: "2027-01-03" }), candidates)).toBeNull();
  });
});

const rec = (over: Partial<ChannelFinanceRecord>): ChannelFinanceRecord => ({
  id: "i", platform: "airbnb", kind: "payout", confirmationCode: "HMA", propertyId: "p1", propertyLabel: "5257 Brooklyn Ave", roomId: "r6", roomLabel: "Room 6", connectionId: null, sourceUid: null,
  guestLabel: "Juan", checkIn: "2026-10-07", checkOut: "2026-10-11", grossCents: 48000, hostFeeCents: 1440, taxCents: null, payoutCents: 46560, currency: "USD", paidAt: "2026-10-08T12:00:00Z", source: "email", reviewStatus: "ok", ...over,
});

describe("income report", () => {
  it("merges kinds per booking, dedupes the legacy stay payout, counts only paid, flags overdue / needs room / review", () => {
    const rows = channelIncomeRows({
      today: "2026-11-12",
      records: [
        rec({ id: "1", connectionId: "c6", sourceUid: "uid-6" }),
        rec({ id: "2", kind: "reservation", confirmationCode: "HMB", paidAt: null, payoutCents: null, checkIn: "2026-10-01", checkOut: "2026-10-05" }),
        rec({ id: "3", platform: "booking_com", confirmationCode: "999", paidAt: null, checkOut: "2026-11-01", reviewStatus: "ok" }),
        rec({ id: "4", confirmationCode: "HMC", roomId: null, propertyId: null, reviewStatus: "needs_room" }),
        rec({ id: "5", confirmationCode: "HMD", reviewStatus: "needs_review" }),
      ],
      stayPayouts: [{ id: "airbnb:c6:uid-6", connectionId: "c6", sourceUid: "uid-6", propertyId: "p1", propertyLabel: "5257", roomLabel: "Room 6", guestLabel: "J", start: "2026-10-07", end: "2026-10-10", payoutCents: 46560, paidAt: "2026-10-08T00:00:00Z" }],
    });
    expect(rows).toHaveLength(5);
    const by = (code: string) => rows.find((r) => r.confirmationCode === code)!;
    expect(by("HMA").status).toBe("paid");
    expect(by("HMB").status).toBe("overdue");
    expect(by("999").status).toBe("pending");
    expect(by("HMC").status).toBe("needs_room");
    expect(by("HMD").status).toBe("needs_review");
    const { grand, lines } = rollupChannelIncome(rows, [{ propertyId: "p1", propertyLabel: "5257 Brooklyn Ave", roomLabel: "Room 6", month: "2026-10", cents: 100000 }], { groupBy: "house" });
    expect(grand.airbnb).toMatchObject({ payoutCents: 46560, grossCents: 48000, feeCents: 1440, count: 1 });
    expect(grand.directRentCents).toBe(100000);
    expect(grand.totalCents).toBe(146560);
    expect(lines).toHaveLength(1);
    expect(rollupChannelIncome(rows, [], { groupBy: "month" }).lines[0]!.key).toBe("2026-10");
  });
  it("direct rent reads paid rent rows only, never channel payouts", () => {
    const base = { propertyName: "H", amountPaid: "$1,000.00", dueDateSortMs: Date.UTC(2026, 9, 5), bucket: "paid" };
    expect(directRentFromLedger([{ ...base, chargeKind: "rent" }, { ...base, chargeKind: "airbnb_payout" }, { ...base, chargeKind: "rent", bucket: "pending" }])).toHaveLength(1);
  });
});

describe("gmail filter", () => {
  it("names the real senders", () => {
    expect(gmailFilterQuery("airbnb")).toContain("automated@airbnb.com");
    expect(gmailFilterQuery("booking_com")).toContain("@booking.com");
  });
});
