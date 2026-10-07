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
import { Building2, Mail, Phone } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import "@/components/marketing/landing-proplane.css";
import { Select } from "@/components/ui/input";

const CONTACT_CARD =
  "flex flex-col items-center rounded-2xl border border-[#dbe4ef] bg-white/85 p-6 text-center shadow-[0_18px_44px_-30px_rgba(19,43,71,0.3)] transition-[border-color,transform] duration-100 hover:-translate-y-0.5 hover:border-[#8fb0d4]";
const CONTACT_ICON =
  "mb-3 grid h-10 w-10 place-items-center rounded-xl bg-[#1769bd]/10 text-[#1769bd] [&>svg]:h-[18px] [&>svg]:w-[18px]";
const CONTACT_LABEL = "text-[12px] font-bold uppercase tracking-[0.08em] text-[#1a47bd]";

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

  return (
    <MarketingPageShell>
      <header className="lp-page-hero lp-page-hero--start">
        <div className={`${SITE_MEASURE} max-w-[860px]`}>
          <p className="lp-page-eyebrow">Contact</p>
          <h1 className="lp-page-title lp-page-title-wide">Talk to the people who built it.</h1>
        </div>
      </header>

      {/* One centered column: three ways to reach a human, then the form under them. */}
      <div className={`${SITE_MEASURE} flex flex-col items-center pb-20 pt-8 sm:pb-24 sm:pt-12`}>
        <div className="grid w-full max-w-[60rem] gap-4 sm:grid-cols-3">
          <a href={`tel:${PUBLIC_SUPPORT_PHONE_TEL}`} data-attr="contact-card-phone" className={CONTACT_CARD}>
            <span className={CONTACT_ICON}>
              <Phone strokeWidth={2} aria-hidden />
            </span>
            <p className={CONTACT_LABEL}>Text or call</p>
            <p className="mt-2 text-[17px] font-bold tabular-nums tracking-tight text-foreground">{PUBLIC_SUPPORT_PHONE_DISPLAY}</p>
          </a>
          <a href={`mailto:${PUBLIC_SUPPORT_EMAIL}`} data-attr="contact-card-email" className={CONTACT_CARD}>
            <span className={CONTACT_ICON}>
              <Mail strokeWidth={2} aria-hidden />
            </span>
            <p className={CONTACT_LABEL}>Email support</p>
            <p className="mt-2 break-words text-[17px] font-bold tracking-tight text-foreground">{PUBLIC_SUPPORT_EMAIL}</p>
          </a>
          <Link href="/partner/contact" data-attr="contact-card-partner" className={CONTACT_CARD}>
            <span className={CONTACT_ICON}>
              <Building2 strokeWidth={2} aria-hidden />
            </span>
            <p className={CONTACT_LABEL}>Partner inquiries</p>
            <p className="mt-2 text-[17px] font-bold tracking-tight text-foreground">Property companies &amp; vendors at scale</p>
          </Link>
        </div>

        <section
          aria-label="Contact form"
          className="mt-10 w-full min-w-0 max-w-[720px] rounded-2xl border border-[#dbe4ef] bg-white/88 p-4 shadow-[0_24px_60px_-34px_rgba(19,43,71,0.3)] sm:mt-12 sm:p-7"
        >
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
          {/*
            "What happens on the call" was four bullets explaining a twenty-minute
            call the button already offers. The form is the page; the explanation
            belonged to the booking step, not beside it.
          */}
        </section>
      </div>
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
    <div className="lp-page-form !max-w-none space-y-4">
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
