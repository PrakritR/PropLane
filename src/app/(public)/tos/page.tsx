import type { Metadata } from "next";
import Link from "next/link";
import { PublicMobileBackBar } from "@/components/layout/public-mobile-back-bar";

export const metadata: Metadata = {
  title: "Terms of Service",
  description:
    "Terms governing use of the PropLane property management platform, website, and mobile applications.",
};

const LAST_UPDATED = "June 29, 2026";

export default function TermsOfServicePage() {
  return (
    <div className="min-h-screen px-4 py-16 sm:py-20 [html[data-native]_&]:py-4 [html[data-native]_&]:pt-[max(1rem,env(safe-area-inset-top))]">
      <PublicMobileBackBar label="Back" />
      <article className="glass-card mx-auto max-w-3xl rounded-3xl px-6 py-10 sm:px-10 sm:py-12">
        <header className="border-b border-border pb-8">
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-primary/80">Legal</p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight text-foreground">Terms of Service</h1>
          <p className="mt-2 text-sm text-muted">Last updated: {LAST_UPDATED}</p>
        </header>

        <div className="prose-policy mt-8 space-y-8 text-[15px] leading-relaxed text-muted">
          <section>
            <h2 className="text-lg font-semibold text-foreground">Agreement</h2>
            <p className="mt-2">
              These Terms of Service (&ldquo;Terms&rdquo;) govern your access to and use of the PropLane website at{" "}
              <a href="https://proplane.ai" className="font-medium text-primary hover:opacity-90">
                prop-lane.space
              </a>
              , our iOS and Android mobile applications, and related property management software and services
              (collectively, the &ldquo;Service&rdquo;) operated by PropLane Seattle Housing (&ldquo;PropLane,&rdquo;
              &ldquo;we,&rdquo; &ldquo;us&rdquo;).
            </p>
            <p className="mt-2">
              By creating an account, signing in, or using the Service, you agree to these Terms. If you do not agree, do
              not use the Service.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground">Who may use the Service</h2>
            <ul className="mt-3 list-disc space-y-2 ps-5">
              <li>
                <strong className="font-medium text-foreground">Property managers and owners</strong> may use manager
                features subject to an active subscription or trial where applicable.
              </li>
              <li>
                <strong className="font-medium text-foreground">Residents and applicants</strong> may use resident
                features when invited or approved by a property manager associated with their tenancy or application.
              </li>
              <li>You must be at least 18 years old and able to form a binding contract.</li>
              <li>You must provide accurate account information and keep your credentials secure.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground">Your account</h2>
            <p className="mt-2">
              You are responsible for activity under your account. Notify us promptly if you suspect unauthorized access.
              We may suspend or terminate accounts that violate these Terms, pose a security risk, or remain inactive for
              an extended period, with notice where reasonable.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground">Acceptable use</h2>
            <p className="mt-2">You agree not to:</p>
            <ul className="mt-3 list-disc space-y-2 ps-5">
              <li>Use the Service for unlawful, fraudulent, or harassing purposes</li>
              <li>Attempt to access another user&apos;s data without authorization</li>
              <li>Reverse engineer, scrape, or overload the Service except as permitted by law</li>
              <li>Upload malware or content that infringes others&apos; rights</li>
              <li>Misrepresent your identity or affiliation with a property or organization</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground">Property manager subscriptions and payments</h2>
            <p className="mt-2">
              Paid manager plans, billing cycles, and feature limits are described at checkout and in your account. Fees
              are processed by Stripe. Subscriptions renew automatically unless canceled before the renewal date. Taxes may
              apply where required by law.
            </p>
            <p className="mt-2">
              Refunds are handled according to the plan selected at purchase and applicable law. Downgrades or cancellations
              take effect at the end of the current billing period unless otherwise stated.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground">Rent and resident payments</h2>
            <p className="mt-2">
              PropLane provides tools for property managers to collect rent and related charges. We are not a bank, money
              transmitter, or landlord. Payment processing is provided by Stripe and subject to Stripe&apos;s terms.
              Managers are responsible for compliance with applicable landlord-tenant, fair housing, and payment laws.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground">Content and data</h2>
            <p className="mt-2">
              You retain ownership of content you submit (leases, messages, documents, listings, etc.). You grant PropLane a
              limited license to host, process, and display that content solely to operate the Service. Managers control
              resident access to property-related data within their workspace.
            </p>
            <p className="mt-2">
              Our use of personal information is described in our{" "}
              <Link href="/privacy" className="font-medium text-primary hover:opacity-90">
                Privacy Policy
              </Link>
              .
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground">Intellectual property</h2>
            <p className="mt-2">
              The Service, including software, design, trademarks, and documentation, is owned by PropLane or its licensors
              and protected by intellectual property laws. These Terms do not grant you any rights to our branding or
              source code except the limited right to use the Service as intended.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground">Third-party services</h2>
            <p className="mt-2">
              The Service integrates with third parties such as Stripe, Supabase, Google, and Twilio. Your use of those
              services may be subject to their separate terms. We are not responsible for third-party products or sites
              linked from the Service.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground">Disclaimers</h2>
            <p className="mt-2">
              THE SERVICE IS PROVIDED &ldquo;AS IS&rdquo; AND &ldquo;AS AVAILABLE.&rdquo; TO THE FULLEST EXTENT PERMITTED
              BY LAW, PROPLANE DISCLAIMS ALL WARRANTIES, EXPRESS OR IMPLIED, INCLUDING MERCHANTABILITY, FITNESS FOR A
              PARTICULAR PURPOSE, AND NON-INFRINGEMENT. WE DO NOT GUARANTEE UNINTERRUPTED OR ERROR-FREE OPERATION.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground">Limitation of liability</h2>
            <p className="mt-2">
              TO THE FULLEST EXTENT PERMITTED BY LAW, PROPLANE AND ITS OFFICERS, DIRECTORS, EMPLOYEES, AND SUPPLIERS WILL NOT
              BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR ANY LOSS OF
              PROFITS, DATA, OR GOODWILL, ARISING FROM YOUR USE OF THE SERVICE. OUR TOTAL LIABILITY FOR ANY CLAIM RELATING
              TO THE SERVICE IS LIMITED TO THE GREATER OF (A) AMOUNTS YOU PAID TO PROPLANE IN THE TWELVE MONTHS BEFORE THE
              CLAIM OR (B) ONE HUNDRED U.S. DOLLARS ($100).
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground">Indemnification</h2>
            <p className="mt-2">
              You agree to indemnify and hold harmless PropLane from claims, damages, and expenses (including reasonable
              attorneys&apos; fees) arising from your use of the Service, your content, or your violation of these Terms
              or applicable law.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground">Changes</h2>
            <p className="mt-2">
              We may modify these Terms from time to time. We will post the updated version at this URL and update the
              &ldquo;Last updated&rdquo; date. Material changes may be communicated by email or in-app notice. Continued
              use after changes become effective constitutes acceptance.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground">Governing law</h2>
            <p className="mt-2">
              These Terms are governed by the laws of the State of Washington, without regard to conflict-of-law rules.
              Disputes will be resolved in the state or federal courts located in King County, Washington, unless
              applicable law requires otherwise.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground">Contact us</h2>
            <p className="mt-2">
              For questions about these Terms, contact us at{" "}
              <a href="mailto:support@proplane.ai" className="font-medium text-primary hover:opacity-90">
                support@proplane.ai
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
