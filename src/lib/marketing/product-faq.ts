import { RATE_CARD, annualDiscountPercent, formatRateCardUsd } from "@/lib/billing/rate-card";
import { MANAGER_SUBSCRIPTION_TRIAL_DAYS } from "@/lib/stripe/subscription-checkout-session";

/** Shared product questions for Pricing, its JSON-LD and the plain-text crawl surface. */
export const PRODUCT_FAQ_ITEMS: { q: string; a: string }[] = [
  { q: "What is PropLane?", a: "Software to run your rentals, and a team that can manage them for you. List homes, take applications, book tours, sign leases, collect rent, and handle services and messages in one place." },
  { q: "What does the AI actually do?", a: "It answers questions from your records and helps with messages and services. Changes proposed through the assistant wait for your confirmation. Enabled automations and inbound text replies follow their own configured rules." },
  { q: "Is there a free plan?", a: `Yes. Free starts at ${formatRateCardUsd(RATE_CARD.free.floorMonthlyCents)} with no card and includes ${RATE_CARD.free.includedDoors} residents, applications, tours and rent collection.` },
  { q: "How much does it cost?", a: `Pro starts at ${formatRateCardUsd(RATE_CARD.pro.floorMonthlyCents)} a month with ${RATE_CARD.pro.includedDoors} residents included. Business starts at ${formatRateCardUsd(RATE_CARD.business.floorMonthlyCents)} a month with ${RATE_CARD.business.includedDoors} residents included. Annual billing saves ${annualDiscountPercent("pro")}% on Pro and ${annualDiscountPercent("business")}% on Business. Managed service is quoted per home.` },
  { q: "Do I need a credit card to try it?", a: `No. Paid plans start with a ${MANAGER_SUBSCRIPTION_TRIAL_DAYS}-day trial and no card. Add payment details if you decide to keep a paid plan.` },
  { q: "How do my residents get in?", a: "Residents use their own sign-in and receive links for applications, leases and payments. Their portal access follows their application and lease stage." },
  { q: "How do we move our portfolio into PropLane?", a: "Upload a spreadsheet, an export from your current software, or a rent-roll PDF. Review the imported properties, rooms and residents before creating them." },
  { q: "Can I use it on my phone?", a: "Yes. PropLane works in a web browser on a computer, tablet or phone. The iPhone app uses the same product, with push notifications and camera uploads." },
];
