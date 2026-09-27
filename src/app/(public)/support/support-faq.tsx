"use client";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import Link from "next/link";
import { PUBLIC_SUPPORT_EMAIL } from "@/lib/marketing/public-contact";

type FaqItem = {
  q: string;
  a: React.ReactNode;
};

const RESIDENT_FAQS: FaqItem[] = [
  {
    q: "How do I pay my rent?",
    a: (
      <>
        Sign in to the resident portal and open <strong className="font-medium text-foreground">Payments</strong>.
        Rent is processed securely through Stripe. You can pay by bank transfer or card, and set up reminders so you
        never miss a due date.
      </>
    ),
  },
  {
    q: "I can't sign in or forgot my password.",
    a: (
      <>
        Use the password reset link on the{" "}
        <Link href="/auth/sign-in" className="font-medium text-primary hover:opacity-90">
          sign-in page
        </Link>
        . If you were invited by a property manager and never finished setup, ask them to resend your invitation, or
        email us at{" "}
        <a href={`mailto:${PUBLIC_SUPPORT_EMAIL}`} className="font-medium text-[var(--pl-brand)] hover:opacity-90">
          {PUBLIC_SUPPORT_EMAIL}
        </a>
        .
      </>
    ),
  },
  {
    q: "How do I submit a maintenance request?",
    a: (
      <>
        Open the resident portal and go to <strong className="font-medium text-foreground">Services</strong>. You
        can describe the issue and attach photos from your phone&rsquo;s camera or photo library. Your property manager
        is notified right away.
      </>
    ),
  },
  {
    q: "Is there a mobile app?",
    a: (
      <>
        Yes, PropLane is available for iOS and Android. Download the app and sign in with the same account you use on the
        web. Enable push notifications to get rent reminders and messages instantly.
      </>
    ),
  },
  {
    q: "I have a question about my lease, deposit, or balance.",
    a: (
      <>
        Questions about your specific tenancy are handled by your property manager, who has the full context for your
        unit. Message them directly from the <strong className="font-medium text-foreground">Messages</strong> tab in
        the resident portal.
      </>
    ),
  },
];

const MANAGER_FAQS: FaqItem[] = [
  {
    q: "How do I get started as a property manager?",
    a: (
      <>
        Create an account, add your properties, and invite residents. Applications, screening, leases, and rent
        collection all run from the manager portal. For a guided walkthrough,{" "}
        <Link href="/partner/contact?tab=schedule" className="font-medium text-primary hover:opacity-90">
          schedule a meeting
        </Link>{" "}
        with our team.
      </>
    ),
  },
  {
    q: "How does billing and my subscription work?",
    a: (
      <>
        See current plans on the{" "}
        <Link href="/partner/pricing" className="font-medium text-primary hover:opacity-90">
          pricing page
        </Link>
        . For invoices, upgrades, or billing questions, reach out through{" "}
        <Link href="/partner/contact" className="font-medium text-primary hover:opacity-90">
          partner inquiries
        </Link>{" "}
        and we&rsquo;ll get back to you.
      </>
    ),
  },
  {
    q: "How is my data kept secure?",
    a: (
      <>
        Data is encrypted in transit, access is scoped per account, and payments are handled by Stripe, so we never store
        full card or bank numbers. Read the details in our{" "}
        <Link href="/privacy" className="font-medium text-primary hover:opacity-90">
          Privacy Policy
        </Link>
        .
      </>
    ),
  },
];

function FaqGroup({ title, items, idPrefix }: { title: string; items: FaqItem[]; idPrefix: string }) {
  return (
    <section>
      <h2 className="text-lg font-semibold text-foreground">{title}</h2>
      <Accordion type="single" collapsible className="mt-2">
        {items.map((item, i) => (
          <AccordionItem key={`${idPrefix}-${i}`} value={`${idPrefix}-${i}`} className="border-border">
            <AccordionTrigger className="text-start text-[15px] text-foreground hover:no-underline">
              {item.q}
            </AccordionTrigger>
            <AccordionContent className="text-[15px] leading-relaxed text-muted">{item.a}</AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    </section>
  );
}

export function SupportFaq() {
  return (
    <div className="space-y-10">
      <FaqGroup title="For residents" items={RESIDENT_FAQS} idPrefix="resident" />
      <FaqGroup title="For property managers" items={MANAGER_FAQS} idPrefix="manager" />
    </div>
  );
}
