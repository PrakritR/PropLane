import type { Metadata } from "next";
import Link from "next/link";
import { DocsScrollspyNav, type DocsNavGroup } from "@/components/docs/docs-scrollspy-nav";
import { BOOK_DEMO_HREF } from "@/lib/marketing/public-contact";

export const metadata: Metadata = {
  title: "Docs",
  description: "Learn how to manage applications, leases, rent, services, books, documents, and your team with PropLane.",
};

/**
 * Public docs page with a sticky anchor navigation and a server-rendered content column.
 * Styling stays local so it does not affect the signed-in portal theme.
 */

const NAV_GROUPS: DocsNavGroup[] = [
  {
    group: "Overview",
    links: [
      { id: "getting-started", label: "Getting started" },
      { id: "portals", label: "The three portals" },
    ],
  },
  {
    group: "Core workflows",
    links: [
      { id: "applications", label: "Applications & screening" },
      { id: "leases", label: "Leases & e-signature" },
      { id: "rent", label: "Rent & payments" },
      { id: "maintenance", label: "Maintenance & services" },
    ],
  },
  {
    group: "Books & data",
    links: [
      { id: "accounting", label: "Accounting & reports" },
      { id: "documents", label: "Documents" },
    ],
  },
  {
    group: "Platform",
    links: [
      { id: "ai-assistant", label: "The AI assistant" },
      { id: "team", label: "Team & co-managers" },
      { id: "trial", label: "Free trial" },
    ],
  },
];

export default function DocsPage() {
  return (
    <div className="relative min-h-screen overflow-x-clip bg-background text-foreground">
      {/* Subtle indigo glow behind the header. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-32 left-1/2 h-[420px] w-[820px] max-w-[130%] -translate-x-1/2 opacity-70"
        style={{
          background:
            "radial-gradient(ellipse at 50% 30%, color-mix(in srgb, var(--primary) 12%, transparent), color-mix(in srgb, var(--primary) 5%, transparent) 44%, transparent 72%)",
          filter: "blur(44px)",
        }}
      />

      {/* Header */}
      <header className="relative mx-auto max-w-6xl px-5 pb-10 pt-16 sm:px-6 sm:pt-20">
        <h1 className="text-[2.4rem] font-semibold leading-[1.06] tracking-[-0.035em] sm:text-[3rem]">
          Documentation
        </h1>
        <p className="mt-4 max-w-2xl text-[15.5px] leading-relaxed text-muted">
          A practical guide to running rentals with PropLane. This page covers the workflows
          available today.
        </p>
      </header>

      {/* Docs shell: sticky nav + content */}
      <div className="relative mx-auto grid max-w-6xl gap-10 px-5 pb-24 sm:px-6 lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-14">
        {/* Left doc nav: a mobile card and a sticky desktop rail. */}
        <DocsScrollspyNav groups={NAV_GROUPS} dataAttrPrefix="docs-toc" />

        {/* Right content column */}
        <div className="min-w-0 max-w-3xl">
          <DocSection id="getting-started" kicker="Overview" title="Getting started">
            <p>
              Set up a property, invite people, and manage the rental lifecycle in one place.
            </p>
            <DocList>
              <DocCheckLi>
                <b className="font-medium text-foreground">Create an account</b>: verify your email and
                start a 14-day Pro trial. No card is required.
              </DocCheckLi>
              <DocCheckLi>
                <b className="font-medium text-foreground">Add a property and units</b>: set rent and due
                dates.
              </DocCheckLi>
              <DocCheckLi>
                <b className="font-medium text-foreground">Invite residents and vendors</b>: share a public
                application link and assign services as needed.
              </DocCheckLi>
            </DocList>
            <p>
              Choose Free, Pro, or Business when you are ready. Annual billing is 20% less. {" "}
              <Link href="/pricing" className="text-primary underline-offset-2 hover:underline">
                Compare plans
              </Link>
              .
            </p>
            <p className="text-[14px]">
              <Link
                href="/auth/create-account"
                data-attr="docs-getting-started-signup"
                className="text-primary underline-offset-2 hover:underline"
              >
                Start a free trial
              </Link>
              {" "}or{" "}
              <Link
                href={BOOK_DEMO_HREF}
                data-attr="docs-getting-started-book-demo"
                className="text-primary underline-offset-2 hover:underline"
              >
                book a walkthrough
              </Link>
              .
            </p>
          </DocSection>

          <DocSection id="portals" kicker="Overview" title="The three portals">
            <p>
              Each person gets the tools for their part of the rental relationship.
            </p>
            <DocList>
              <DocLi>
                <b className="font-medium text-foreground">Managers</b> run properties, applications,
                leases, rent, services, books, documents, and team access.
              </DocLi>
              <DocLi>
                <b className="font-medium text-foreground">Residents</b> apply, sign, pay, request
                services, and view shared documents.
              </DocLi>
              <DocLi>
                <b className="font-medium text-foreground">Vendors</b> review assigned services, bid,
                schedule, invoice, and receive payment.
              </DocLi>
            </DocList>
          </DocSection>

          <DocSection
            id="applications"
            kicker="Core workflows"
            title="Applications & screening"
          >
            <p>
              Share each unit&rsquo;s public link. Applicants submit at <Chip>/rent/apply</Chip>, and their
              application appears in your portal.
            </p>
            <p>
              Review and pre-screen applicants, then approve the person you want to lease to. Their
              application details can start the lease draft.
            </p>
          </DocSection>

          <DocSection id="leases" kicker="Core workflows" title="Leases & e-signature">
            <p>
              Start a lease draft from an approved application. PropLane fills in the available names,
              unit, rent, dates, and terms.
            </p>
            <p>
              Review and edit the draft before sending it. Parties e-sign in the portal, and a fully
              signed lease can be filed in the document library.
            </p>
          </DocSection>

          <DocSection id="rent" kicker="Core workflows" title="Rent & payments">
            <p>
              Residents pay online and can see their balance, receipts, and statements.
            </p>
            <DocList>
              <DocLi>
                <b className="font-medium text-foreground">Reminders</b> can send before and after the due
                date by email and, with a work number, text.
              </DocLi>
              <DocLi>
                <b className="font-medium text-foreground">Late fees</b> follow the rules you set.
              </DocLi>
              <DocLi>
                <b className="font-medium text-foreground">Partial payments</b> remain tracked against the
                balance.
              </DocLi>
            </DocList>
            <p>
              Cleared payments post to the books. See{" "}
              <a href="#accounting" className="text-primary underline-offset-2 hover:underline">Accounting</a>.
            </p>
          </DocSection>

          <DocSection
            id="maintenance"
            kicker="Core workflows"
            title="Maintenance & services"
          >
            <p>
              Residents submit maintenance requests. Add-on requests cover optional services such as
              parking, storage, cleaning, or equipment rentals.
            </p>
            <p>
              Assign maintenance to a vendor. Invite vendors to bid when you need a price; they can
              propose a cost, time, and notes.
            </p>
            <DocList>
              <DocLi>Request, assign, and optionally schedule a visit.</DocLi>
              <DocLi>Invite bids, then accept one.</DocLi>
              <DocLi>Approve and pay for completed service.</DocLi>
            </DocList>
            <p>
              Vendor invoices move from submitted to approved or rejected. Approved invoices may be
              scheduled before payment or paid directly. Approved vendor payments use Stripe Connect
              and book the expense.
            </p>
          </DocSection>

          <DocSection id="accounting" kicker="Books & data" title="Accounting & reports">
            <p>
              PropLane records charges, payments, expenses, and payouts in a double-entry ledger.
            </p>
            <p>Run these reports from Finances:</p>
            <DocList>
              <DocLi>Trial balance, balance sheet, and income statement</DocLi>
              <DocLi>General ledger and a cash-flow view</DocLi>
              <DocLi>Owner statements, AP aging, and budget vs. actual</DocLi>
              <DocLi>Security-deposit trust ledger and diagnostics</DocLi>
            </DocList>
            <p>
              Security deposits are held in trust as a liability, not rental income.
            </p>
          </DocSection>

          <DocSection id="documents" kicker="Books & data" title="Documents">
            <p>
              Store leases, insurance certificates, invoices, inspections, notices, and photos in the
              document library. Files stay private and open through short-lived signed links.
            </p>
            <DocList>
              <DocLi>
                Organize files by category, property, unit, lease, or vendor.
              </DocLi>
              <DocLi>
                Set expiration dates and receive reminders before they lapse.
              </DocLi>
              <DocLi>
                Share a file with a resident or vendor through their portal.
              </DocLi>
            </DocList>
          </DocSection>

          <DocSection id="ai-assistant" kicker="Platform" title="The AI assistant">
            <p>
              Ask questions or propose app actions in plain language, such as a rent reminder, lease
              draft, or delinquency question.
            </p>
            <p>
              The assistant uses the same role-scoped actions and records as the app. It cannot bypass
              product permissions or reach another manager&rsquo;s data.
            </p>
            <p className="rounded-lg border border-border bg-card px-4 py-3.5 text-[14px] text-foreground">
              <span className="mr-2 text-primary" aria-hidden>
                ✦
              </span>
              Most built-in assistant writes are previewed first. Low-risk inbox housekeeping, such as
              marking a thread read or unread, archiving it, or restoring it, may run immediately. Every
              external MCP or REST write returns a preview and requires a signed-in manager&rsquo;s approval
              in PropLane. Each action is recorded in the audit log.
            </p>
            <p className="text-[14px]">
              Building your own agent harness? Connect it through the same tool layer with the{" "}
              <Link
                href="/docs/mcp"
                data-attr="docs-mcp-link"
                className="text-primary underline-offset-2 hover:underline"
              >
                MCP server &amp; API
              </Link>
              .
            </p>
          </DocSection>

          <DocSection id="team" kicker="Platform" title="Team & co-managers">
            <p>
              Invite co-managers with explicit access per property and module. Give <b className="font-medium text-foreground">read</b>,{" "}
              <b className="font-medium text-foreground">edit</b>, or <b className="font-medium text-foreground">delete</b> access only where it is needed.
            </p>
            <p>
              An empty permission set gives no access. A property assignment alone does not grant a
              module permission. You can also add a work number for business texts and receive replies
              in your PropLane inbox.
            </p>
          </DocSection>

          <DocSection id="trial" kicker="Platform" title="Free trial">
            <p>
              Try Pro for 14 days without a card, then choose Free, Pro, or Business.
            </p>
            <div className="mt-6 flex flex-col gap-3 sm:flex-row">
              <Link
                href="/auth/create-account"
                data-attr="docs-demo-get-started"
                className="inline-flex min-h-[46px] items-center justify-center gap-2 rounded-[10px] bg-[var(--pl-brand)] px-6 text-[14.5px] font-medium text-white shadow-[0_4px_14px_color-mix(in_srgb,var(--pl-brand)_28%,transparent)] transition hover:brightness-110"
              >
                Get started for free
              </Link>
              <Link
                href={BOOK_DEMO_HREF}
                data-attr="docs-demo-book-demo"
                className="inline-flex min-h-[46px] items-center justify-center gap-2 rounded-[10px] border border-[var(--pl-line)] bg-[var(--pl-surface-raised)] px-6 text-[14.5px] font-medium text-foreground transition hover:border-foreground/20"
              >
                Book a demo
              </Link>
            </div>
          </DocSection>

          {/* Footer note within the column */}
          <div className="mt-14 border-t border-border pt-6 text-[13px] text-muted/60">
            Still stuck?{" "}
            <Link
              href="/support"
              data-attr="docs-footer-support"
              className="text-muted underline-offset-2 hover:text-foreground hover:underline"
            >
              Contact support
            </Link>
            .
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Local primitives                                                    */
/* ------------------------------------------------------------------ */

function DocSection({
  id,
  kicker,
  title,
  children,
}: {
  id: string;
  kicker: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      className="scroll-mt-24 border-t border-border pt-11 first:border-t-0 first:pt-0 [&:not(:first-child)]:mt-11"
    >
      <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted/60">
        {kicker}
      </div>
      <h2 className="mt-2 text-[23px] font-semibold tracking-[-0.02em] text-foreground">{title}</h2>
      <div className="mt-4 space-y-4 text-[15px] leading-relaxed text-muted">{children}</div>
    </section>
  );
}

function DocList({ children }: { children: React.ReactNode }) {
  return <ul className="space-y-2.5">{children}</ul>;
}

function DocLi({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex gap-3 text-[14.5px] leading-relaxed text-muted">
      <span
        aria-hidden
        className="mt-[9px] h-1 w-1 shrink-0 rounded-full bg-primary/80"
      />
      <span className="min-w-0">{children}</span>
    </li>
  );
}

/**
 * A compact overview item.
 *
 * Keep the icon separate from the authored text so the item remains easy to scan.
 */
function DocCheckLi({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex gap-2.5 text-[14.5px] leading-relaxed text-muted">
      <svg
        aria-hidden
        viewBox="0 0 24 24"
        fill="none"
        className="mt-[3px] h-4 w-4 shrink-0 text-primary"
      >
        <path
          d="M20 6 9 17l-5-5"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span className="min-w-0">{children}</span>
    </li>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <code className="whitespace-nowrap rounded-[5px] border border-border bg-[var(--secondary)] px-1.5 py-0.5 font-mono text-[12.5px] text-muted">
      {children}
    </code>
  );
}
