import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "SMS Terms of Service",
  description:
    "Terms for the PropLane property management text messaging program: message frequency, rates, HELP and STOP instructions, and support contacts.",
};

const LAST_UPDATED = "July 25, 2026";

export default function SmsTermsPage() {
  return (
    <div className="min-h-screen px-4 py-16 sm:py-20">
      <article className="glass-card mx-auto max-w-3xl rounded-3xl px-6 py-10 sm:px-10 sm:py-12">
        <header className="border-b border-border pb-8">
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-primary/80">Legal</p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight text-foreground">SMS Terms of Service</h1>
          <p className="mt-2 text-sm text-muted">Last updated: {LAST_UPDATED}</p>
        </header>

        <div className="prose-policy mt-8 space-y-8 text-[15px] leading-relaxed text-muted">
          <section>
            <h2 className="text-lg font-semibold text-foreground">Program description</h2>
            <p className="mt-2">
              PropLane property management messaging (&ldquo;the Program&rdquo;) sends two kinds of text messages from
              PropLane numbers:
            </p>
            <ul className="mt-3 list-disc space-y-2 ps-5">
              <li>
                <strong className="font-medium text-foreground">Tenancy messages</strong> — two-way conversational
                texts between property managers and their residents regarding an active tenancy, for example rent
                reminders, maintenance and work-order updates, scheduling, and messages relayed between a resident and
                their property manager through a dedicated PropLane number.
              </li>
              <li>
                <strong className="font-medium text-foreground">Tour and rental-inquiry messages</strong> — texts to
                prospective residents about tour scheduling and their rental inquiry, sent to the number they provide
                when requesting a tour or contacting a property.
              </li>
            </ul>
            <p className="mt-3">
              For both, message frequency varies and message and data rates may apply. The Program does not send
              marketing or promotional content.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground">Opting in</h2>
            <p className="mt-2">There are two ways to opt in, depending on the messages you want to receive:</p>
            <ul className="mt-3 list-disc space-y-2 ps-5">
              <li>
                <strong className="font-medium text-foreground">Tenancy messages</strong> — you opt in by entering
                your mobile number in the PropLane app or website, verifying ownership of that number with a one-time
                passcode, and checking an explicit consent box agreeing to receive text messages about your tenancy.
              </li>
              <li>
                <strong className="font-medium text-foreground">Tour and rental-inquiry messages</strong> — you opt in
                by checking the explicit consent box on the tour-scheduling or send-a-message form when you provide
                your phone number, agreeing to receive text messages from PropLane about tour scheduling and your
                rental inquiry at that number.
              </li>
            </ul>
            <p className="mt-3">
              Consent is optional and is not a condition of any purchase, of your tenancy, or of booking a tour or
              sending a message.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground">Message frequency and rates</h2>
            <ul className="mt-3 list-disc space-y-2 ps-5">
              <li>Message frequency varies.</li>
              <li>Message and data rates may apply. Check with your mobile carrier for details.</li>
              <li>Carriers are not liable for delayed or undelivered messages.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground">How to get help</h2>
            <p className="mt-2">
              Reply <strong className="font-medium text-foreground">HELP</strong> to any PropLane message for help, or
              contact our support team at{" "}
              <a href="mailto:support@prop-lane.space" className="font-medium text-primary hover:opacity-90">
                support@prop-lane.space
              </a>
              .
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground">How to opt out</h2>
            <p className="mt-2">
              Reply <strong className="font-medium text-foreground">STOP</strong> to any PropLane message to
              unsubscribe. You will receive one final message confirming your opt-out, after which no further messages
              will be sent to your number. You can re-subscribe at any time by replying START or by opting in again
              through the app.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground">Privacy</h2>
            <p className="mt-2">
              Our{" "}
              <Link href="/privacy" className="font-medium text-primary hover:opacity-90">
                Privacy Policy
              </Link>{" "}
              describes how we handle your information. Mobile phone numbers, opt-in information, and consent will not be
              shared, sold, or transferred to third parties or affiliates for marketing or promotional purposes.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground">Contact</h2>
            <p className="mt-2">
              PropLane Seattle Housing
              <br />
              5259 Brooklyn Ave NE
              <br />
              Seattle, WA 98105
              <br />
              United States
              <br />
              <a href="mailto:support@prop-lane.space" className="font-medium text-primary hover:opacity-90">
                support@prop-lane.space
              </a>
            </p>
          </section>
        </div>
      </article>
    </div>
  );
}
