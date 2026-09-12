import Link from "next/link";
import type { ReactNode } from "react";
import { iosAppDownloadUrl } from "@/lib/ios-app-download";
import { MockAvatar, MockChip, MockFrame, SiteIntro, SiteSection } from "@/components/marketing/site/primitives";
import { cn } from "@/lib/utils";

function Tile({
  title,
  body,
  children,
  className,
  wide = false,
}: {
  title: string;
  body: string;
  children: ReactNode;
  className?: string;
  wide?: boolean;
}) {
  return (
    <article
      className={cn(
        "flex min-w-0 flex-col rounded-2xl border border-border bg-card p-6",
        wide && "lg:col-span-2",
        className,
      )}
    >
      <h3 className="text-[18px] font-bold leading-snug tracking-tight text-foreground">{title}</h3>
      <p className="mt-2 text-[14.5px] leading-relaxed text-muted">{body}</p>
      <div className="mt-5 flex-1">{children}</div>
    </article>
  );
}

function Line({ left, right, tone }: { left: ReactNode; right: ReactNode; tone?: "good" | "warn" | "bad" | "info" | "neutral" }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2 text-[13px]">
      <span className="min-w-0 truncate text-foreground">{left}</span>
      {tone ? <MockChip tone={tone}>{right}</MockChip> : <span className="shrink-0 font-semibold text-foreground">{right}</span>}
    </div>
  );
}

/** Everything a portfolio needs — six things, one queue, each a real screen. */
export function SiteBento() {
  return (
    <SiteSection id="product" tone="muted" ariaLabelledBy="site-bento-title">
      <SiteIntro
        eyebrow="Everything a portfolio needs"
        id="site-bento-title"
        title="Six things, one queue."
        lede="Each of these is a live screen in the product. Every draft they produce lands in the same approval queue."
      />
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <Tile
          title="Leasing that fills itself"
          body="Public listing, apply link, tours that book themselves, screening, and a lease drafted from the application. E-sign both sides."
        >
          <MockFrame title="Applications · Pending" aside={<MockChip tone="bad">3</MockChip>}>
            <div className="divide-y divide-border/60">
              <Line left="Maya Chen · Cascade Lofts 4B" right="Screening clear" tone="good" />
              <Line left="Dev Ramos · Ballard Commons 1C" right="New" tone="info" />
            </div>
          </MockFrame>
        </Tile>
        <Tile title="Rent without the chase" body="Card, bank or Zelle; reminders that draft first; late fees you set once.">
          <MockFrame title="Payments · This month">
            <p className="text-[12px] font-semibold uppercase tracking-wide text-muted">Collected this month</p>
            <p className="mt-1 text-[28px] font-bold tabular-nums tracking-tight text-foreground">$7,250</p>
            <p className="mt-1 flex items-center gap-2 text-[12.5px] text-muted">
              of $11,700 due <MockChip tone="bad">2 overdue</MockChip>
            </p>
          </MockFrame>
        </Tile>
        <Tile title="One inbox" body="Residents, applicants, vendors — email, text and in-app in one thread, with a draft waiting on each.">
          <MockFrame title="Inbox">
            <div className="divide-y divide-border/60">
              {[
                ["Dana Reyes", "Draft", "warn"],
                ["Marcus Kim", "Email", "neutral"],
                ["Pacific Plumbing", "Text", "neutral"],
              ].map(([n, r, t]) => (
                <div key={n} className="flex items-center gap-2.5 py-2">
                  <MockAvatar name={n!} className="h-7 w-7 text-[10px]" />
                  <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">{n}</span>
                  <MockChip tone={t as "warn" | "neutral"}>{r}</MockChip>
                </div>
              ))}
            </div>
          </MockFrame>
        </Tile>
        <Tile title="Vendors who show up" body="Request → bids → visit → invoice → payout, tracked from your inbox to their phone.">
          <MockFrame title="Services · Maple 2A">
            <div className="divide-y divide-border/60">
              <Line left="Faucet · Maple 2A" right="Booked Thu" tone="info" />
              <Line left="Pacific Plumbing · $140 bid" right="Accepted" tone="good" />
            </div>
          </MockFrame>
        </Tile>
        <Tile
          wide
          title="Books that balance, and a phone that rings"
          body="Every charge and payment writes through to a real ledger; deposits stay liability. A dedicated work number texts and calls under your name, and the same queue lives in the iPhone app."
        >
          <div className="grid gap-3 sm:grid-cols-[1.2fr_1fr]">
            <MockFrame title="Finances · September">
              <div className="divide-y divide-border/60">
                <Line left="Rent · Sep" right="$7,250" />
                <Line left="Repairs" right="–$540" />
                <Line left={<b>Net</b>} right={<b>$6,710</b>} />
              </div>
            </MockFrame>
            <div className="grid gap-3">
              <div className="rounded-xl border border-border bg-card p-4">
                <p className="text-[18px] font-bold tabular-nums tracking-tight text-foreground">(206) 555-0100</p>
                <p className="text-[12.5px] text-muted">Your work number</p>
              </div>
              <Link
                href={iosAppDownloadUrl()}
                target="_blank"
                rel="noreferrer noopener"
                data-attr="home-bento-app-store"
                className="flex items-center justify-between rounded-xl border border-border bg-card p-4 transition hover:border-foreground/25"
              >
                <span>
                  <span className="block text-[14px] font-bold text-foreground">iPhone app</span>
                  <span className="block text-[12.5px] text-muted">App Store</span>
                </span>
                <span aria-hidden className="text-muted">→</span>
              </Link>
            </div>
          </div>
        </Tile>
      </div>
    </SiteSection>
  );
}
