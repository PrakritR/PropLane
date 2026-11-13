import { FINANCE_PLATFORM_LABEL, type FinancePlatform } from "./types";

/**
 * The hosts' one-time Gmail filter that forwards a channel's money mail to the workspace address. Sender addresses: Airbnb
 * publishes automated@ / express@ / response@airbnb.com as its legitimate senders (airbnb.com help, "Is this email from
 * Airbnb"). Booking.com publishes no sender list; its partner mail comes from booking.com addresses (noreply@booking.com is
 * the one seen in public reports), so the filter matches the domain. Receiving is still gated on DKIM/SPF of the ORIGINAL
 * sender, so a look-alike address in the filter does nothing.
 */
export const FINANCE_GMAIL_FILTER: Record<FinancePlatform, { from: string; subject: string }> = {
  airbnb: {
    from: "automated@airbnb.com OR express@airbnb.com OR response@airbnb.com",
    subject: "reservation OR booking OR payout OR confirmed OR paid",
  },
  booking_com: {
    from: "@booking.com",
    subject: "reservation OR booking OR payout OR payment OR invoice",
  },
};

export function gmailFilterQuery(platform: FinancePlatform): string {
  const f = FINANCE_GMAIL_FILTER[platform];
  return `from:(${f.from}) subject:(${f.subject})`;
}

export function gmailFilterInstructions(platform: FinancePlatform, workAddress: string): string {
  return [
    `Gmail > Settings > See all settings > Filters and Blocked Addresses > Create a new filter.`,
    `Paste in the search box: ${gmailFilterQuery(platform)}`,
    `Create filter > Forward it to: ${workAddress || "your PropLane work email"} (Gmail asks you to confirm that address once).`,
    `${FINANCE_PLATFORM_LABEL[platform]} reservation and payout mail then reaches PropLane on its own.`,
  ].join("\n");
}
