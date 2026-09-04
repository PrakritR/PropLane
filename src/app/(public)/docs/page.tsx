import type { Metadata } from "next";
import Link from "next/link";
import { BOOK_DEMO_HREF } from "@/lib/marketing/public-contact";

export const metadata: Metadata = {
  title: "Docs",
  description:
    "Product documentation for PropLane: getting started, the three portals, applications, leases and e-signature, rent, maintenance, double-entry accounting, the AI assistant, documents, and the live demo.",
};

/**
 * Public docs page — Linear-light, self-contained. A sticky left doc-nav
 * (grouped anchor links) beside a right content column. Server component, no
 * client logic: nav is plain in-page anchors, sections carry `scroll-mt` so the
 * shared navbar never covers a heading. Honest beta copy only — no invented
 * stats. Styling stays in local arbitrary-value classes so it never touches the
 * signed-in portal theme.
 */

type NavGroup = { group: string; links: { id: string; label: string }[] };

const NAV_GROUPS: NavGroup[] = [
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
      { id: "maintenance", label: "Maintenance & work orders" },
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
      { id: "demo", label: "The live demo" },
    ],
  },
];

export default function DocsPage() {
  return (
    <div className="relative min-h-screen bg-background text-foreground">
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
          Everything PropLane does, in plain terms, from creating your account to running the
          books. PropLane is in beta; this covers what ships today, and grows as the product does.
        </p>
      </header>

      {/* Docs shell: sticky nav + content */}
      <div className="relative mx-auto grid max-w-6xl gap-10 px-5 pb-24 sm:px-6 lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-14">
        {/* Left doc-nav — a card on mobile (above content), a sticky rail on lg. */}
        <nav
          aria-label="Docs sections"
          className="rounded-xl border border-border bg-card p-4 lg:sticky lg:top-24 lg:h-fit lg:rounded-none lg:border-0 lg:bg-transparent lg:p-0"
        >
          <div className="mb-3 px-2 text-[11px] font-medium uppercase tracking-[0.08em] text-muted/60 lg:hidden">
            On this page
          </div>
          {NAV_GROUPS.map((g) => (
            <div key={g.group} className="mb-5 last:mb-0">
              <div className="px-2 text-[11px] font-medium uppercase tracking-[0.08em] text-muted/60">
                {g.group}
              </div>
              <ul className="mt-1.5 space-y-0.5 border-l border-border lg:pl-0">
                {g.links.map((l) => (
                  <li key={l.id}>
                    <a
                      href={`#${l.id}`}
                      className="-ml-px block border-l border-transparent px-3 py-1.5 text-[13px] text-muted transition-colors hover:border-primary hover:text-foreground"
                    >
                      {l.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>

        {/* Right content column */}
        <div className="min-w-0 max-w-3xl">
          <DocSection id="getting-started" kicker="Overview" title="Getting started">
            <p>
              PropLane is a property-management platform for independent landlords and small
              managers. You run everything (applications, leases, rent, maintenance, and the books)
              from one account that works on the web and as an iOS app.
            </p>
            <p>
              Create a manager account from <b className="font-medium text-foreground">Get started</b>.
              It&rsquo;s free, and no card is required. New accounts get a 14-day Pro trial, so you
              can try the paid features before you decide.
            </p>
            <DocList>
              <DocLi>
                <b className="font-medium text-foreground">Create your account</b>: pick a password
                and verify your email.
              </DocLi>
              <DocLi>
                <b className="font-medium text-foreground">Add a property</b> and its units, then set
                the monthly rent and due date.
              </DocLi>
              <DocLi>
                <b className="font-medium text-foreground">Invite people</b>: send residents your
                public application link, and add the vendors you work with.
              </DocLi>
            </DocList>
            <p>
              Plans: <Chip>Free $0</Chip> <Chip>Pro $20/mo</Chip> <Chip>Business $200/mo</Chip>.
              14-day trial with no card, and 20% off when billed annually.
            </p>
            <p className="text-[14px]">
              Prefer to look before you sign up? Open the{" "}
              <Link
                href="/demo"
                data-attr="docs-getting-started-demo"
                className="text-primary underline-offset-2 hover:underline"
              >
                live demo
              </Link>
              , the real product in a sandbox you can click through, no account needed.
            </p>
          </DocSection>

          <DocSection id="portals" kicker="Overview" title="The three portals">
            <p>
              PropLane has three portals, each with its own login. They share one platform, so a
              change made on one side shows up on the others automatically, with no re-entering the same
              thing twice.
            </p>
            <DocList>
              <DocLi>
                <b className="font-medium text-foreground">Manager</b>, the control center:
                portfolio, applications, leases, rent, work orders, double-entry books, documents,
                and your team.
              </DocLi>
              <DocLi>
                <b className="font-medium text-foreground">Resident</b>: apply for a unit, sign the
                lease, pay rent, see a running balance and receipts, submit maintenance requests, and
                read documents shared with them.
              </DocLi>
              <DocLi>
                <b className="font-medium text-foreground">Vendor</b>: see assigned work orders,
                submit bids, schedule visits, send invoices, and get paid.
              </DocLi>
            </DocList>
            <p>
              It&rsquo;s one codebase across web and iOS, so a feature ships to every portal at once.
            </p>
          </DocSection>

          <DocSection
            id="applications"
            kicker="Core workflows"
            title="Applications & screening"
          >
            <p>
              Every unit has a public application link you can share anywhere: a listing, an email,
              a text. Applicants fill it out with no account at <Chip>/rent/apply</Chip>, and their
              submission lands in your portal.
            </p>
            <p>
              Review applications side by side and pre-screen the ones worth pursuing. If someone
              starts but doesn&rsquo;t finish, PropLane can send them a completion reminder
              automatically, so promising applicants don&rsquo;t slip away.
            </p>
            <p>
              When you approve an applicant, everything you collected flows straight into a lease,
              with no re-typing (see below).
            </p>
          </DocSection>

          <DocSection id="leases" kicker="Core workflows" title="Leases & e-signature">
            <p>
              When you approve an applicant, the AI drafts a lease from their application. Names, the
              unit, rent, dates, and terms are pulled in for you, so you start from a filled-out draft
              instead of a blank page.
            </p>
            <p>
              Review and edit anything you like, then send it for signature. Both sides e-sign inside
              the portal, with no printing, scanning, or third-party tool. Once it&rsquo;s fully signed,
              the lease can be filed to your document library automatically.
            </p>
          </DocSection>

          <DocSection id="rent" kicker="Core workflows" title="Rent & payments">
            <p>
              Residents pay rent online from their portal. You see what&rsquo;s pending, what&rsquo;s
              paid, and each resident&rsquo;s running balance at a glance.
            </p>
            <DocList>
              <DocLi>
                <b className="font-medium text-foreground">Reminders</b> go out before and after the
                due date by email, and by text if you&rsquo;ve set up a work number.
              </DocLi>
              <DocLi>
                <b className="font-medium text-foreground">Late fees</b> apply automatically according
                to the rules you set.
              </DocLi>
              <DocLi>
                <b className="font-medium text-foreground">Receipts and statements</b> are available to
                residents, and partial payments are tracked against the balance.
              </DocLi>
            </DocList>
            <p>
              Every payment posts to the books the moment it clears, so you never re-enter a number in
              a spreadsheet (see <a href="#accounting" className="text-primary underline-offset-2 hover:underline">Accounting</a>).
            </p>
          </DocSection>

          <DocSection
            id="maintenance"
            kicker="Core workflows"
            title="Maintenance & work orders"
          >
            <p>
              Residents submit maintenance requests from their portal. Each one becomes a work order
              you can assign to a vendor.
            </p>
            <p>
              Need a price first? Invite the vendor to bid. They visit if needed, then submit a cost,
              a proposed time, and notes. You accept the bid you want, and the others are declined
              automatically.
            </p>
            <DocList>
              <DocLi>Request → assign a vendor → (optionally) schedule a visit</DocLi>
              <DocLi>Invite for bids → vendor submits a bid → accept one</DocLi>
              <DocLi>Work done → approve &amp; pay</DocLi>
            </DocList>
            <p>
              When you approve and pay, the vendor&rsquo;s labor is paid out through Stripe Connect
              and the expense is booked for you. A work order moves through{" "}
              <Chip>submitted → approved → scheduled → paid</Chip>.
            </p>
          </DocSection>

          <DocSection id="accounting" kicker="Books & data" title="Accounting & reports">
            <p>
              Under everything sits a real double-entry general ledger. Every charge, payment,
              expense, and payout writes a balanced journal entry. You never touch it, but the books
              always tie out.
            </p>
            <p>Run standard reports from the Finances section:</p>
            <DocList>
              <DocLi>Trial balance, balance sheet, and income statement</DocLi>
              <DocLi>General ledger and a cash-flow view</DocLi>
              <DocLi>Owner statements, AP aging, and budget vs. actual</DocLi>
              <DocLi>
                A security-deposit trust ledger with a three-way tie-out, plus a diagnostics report
                that flags anything out of balance
              </DocLi>
            </DocList>
            <p>
              Security deposits are held as a liability in trust (not counted as income) so your
              rental income stays honest.
            </p>
          </DocSection>

          <DocSection id="documents" kicker="Books & data" title="Documents">
            <p>
              The document library is your file store: leases, insurance certificates, invoices,
              inspections, notices, and photos. Files are private; access always goes through a
              short-lived signed link rather than a public URL.
            </p>
            <DocList>
              <DocLi>
                Organize by category and by the property, unit, lease, or vendor a file belongs to.
              </DocLi>
              <DocLi>
                Set expiration dates on things like insurance, and PropLane reminds you before they
                lapse.
              </DocLi>
              <DocLi>
                Share a file with a resident or vendor and it shows up in their portal under a{" "}
                <b className="font-medium text-foreground">Shared</b> tab.
              </DocLi>
            </DocList>
          </DocSection>

          <DocSection id="ai-assistant" kicker="Platform" title="The AI assistant">
            <p>
              Ask PropLane to do things in plain language: &ldquo;send a rent reminder to unit
              4,&rdquo; &ldquo;draft a lease for the approved applicant,&rdquo; &ldquo;what&rsquo;s my
              delinquency this month?&rdquo;
            </p>
            <p>
              The assistant works only through the same actions the app already exposes, so it
              can&rsquo;t reach around the product or touch another manager&rsquo;s data. Every number
              it reports comes from your real records. It never makes figures up.
            </p>
            <p className="rounded-lg border border-border bg-card px-4 py-3.5 text-[14px] text-foreground">
              <span className="mr-2 text-primary" aria-hidden>
                ✦
              </span>
              Every write action is previewed first. You see exactly what will happen and confirm it
              before anything sends, and each action is written to an audit log.
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
              Invite co-managers to help run your portfolio. Access is granted per property and per
              module, with <b className="font-medium text-foreground">read</b>,{" "}
              <b className="font-medium text-foreground">edit</b>, and{" "}
              <b className="font-medium text-foreground">delete</b> levels, so a bookkeeper can see
              the books without touching leases, and a leasing helper can work applications without
              seeing payouts.
            </p>
            <p>
              You can also add a work phone number for your business. Outbound texts (like rent
              reminders) send from that number, and replies come back into your PropLane inbox, so
              your personal number stays private.
            </p>
          </DocSection>

          <DocSection id="demo" kicker="Platform" title="The live demo">
            <p>
              Not ready to sign up? The live demo runs the real product in a sandbox you can click
              through with no account. Open all three portals (manager, resident, and vendor) and
              click through applications, leases, rent, and work orders at <Chip>/demo</Chip>.
            </p>
            <p>
              Anything you change in the demo is sandboxed to your browser and reset on refresh, so
              you can&rsquo;t break anything. When you&rsquo;re ready, create an account and set up
              your own portfolio in minutes.
            </p>
            <div className="mt-6 flex flex-col gap-3 sm:flex-row">
              <Link
                href="/auth/create-account?mode=create&role=manager"
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
            . PropLane is in beta and we answer fast.
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

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <code className="whitespace-nowrap rounded-[5px] border border-border bg-[var(--secondary)] px-1.5 py-0.5 font-mono text-[12.5px] text-muted">
      {children}
    </code>
  );
}
