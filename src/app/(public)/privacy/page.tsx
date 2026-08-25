import type { Metadata } from "next";
import Link from "next/link";
import { PublicMobileBackBar } from "@/components/layout/public-mobile-back-bar";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "How PropLane collects, uses, and protects information when you use our property management platform and mobile apps.",
};

const LAST_UPDATED = "August 6, 2026";

export default function PrivacyPolicyPage() {
  return (
    <div className="min-h-screen px-4 py-16 sm:py-20 [html[data-native]_&]:py-4 [html[data-native]_&]:pt-[max(1rem,env(safe-area-inset-top))]">
      <PublicMobileBackBar label="Back" />
      <article className="glass-card mx-auto max-w-3xl rounded-3xl px-6 py-10 sm:px-10 sm:py-12">
        <header className="border-b border-border pb-8">
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-primary/80">Legal</p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight text-foreground">Privacy Policy</h1>
          <p className="mt-2 text-sm text-muted">Last updated: {LAST_UPDATED}</p>
        </header>

        <div className="prose-policy mt-8 space-y-8 text-[15px] leading-relaxed text-muted">
          <section>
            <h2 className="text-lg font-semibold text-foreground">Who we are</h2>
            <p className="mt-2">
              PropLane (&ldquo;we,&rdquo; &ldquo;us&rdquo;) provides property management software operated by PropLane Seattle
              Housing. This policy describes how we collect, use, and protect information when you use the PropLane website
              at{" "}
              <a href="https://prop-lane.space" className="font-medium text-primary hover:opacity-90">
                prop-lane.space
              </a>{" "}
              and our iOS and Android mobile applications (collectively, the &ldquo;Service&rdquo;).
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground">Information we collect</h2>
            <ul className="mt-3 list-disc space-y-2 ps-5">
              <li>
                <strong className="font-medium text-foreground">Account information:</strong> name, email address, phone
                number, and role (property manager or resident) when you create an account or are invited by your
                property manager.
              </li>
              <li>
                <strong className="font-medium text-foreground">Property and tenancy data:</strong> lease details, payment
                history, maintenance requests, documents, and messages you submit through the Service.
              </li>
              <li>
                <strong className="font-medium text-foreground">Payment information:</strong> rent and subscription
                payments are processed by Stripe. We do not store full card or bank account numbers on our servers.
              </li>
              <li>
                <strong className="font-medium text-foreground">Mobile app data:</strong> push notification tokens when you
                opt in to alerts; camera or photo library access only when you choose to attach images to documents or
                work orders.
              </li>
              <li>
                <strong className="font-medium text-foreground">Usage data:</strong> standard technical logs (such as IP
                address, browser or device type, and pages visited) to operate, secure, and improve the Service.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground">How we use information</h2>
            <ul className="mt-3 list-disc space-y-2 ps-5">
              <li>Provide, maintain, and improve the PropLane platform</li>
              <li>Process payments and send transaction-related communications</li>
              <li>
                Send email, SMS, and push notifications related to your account (for example, rent reminders and messages)
              </li>
              <li>Authenticate users and prevent fraud or abuse</li>
              <li>Comply with legal obligations</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground">How we share information</h2>
            <p className="mt-2">
              We share information with service providers that help us operate PropLane, including Supabase (authentication
              and database hosting), Stripe (payments), Twilio (SMS), Resend (email), Google (sign-in and optional
              Calendar and Gmail integrations), and Google Firebase (push notifications). We do not sell your personal
              information.
            </p>
            <p className="mt-2">
              We may disclose information if required by law, to protect our rights or users, or in connection with a
              merger, acquisition, or sale of assets, with notice where appropriate.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground">SMS / text messaging</h2>
            <p className="mt-2">
              When you provide your mobile number and opt in to text messages, we use it to send account and
              tenancy-related messages (for example, rent reminders, maintenance updates, and messages relayed between
              you and your property manager or resident) or, if you opted in on a tour or contact form as a
              prospective resident, messages about tour scheduling and your rental inquiry. Message frequency varies.
              Message and data rates may apply. Reply STOP to unsubscribe at any time, or HELP for help.
            </p>
            <p className="mt-2 font-medium text-foreground">
              Mobile phone numbers, opt-in information, and consent will not be shared, sold, or transferred to
              third parties or affiliates for marketing or promotional purposes.
            </p>
            <p className="mt-2">
              We retain records of your SMS consent (the wording you agreed to, and when) for as long as required to
              demonstrate compliance. To have your number removed, reply STOP or contact us using the details below.
              See our{" "}
              <Link href="/sms-terms" className="font-medium text-primary hover:opacity-90">
                SMS Terms of Service
              </Link>{" "}
              for full program details.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground">Google sign-in, Calendar, and Gmail</h2>
            <p className="mt-2">
              You may sign in with Google or connect your Google Calendar to PropLane. When you do, we receive your
              Google account email and, if you authorize it, access to your Google Calendar events through Google&apos;s
              APIs.
            </p>
            <p className="mt-2">We use Google Calendar data only to provide features you request, such as:</p>
            <ul className="mt-3 list-disc space-y-2 ps-5">
              <li>Showing your personal busy time on your manager calendar so you avoid double-booking property tours</li>
              <li>Creating and updating calendar events for tours and work you schedule in PropLane</li>
              <li>Blocking tour availability on your public listing when your calendar is busy</li>
            </ul>
            <p className="mt-2">
              Calendar data is tied to the manager account that connected it. We do not use Google Calendar data for
              advertising, and we do not sell it. Other managers or residents cannot see the details of your personal
              Google events — only blocked time may appear on your scheduling views.
            </p>
            <p className="mt-2">
              Managers and vendors may also optionally link Gmail to auto-track payment receipts. When enabled, PropLane
              searches recent messages that match supported payment providers, such as Zelle or Venmo, and reads the
              sender, subject, and message body only to identify a payment reference and amount. We use that information
              to match a receipt to a charge or work order and mark the corresponding payment record as paid. PropLane
              does not send, modify, or delete Gmail messages, and does not use Gmail data for advertising.
            </p>
            <p className="mt-2">
              Google access and refresh tokens are stored for the connected PropLane account so requested Calendar and
              Gmail synchronization can continue. Gmail message content is processed for payment matching; PropLane
              stores the resulting payment status and source message identifier rather than a copy of the full message.
            </p>
            <p className="mt-2">
              You can disconnect Google Calendar or Gmail at any time from the applicable PropLane portal settings. You
              can also revoke PropLane&apos;s access from your{" "}
              <a
                href="https://myaccount.google.com/permissions"
                className="font-medium text-primary hover:opacity-90"
                rel="noopener noreferrer"
                target="_blank"
              >
                Google Account permissions
              </a>
              .
            </p>
            <p className="mt-2">
              PropLane&apos;s use of information received from Google APIs adheres to the{" "}
              <a
                href="https://developers.google.com/terms/api-services-user-data-policy"
                className="font-medium text-primary hover:opacity-90"
                rel="noopener noreferrer"
                target="_blank"
              >
                Google API Services User Data Policy
              </a>
              , including the Limited Use requirements.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground">Your choices</h2>
            <ul className="mt-3 list-disc space-y-2 ps-5">
              <li>Update profile information in the manager or resident portal.</li>
              <li>Disconnect Google Calendar or Gmail from the applicable portal settings.</li>
              <li>Disable push notifications in your device Settings.</li>
              <li>
                Delete your account at any time from your portal&rsquo;s profile or settings page. This permanently
                removes your profile and personal data; business records other users rely on (such as lease and payment
                history) may be retained as described under Data retention.
              </li>
              <li>Residents: contact your property manager for questions about tenancy data.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground">Data retention</h2>
            <p className="mt-2">
              We retain information for as long as your account is active or as needed to provide the Service and meet
              legal, accounting, or reporting requirements.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground">Security</h2>
            <p className="mt-2">
              We use industry-standard safeguards, including encrypted connections (HTTPS) and access controls. No method
              of transmission or storage is completely secure.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground">Children</h2>
            <p className="mt-2">
              The Service is not directed to children under 13, and we do not knowingly collect personal information from
              children.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground">Changes to this policy</h2>
            <p className="mt-2">
              We may update this policy from time to time. We will post the revised version at this URL and update the
              &ldquo;Last updated&rdquo; date above.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground">Contact us</h2>
            <p className="mt-2">
              For privacy questions, contact us at{" "}
              <a href="mailto:support@prop-lane.space" className="font-medium text-primary hover:opacity-90">
                support@prop-lane.space
              </a>{" "}
              or{" "}
              <Link href="/partner/contact" className="font-medium text-primary hover:opacity-90">
                send a message
              </Link>
              .
            </p>
            <p className="mt-2">
              PropLane Seattle Housing
              <br />
              5259 Brooklyn Ave NE
              <br />
              Seattle, WA 98105
              <br />
              United States
            </p>
          </section>
        </div>
      </article>
    </div>
  );
}
