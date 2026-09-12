import Link from "next/link";
import { BOOK_DEMO_HREF } from "@/lib/marketing/public-contact";
import { SiteIntro, SiteSection } from "@/components/marketing/site/primitives";

/**
 * Proof, honestly.
 *
 * There are no customer quotes on the site yet that are real, so this section
 * carries only what is true by construction: every outbound message, charge
 * and lease waits for a manager's OK. Beside it, the honest second door — a
 * 20-minute call with the manager's own homes on screen. Quotes get a tile
 * here the day they are real, not before; and the embedded demo stays off the
 * page until its sample data ships, because an empty portal proves nothing.
 */
export function SiteProof() {
  return (
    <SiteSection id="proof" tone="muted" ariaLabelledBy="site-proof-title">
      <SiteIntro eyebrow="Proof" id="site-proof-title" title="The one number we can promise." />
      <div className="grid gap-4 md:grid-cols-[1.2fr_1fr]">
        <div className="rounded-2xl border border-border bg-card p-7 sm:p-9">
          <p className="text-[clamp(3.5rem,8vw,6rem)] font-bold leading-none tracking-[-0.04em] text-primary">100%</p>
          <p className="mt-4 max-w-[40ch] text-[17px] font-semibold leading-snug text-foreground">
            of outbound messages, charges and leases wait for a manager&rsquo;s OK. Zero sent on their own.
          </p>
          <p className="mt-2 text-[13.5px] text-muted">True by construction — the assistant can draft, and only a person can send.</p>
        </div>
        <Link
          href={BOOK_DEMO_HREF}
          data-attr="home-proof-demo"
          className="group flex flex-col justify-between rounded-2xl border border-border bg-card p-7 transition hover:border-primary/40 sm:p-9"
        >
          <div>
            <p className="text-[12.5px] font-bold uppercase tracking-[0.08em] text-primary">See it on your homes</p>
            <p className="mt-3 text-[22px] font-bold leading-tight tracking-tight text-foreground">
              Twenty minutes, your portfolio on screen, no deck.
            </p>
            <p className="mt-2 text-[14.5px] leading-relaxed text-muted">
              Bring one address. We list it live, show the first drafts land in the queue, and you approve one.
            </p>
          </div>
          <span className="mt-6 inline-flex items-center gap-1.5 text-[15px] font-bold text-primary">
            Book a demo <span aria-hidden className="transition-transform group-hover:translate-x-0.5">→</span>
          </span>
        </Link>
      </div>
    </SiteSection>
  );
}
