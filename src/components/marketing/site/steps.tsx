import { MockApproveRow, MockChip, MockDraft, SiteIntro, SiteSection } from "@/components/marketing/site/primitives";
import type { ReactNode } from "react";

const STEPS: { n: number; title: string; body: string; mock: ReactNode }[] = [
  {
    n: 1,
    title: "List a home in four answers",
    body: "Address, how you rent it, bedrooms, rent. Photos and the rest later. Your public listing, apply link and tour booking are live.",
    mock: (
      <div className="rounded-xl border border-border bg-card p-3 text-[12.5px]">
        <p className="font-semibold text-foreground">142 Ash St · By the room · 2 rooms · From $1,160</p>
        <p className="mt-1 flex items-center gap-2 text-muted">
          <MockChip tone="good">Listed</MockChip> proplane.app/rent/ash-flats-6
        </p>
      </div>
    ),
  },
  {
    n: 2,
    title: "The AI drafts the busywork",
    body: "Replies to every message, the lease from the application, rent reminders, vendor requests — drafted in your voice, waiting in one queue.",
    mock: (
      <MockDraft label="Lease draft · Maya Chen · 12 months · $1,160">
        <span className="text-muted">Draft generated from her application in 40s</span>
      </MockDraft>
    ),
  },
  {
    n: 3,
    title: "You approve, or you don’t",
    body: "Approve, edit, or discard. One queue on web and iPhone; nothing sends without you. A reminder, a lease, a $50 late fee — same rule.",
    mock: (
      <div className="rounded-xl border border-border bg-card p-3">
        <MockApproveRow />
      </div>
    ),
  },
];

/** How it works: three steps, the third one the manager's. */
export function SiteSteps() {
  return (
    <SiteSection id="how-it-works" ariaLabelledBy="site-steps-title">
      <SiteIntro
        eyebrow="How it works"
        id="site-steps-title"
        title="Three steps. The third one is yours."
        lede="Nothing reaches a resident, an applicant or a vendor until you approve it. That is the product."
      />
      <ol className="grid gap-4 md:grid-cols-3">
        {STEPS.map((s) => (
          <li key={s.n} className="flex flex-col rounded-2xl border border-border bg-card p-6">
            <span className="grid h-9 w-9 place-items-center rounded-full bg-primary text-[14px] font-bold text-white">{s.n}</span>
            <h3 className="mt-4 text-[18px] font-bold leading-snug tracking-tight text-foreground">{s.title}</h3>
            <p className="mt-2 flex-1 text-[14.5px] leading-relaxed text-muted">{s.body}</p>
            <div className="mt-5">{s.mock}</div>
          </li>
        ))}
      </ol>
    </SiteSection>
  );
}
