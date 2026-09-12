"use client";

import { PartnerMeetingScheduler } from "@/components/partner/partner-meeting-scheduler";
import { MarketingPageShell } from "@/components/marketing/marketing-page-shell";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { SegmentedTwo } from "@/components/ui/segmented-control";
import {
  PUBLIC_SUPPORT_EMAIL,
  PUBLIC_SUPPORT_PHONE_DISPLAY,
  PUBLIC_SUPPORT_PHONE_TEL,
} from "@/lib/marketing/public-contact";
import { SITE_MEASURE } from "@/components/marketing/site/primitives";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import "@/components/marketing/landing-proplane.css";
import { Select } from "@/components/ui/input";

const TOPICS = [
  "General question",
  "Property management services",
  "Leasing & availability",
  "Support",
  "Other",
];

export default function ContactPage() {
  return (
    <Suspense
      fallback={
        <MarketingPageShell>
          <div className="lp-w py-20 text-center text-sm text-[var(--lp-muted)]">Loading…</div>
        </MarketingPageShell>
      }
    >
      <ContactInner />
    </Suspense>
  );
}

function ContactInner() {
  const { showToast } = useAppUi();
  const router = useRouter();
  const searchParams = useSearchParams();
  const tab = searchParams.get("tab") === "schedule" ? "schedule" : "message";

  useEffect(() => {
    if (tab !== "schedule") return;
    document.getElementById("book-a-demo")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [tab]);

  const setTab = (next: "schedule" | "message") => {
    router.replace(next === "schedule" ? "/contact?tab=schedule" : "/contact?tab=message", {
      scroll: false,
    });
  };

  const onCall = [
    "Twenty minutes, on a call — no deck.",
    "Bring one address. We list it live and show the first drafts land in your queue.",
    "You approve one. Then you decide.",
  ];
  const onMessage = [
    "A person reads it — the same team that runs PropLane on their own homes.",
    "Expect a reply within one business day.",
    `Prefer email? ${PUBLIC_SUPPORT_EMAIL} reaches the same inbox.`,
  ];
  return (
    <MarketingPageShell>
      <header className="lp-page-hero lp-page-hero--start">
        <div className={`${SITE_MEASURE} max-w-[860px]`}>
          <p className="lp-page-eyebrow">Contact</p>
          <h1 className="lp-page-title lp-page-title-wide">Talk to the people who built it.</h1>
          <p className="lp-page-lede">Text or call, email, or book twenty minutes with your homes on screen.</p>
        </div>
      </header>

      {/* Three ways to reach a human, then the form under them. */}
      <div className={`${SITE_MEASURE} grid gap-4 pb-12 sm:grid-cols-3`}>
        <a
          href={`tel:${PUBLIC_SUPPORT_PHONE_TEL}`}
          data-attr="contact-card-phone"
          className="rounded-2xl border border-border bg-card p-5 transition hover:border-primary/40"
        >
          <p className="text-[12px] font-bold uppercase tracking-[0.08em] text-primary">Text or call</p>
          <p className="mt-2 text-[17px] font-bold tabular-nums tracking-tight text-foreground">{PUBLIC_SUPPORT_PHONE_DISPLAY}</p>
          <p className="mt-1 text-[13px] text-muted">Weekdays, Pacific time.</p>
        </a>
        <a
          href={`mailto:${PUBLIC_SUPPORT_EMAIL}`}
          data-attr="contact-card-email"
          className="rounded-2xl border border-border bg-card p-5 transition hover:border-primary/40"
        >
          <p className="text-[12px] font-bold uppercase tracking-[0.08em] text-primary">Email support</p>
          <p className="mt-2 break-words text-[17px] font-bold tracking-tight text-foreground">{PUBLIC_SUPPORT_EMAIL}</p>
          <p className="mt-1 text-[13px] text-muted">Within one business day.</p>
        </a>
        <Link
          href="/partner/contact"
          data-attr="contact-card-partner"
          className="rounded-2xl border border-border bg-card p-5 transition hover:border-primary/40"
        >
          <p className="text-[12px] font-bold uppercase tracking-[0.08em] text-primary">Partner inquiries</p>
          <p className="mt-2 text-[17px] font-bold tracking-tight text-foreground">Property companies &amp; vendors at scale</p>
          <p className="mt-1 text-[13px] text-muted">A separate door for partnerships.</p>
        </Link>
      </div>

      <section className={`${SITE_MEASURE} grid items-start gap-10 pb-20 lg:grid-cols-[minmax(0,1fr)_320px] lg:gap-16`}>
        <div className="min-w-0">
          <SegmentedTwo
            value={tab}
            onChange={setTab}
            left={{ id: "schedule", label: "Book a demo" }}
            right={{ id: "message", label: "Send message" }}
          />
          <div key={tab} className="animate-fade-in text-left">
            {tab === "message" ? (
              <ContactMessageForm showToast={showToast} />
            ) : (
              <div id="book-a-demo" className="mt-6 scroll-mt-28">
                <PartnerMeetingScheduler showToast={showToast} />
              </div>
            )}
          </div>
        </div>
        <aside className="rounded-2xl border border-border bg-[var(--pl-surface-muted)] p-6 [html[data-theme=dark]_&]:bg-white/[0.03] lg:sticky lg:top-24">
          <p className="text-[12px] font-bold uppercase tracking-[0.08em] text-primary">
            {tab === "schedule" ? "What happens on the call" : "What happens next"}
          </p>
          <ul className="mt-3 space-y-3">
            {(tab === "schedule" ? onCall : onMessage).map((line) => (
              <li key={line} className="flex items-start gap-2.5 text-[14.5px] leading-relaxed text-foreground/90">
                <span aria-hidden className="mt-[8px] h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                {line}
              </li>
            ))}
          </ul>
        </aside>
      </section>
    </MarketingPageShell>
  );
}

function ContactMessageForm({ showToast }: { showToast: (m: string) => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [topic, setTopic] = useState("");
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    const n = name.trim();
    const em = email.trim();
    const tp = topic.trim();
    const msg = body.trim();
    if (!n || !em) {
      showToast("Please enter your name and email.");
      return;
    }
    if (!tp) {
      showToast("Please choose a topic.");
      return;
    }
    if (!msg) {
      showToast("Please enter a message.");
      return;
    }
    if (submitting) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/public/contact-message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: n, email: em, topic: tp, body: msg }),
      });
      if (!res.ok) {
        showToast(`Could not send your message. Please try again or email ${PUBLIC_SUPPORT_EMAIL}.`);
        return;
      }
      showToast("Message sent. Our team will get back to you soon.");
      setName("");
      setEmail("");
      setTopic("");
      setBody("");
    } catch {
      showToast(`Could not send your message. Please try again or email ${PUBLIC_SUPPORT_EMAIL}.`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="lp-page-form space-y-4">
      <div className="lp-page-field-row">
        <div className="lp-page-field">
          <label htmlFor="contact-name">Name *</label>
          <input
            id="contact-name"
            type="text"
            placeholder="Jane Smith"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="lp-page-field">
          <label htmlFor="contact-email">Email *</label>
          <input
            id="contact-email"
            type="email"
            placeholder="jane@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
      </div>

      <div className="lp-page-field">
        <label htmlFor="contact-topic">Topic *</label>
        <Select id="contact-topic" value={topic} onChange={(e) => setTopic(e.target.value)}>
          <option value="">Select…</option>
          {TOPICS.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </Select>
      </div>

      <div className="lp-page-field">
        <label htmlFor="contact-body">Message *</label>
        <textarea
          id="contact-body"
          rows={8}
          placeholder="What can we help you with?"
          className="min-h-[180px] resize-y leading-relaxed"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
      </div>

      <button
        type="button"
        data-attr="contact-us-submit"
        onClick={submit}
        disabled={submitting}
        className="lp-btn lp-btn-blue lp-lg mt-2 w-full disabled:cursor-not-allowed disabled:opacity-60"
      >
        {submitting ? "Sending…" : "Send message"}
      </button>
    </div>
  );
}
