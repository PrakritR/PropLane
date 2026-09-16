import type { Metadata } from "next";
import { ServiceConfirmForm } from "./service-confirm-form";

export const metadata: Metadata = {
  title: "Was this fixed?",
  description: "Confirm whether a service visit resolved the issue.",
};

/**
 * Public, no-login: the resident's answer to "was this fixed?" (PLAN-0915).
 *
 * Opened from the completion email or text, usually on a phone that has never
 * signed in, so the token in the URL is the only authorization. The token was
 * minted for one work order and one ask, is only stored hashed, and lapses
 * after seven days — see `work-order-resident-confirmation.server.ts`.
 */
export default async function ServiceConfirmPage({ searchParams }: { searchParams: Promise<{ t?: string }> }) {
  const { t } = await searchParams;
  return (
    <div className="min-h-screen px-4 py-16 sm:py-20 [html[data-native]_&]:py-4 [html[data-native]_&]:pt-[max(1rem,env(safe-area-inset-top))]">
      <article className="glass-card mx-auto max-w-lg rounded-3xl px-6 py-10 sm:px-10 sm:py-12">
        <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-primary/80">Service visit</p>
        <ServiceConfirmForm token={String(t ?? "").trim()} />
      </article>
    </div>
  );
}
