/**
 * Booking-channel finances: what Airbnb and Booking.com pay the host, read from the host's forwarded notification mail or an
 * uploaded CSV export. REPORTING data only - income a channel pays, never a resident charge, never a party-ledger movement
 * (docs/agents/owner-management.md says nothing about channel income, so it stays out of the managed-workspace money model).
 */
export const FINANCE_PLATFORMS = ["airbnb", "booking_com"] as const;
export type FinancePlatform = (typeof FINANCE_PLATFORMS)[number];
export const FINANCE_PLATFORM_LABEL: Record<FinancePlatform, string> = { airbnb: "Airbnb", booking_com: "Booking.com" };

/** `reservation` = booked (gross, fee, expected payout); `payout` = money the channel says it paid out. */
export type FinanceKind = "reservation" | "payout";
export type FinanceReviewStatus = "ok" | "needs_room" | "needs_review";

/** Everything one mail or CSV row says. Cents are integers; a field the source did not state is absent, never zero. */
export type ChannelFinanceFacts = {
  platform: FinancePlatform;
  kind: FinanceKind;
  confirmationCode: string;
  guestLabel?: string;
  /** The listing / property name as the channel prints it, matched to a house and room later. */
  listingHint?: string;
  /** YYYY-MM-DD */
  checkIn?: string;
  /** YYYY-MM-DD (check-out day) */
  checkOut?: string;
  grossCents?: number;
  hostFeeCents?: number;
  taxCents?: number;
  payoutCents?: number;
  currency: string;
  /** YYYY-MM-DD the payout was sent / landed. */
  paidOn?: string;
};

export type ChannelFinanceRecord = {
  id: string;
  platform: FinancePlatform;
  kind: FinanceKind;
  confirmationCode: string;
  propertyId: string | null;
  propertyLabel: string | null;
  roomId: string | null;
  roomLabel: string | null;
  connectionId: string | null;
  sourceUid: string | null;
  guestLabel: string | null;
  checkIn: string | null;
  checkOut: string | null;
  grossCents: number | null;
  hostFeeCents: number | null;
  taxCents: number | null;
  payoutCents: number | null;
  currency: string;
  paidAt: string | null;
  source: "email" | "csv";
  reviewStatus: FinanceReviewStatus;
};

/** Parsers built from documented formats, none yet checked against a real forwarded mail. Flip only after one real sample passes. */
export const CHANNEL_FINANCE_PARSER_VERIFIED: Record<FinancePlatform, boolean> = { airbnb: false, booking_com: false };

/** `CHANNEL_FINANCE_PARSERS=airbnb,booking_com`: the unverified parsers the captain has switched on for auto-confirm. */
export function enabledFinanceParsers(env: string | undefined = process.env.CHANNEL_FINANCE_PARSERS): ReadonlySet<FinancePlatform> {
  const wanted = new Set((env ?? "").split(",").map((part) => part.trim().toLowerCase()).filter(Boolean));
  return new Set(FINANCE_PLATFORMS.filter((p) => wanted.has(p)));
}
