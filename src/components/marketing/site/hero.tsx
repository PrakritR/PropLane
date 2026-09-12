import { MockApproveRow, MockAvatar, MockButton, MockChip, MockDraft, MockFrame, SITE_MEASURE, SiteCtaPair, SiteEyebrow, SiteHeading } from "@/components/marketing/site/primitives";

/**
 * The home hero. One argument in one screen: the AI does the busywork, you
 * approve — the headline says it, and the card beside it shows the queue where
 * that approval happens (the dashboard's Needs attention list with a drafted
 * reply waiting on Approve & send).
 */
export function SiteHero() {
  return (
    <section className="relative overflow-hidden border-b border-border/70" aria-labelledby="site-hero-title">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_50%_at_75%_10%,rgba(40,99,240,0.12),transparent_70%)]"
      />
      <div className={`${SITE_MEASURE} relative grid items-center gap-12 pb-16 pt-14 sm:pt-16 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)] lg:gap-14 lg:pb-20 lg:pt-20`}>
        <div className="min-w-0 max-w-[36rem]">
          <SiteEyebrow className="mb-4 flex items-center gap-1.5">
            <span aria-hidden>✦</span> Approval-first property management
          </SiteEyebrow>
          <SiteHeading as="h1" id="site-hero-title">
            The AI does the busywork.
            <br />
            <span className="text-primary">You approve.</span>
          </SiteHeading>
          <p className="mt-5 max-w-[46ch] text-[16.5px] leading-relaxed text-muted sm:text-[17.5px]">
            One place to list a home, take applications, draft the lease, collect rent and handle repairs — with every
            message and charge waiting for your OK before it goes out.
          </p>
          <SiteCtaPair
            className="mt-8"
            primaryAttr="home-hero-get-started"
            secondaryAttr="home-hero-book-demo"
            primaryLabel="Start free — no card"
            note="Free for one home. Pro is $20 a month · 14-day trial · Web and iPhone"
          />
        </div>

        <div className="mx-auto w-full max-w-[560px] min-w-0 lg:ml-auto lg:mr-0">
          <HeroQueueCard />
        </div>
      </div>
    </section>
  );
}

/** The dashboard's Needs attention queue, plus the inbox draft under it. */
function HeroQueueCard() {
  return (
    <div className="space-y-3">
      <MockFrame
        title="proplane.app/portal/dashboard"
        aside={<span className="text-[11.5px] font-semibold text-muted">This month ▾</span>}
      >
        <div className="mb-2 flex items-center justify-between px-2">
          <span className="text-[13px] font-bold text-foreground">Needs attention</span>
          <MockChip tone="bad">3</MockChip>
        </div>
        <ul className="divide-y divide-border/60">
          {[
            { name: "Maya Chen", title: "Maya Chen · application", sub: "Cascade Lofts · Room 4B · screening clear", action: "Review" },
            { name: "Priya Nair", title: "Priya Nair · lease waits for your signature", sub: "Resident signed 2h ago", action: "Sign" },
            { name: "Jordan Lee", title: "Jordan Lee · rent 3 days late", sub: "$1,240 · reminder drafted", action: "Remind" },
          ].map((row) => (
            <li key={row.name} className="flex items-center gap-3 px-2 py-2.5">
              <MockAvatar name={row.name} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-semibold text-foreground">{row.title}</span>
                <span className="block truncate text-[12px] text-muted">{row.sub}</span>
              </span>
              <MockButton>{row.action}</MockButton>
            </li>
          ))}
        </ul>
      </MockFrame>

      <MockFrame title="Inbox · Dana Reyes" aside={<MockChip tone="warn">Draft · pending approval</MockChip>}>
        <p className="mb-3 rounded-xl bg-accent/50 px-3 py-2 text-[13px] leading-relaxed text-foreground/90">
          &ldquo;Hi, the kitchen faucet in Maple 2A has been dripping for two days. Can someone take a look?&rdquo;
        </p>
        <MockDraft>
          &ldquo;Thanks Dana — I&rsquo;ve booked Pacific Plumbing for Thursday 10–12. They&rsquo;ll text before arriving.&rdquo;{" "}
          <span className="text-muted">Vendor: Pacific Plumbing</span>
        </MockDraft>
        <div className="mt-3">
          <MockApproveRow />
        </div>
      </MockFrame>
    </div>
  );
}
