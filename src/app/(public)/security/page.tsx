import type { Metadata } from "next";
import Link from "next/link";
import { PublicMobileBackBar } from "@/components/layout/public-mobile-back-bar";
import { PUBLIC_SUPPORT_EMAIL } from "@/lib/marketing/public-contact";

export const metadata: Metadata = {
  title: "Security",
  description:
    "How PropLane protects property, resident and applicant data: encrypted connections and storage, an extra encryption layer for sensitive records, permission-checked access, and ongoing security checks.",
};

/**
 * The customer-facing answer to "how is my data protected?" (PRP-325).
 *
 * Every claim on this page is one the team can stand behind today and is taken
 * from `docs/security/customer-security-wording.md`, which bounds the wording
 * deliberately: "selected" fields, "application-uploaded" documents, provider
 * encryption at rest, permission-checked access, ongoing checks. It makes none
 * of the absolute claims the wording doc forbids (unbreakable, audited,
 * certified, or the two encryption buzz-phrases) —
 * `tests/unit/security-page-claims.test.ts` keeps those words off this page.
 * When the underlying controls change, update the wording doc first and this
 * page second.
 */
const LAST_UPDATED = "September 7, 2026";

const PROTECTIONS: { title: string; body: string }[] = [
  {
    title: "Encrypted connections and storage",
    body:
      "Information travels between your device and PropLane over HTTPS. Our database provider also encrypts stored customer data at rest.",
  },
  {
    title: "An additional layer for sensitive information",
    body:
      "Selected applicant and co-signer identity fields, application-uploaded documents, and connected-calendar credentials are encrypted before they are stored, using encryption keys kept separately from the database. Existing records covered by this layer have been migrated.",
  },
  {
    title: "Controlled access",
    body:
      "Protected application records and documents are only reachable through authenticated, permission-checked routes. Direct browser access to the sensitive application, co-signer and calendar tables is blocked, and application document storage is private.",
  },
  {
    title: "Ongoing security checks",
    body:
      "We review security-sensitive changes, test unauthorized access attempts, scan dependencies and source code, and fix what we find. Our testing includes open-source security tooling from Trail of Bits.",
  },
];

const LIMITS: string[] = [
  "The additional encryption layer covers the records named above. Other data — for example lease documents, free-text answers and routine account records — relies on the provider's encryption at rest and on access controls, not on the additional layer.",
  "Someone signed in to an account, or an attacker who compromises a running server, can see what that account is allowed to see. Encryption protects data at rest; it does not replace strong passwords and careful account sharing.",
  "Our security testing uses open-source tooling and our own reviews. It is not an independent audit, penetration test, SOC 2 report or HIPAA assessment.",
];

export default function SecurityPage() {
  return (
    <div className="min-h-screen px-4 py-16 sm:py-20 [html[data-native]_&]:py-4 [html[data-native]_&]:pt-[max(1rem,env(safe-area-inset-top))]">
      <PublicMobileBackBar label="Back" />
      <article className="glass-card mx-auto max-w-3xl rounded-3xl px-6 py-10 sm:px-10 sm:py-12">
        <header className="border-b border-border pb-8">
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-primary/80">Trust</p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight text-foreground">How your data is protected</h1>
          <p className="mt-3 text-[15px] leading-relaxed text-muted">
            Property managers put resident and applicant records in PropLane, and some of those records are among
            the most sensitive a person has. This page says plainly what we do to protect them, and where the
            limits are.
          </p>
          <p className="mt-2 text-sm text-muted">Last updated: {LAST_UPDATED}</p>
        </header>

        <div className="mt-8 space-y-8 text-[15px] leading-relaxed text-muted">
          <section aria-labelledby="security-protections">
            <h2 id="security-protections" className="text-lg font-semibold text-foreground">
              What we do
            </h2>
            <ul className="mt-3 space-y-4" data-attr="security-protections">
              {PROTECTIONS.map((item) => (
                <li key={item.title} className="rounded-2xl border border-border bg-card/60 px-4 py-3.5">
                  <p className="font-medium text-foreground">{item.title}</p>
                  <p className="mt-1">{item.body}</p>
                </li>
              ))}
            </ul>
          </section>

          <section aria-labelledby="security-limits">
            <h2 id="security-limits" className="text-lg font-semibold text-foreground">
              What this does not mean
            </h2>
            <p className="mt-2">
              No system is beyond compromise, and we would rather tell you exactly where the edges are than
              overstate them.
            </p>
            <ul className="mt-3 list-disc space-y-2 ps-5" data-attr="security-limits">
              {LIMITS.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </section>

          <section aria-labelledby="security-yours">
            <h2 id="security-yours" className="text-lg font-semibold text-foreground">
              Your data stays yours
            </h2>
            <p className="mt-2">
              You can delete your account from Settings at any time; a deletion removes your records so the same
              email address can start again on an empty account. How we collect and use information is set out in
              our{" "}
              <Link href="/privacy" className="font-medium text-primary hover:opacity-90">
                Privacy Policy
              </Link>
              .
            </p>
          </section>

          <section aria-labelledby="security-contact">
            <h2 id="security-contact" className="text-lg font-semibold text-foreground">
              Questions or a security concern
            </h2>
            <p className="mt-2">
              Write to{" "}
              <a href={`mailto:${PUBLIC_SUPPORT_EMAIL}`} className="font-medium text-primary hover:opacity-90">
                {PUBLIC_SUPPORT_EMAIL}
              </a>{" "}
              with the word &ldquo;security&rdquo; in the subject. If you believe you have found a vulnerability,
              please include enough detail for us to reproduce it and give us a reasonable window to fix it before
              sharing it publicly.
            </p>
          </section>
        </div>
      </article>
    </div>
  );
}
