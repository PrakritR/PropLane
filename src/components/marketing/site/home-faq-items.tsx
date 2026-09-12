import Link from "next/link";
import type { SiteFaqItem } from "@/components/marketing/site/faq";

/**
 * The questions a prospect actually asks before signing up. Every answer is
 * grounded in what the product ships — plans + trial (`manager-plan-tiers.ts`,
 * `manager-signup-trial.ts`), the approval-first assistant (`docs/ai-assistant.md`),
 * resident setup-link onboarding (`api/auth/resident-setup`), and the iOS shell
 * (`docs/mobile-app.md`). Keep it that way: an FAQ reads as a promise, so don't
 * add a claim the code can't back.
 */
export const HOME_FAQ_ITEMS: SiteFaqItem[] = [
  {
    q: "What is PropLane?",
    a: "One place to run your rentals: list a home, take applications, book tours, sign leases, collect rent, and handle repairs and messages. Managers, residents, and your repair vendors each get their own sign-in.",
  },
  {
    q: "What does the AI actually do?",
    a: "It reads your live numbers and answers questions, and it drafts the things that eat your evenings — a reply, a lease from an application, a rent reminder, a vendor request. It never sends. Every draft shows exactly what it wrote, and it goes out only once you approve.",
  },
  {
    q: "Is there a free plan?",
    a: "Yes. Free is $0 with no card: one property listing, applications, tours and rent collection. Residents, leases, the inbox drafts and co-managers are on Pro and up.",
  },
  {
    q: "How much does it cost?",
    a: "Free is $0. Pro is $20 a month (up to 2 properties, plus residents, leases, and the inbox). Business is $200 a month (up to 20 properties and priority support). A year up front is two months free.",
  },
  {
    q: "Do I need a credit card to try it?",
    a: "No. Paid plans start with a 14-day trial and no card — you only add payment if you decide to keep it.",
  },
  {
    q: "How do my residents get in?",
    a: "You don't hand out passwords. When someone applies, PropLane emails them a one-time link — tied to the same email they applied with — to set up their own account. Once you approve them, they can pay rent, sign leases, and message you.",
  },
  {
    q: "Can I use it on my phone?",
    a: (
      <>
        Yes. PropLane opens in any web browser on a computer, tablet, or phone — no download needed. There is also a{" "}
        <Link href="/app" className="font-semibold text-primary hover:underline">
          native iPhone app
        </Link>{" "}
        with the same queue, push notifications, and camera uploads.
      </>
    ),
  },
];
