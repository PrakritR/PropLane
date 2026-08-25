import type { Metadata } from "next";
import Link from "next/link";
import { PublicMobileBackBar } from "@/components/layout/public-mobile-back-bar";
import { SmsOptInForm } from "./sms-opt-in-form";

export const metadata: Metadata = {
  title: "SMS Consent",
  description:
    "Opt in to receive text messages from PropLane about your rental application and account. Message frequency varies, message and data rates may apply, reply STOP to opt out.",
};

/**
 * Public, no-login SMS opt-in / consent page.
 *
 * This is the URL an A2P 10DLC carrier reviewer opens cold to see how PropLane
 * collects SMS consent. It MUST stay reachable without any gate: no sign-in, no
 * manager link, no required query parameter. It is a plain server component so
 * every disclosure — sender, message topics, frequency, rates, STOP/HELP, and
 * the privacy/terms links — renders in the initial HTML with JavaScript off. The
 * single interactive control (`SmsOptInForm`) is a client island whose initial
 * HTML (empty phone field + unchecked checkbox) is also server-rendered.
 *
 * The consent wording lives ONCE, in `SmsConsentCheckbox`, and matches the
 * campaign declaration verbatim. Keep this page free of any redirect.
 */
export default function SmsConsentPage() {
  return (
    <div className="min-h-screen px-4 py-16 sm:py-20 [html[data-native]_&]:py-4 [html[data-native]_&]:pt-[max(1rem,env(safe-area-inset-top))]">
      <PublicMobileBackBar label="Back" />
      <article className="glass-card mx-auto max-w-3xl rounded-3xl px-6 py-10 sm:px-10 sm:py-12">
        <header className="border-b border-border pb-8">
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-primary/80">SMS program</p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight text-foreground">
            Text message consent
          </h1>
          <p className="mt-3 text-[15px] leading-relaxed text-muted">
            PropLane sends text messages to renters and residents about their rental application and account.
            Opting in is optional and is never required to submit a rental application, book a tour, or send a
            message.
          </p>
        </header>

        <div className="mt-8 grid gap-10">
          <section>
            <h2 className="text-lg font-semibold text-foreground">Opt in to PropLane texts</h2>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              Enter your mobile number and check the box to consent. The number you enter is the one that
              receives messages.
            </p>
            <div className="mt-5 rounded-2xl border border-border bg-card/60 px-5 py-6 sm:px-6">
              <SmsOptInForm />
            </div>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground">Program details</h2>
            <ul className="mt-3 space-y-2.5 text-[15px] leading-relaxed text-muted">
              <li>
                <strong className="font-medium text-foreground">Who sends the messages:</strong> PropLane
                (prop-lane.space).
              </li>
              <li>
                <strong className="font-medium text-foreground">What the messages are about:</strong> your
                rental application and account — for example application updates, rent reminders, and messages
                relayed between you and your property manager.
              </li>
              <li>
                <strong className="font-medium text-foreground">Message frequency:</strong> message frequency
                varies.
              </li>
              <li>
                <strong className="font-medium text-foreground">Cost:</strong> message and data rates may
                apply.
              </li>
              <li>
                <strong className="font-medium text-foreground">Opting out:</strong> reply <strong>STOP</strong>{" "}
                to any message to opt out at any time.
              </li>
              <li>
                <strong className="font-medium text-foreground">Getting help:</strong> reply{" "}
                <strong>HELP</strong> for help, or contact{" "}
                <a href="mailto:support@prop-lane.space" className="font-medium text-primary hover:opacity-90">
                  support@prop-lane.space
                </a>
                .
              </li>
              <li>
                <strong className="font-medium text-foreground">Optional:</strong> consent to receive texts is
                not a condition of applying for housing or using PropLane.
              </li>
            </ul>
            <p className="mt-4 text-sm leading-relaxed text-muted">
              Full details are in our{" "}
              <Link href="/privacy" className="font-medium text-primary hover:opacity-90">
                Privacy Policy
              </Link>
              ,{" "}
              <Link href="/tos" className="font-medium text-primary hover:opacity-90">
                Terms of Service
              </Link>
              , and{" "}
              <Link href="/sms-terms" className="font-medium text-primary hover:opacity-90">
                SMS Terms of Service
              </Link>
              . Mobile phone numbers, opt-in data, and consent are not shared, sold, or transferred to third
              parties or affiliates for marketing or promotional purposes.
            </p>
          </section>
        </div>
      </article>
    </div>
  );
}
