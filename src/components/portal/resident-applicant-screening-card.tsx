"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { StripeEmbeddedCheckout } from "@/components/stripe-embedded-checkout";
import { Button } from "@/components/ui/button";
import { formatCheckrPrice } from "@/lib/checkr/packages";
import type { ApplicantScreeningView } from "@/lib/screening/applicant-screening";

type LoadState = { kind: "loading" } | { kind: "ready"; view: ApplicantScreeningView } | { kind: "none" };

/**
 * The applicant's own background check (Checkr Starter, plus ID verification when the listing asks for it): the
 * itemized total is on screen BEFORE they confirm, the FCRA disclosure is shown on its own with an explicit
 * authorization, and only then does the embedded Stripe form open. Draws nothing when the listing offers nothing.
 * The applicant sees progress and "Verified"; the report itself is the manager's.
 */
export function ResidentApplicantScreeningCard({ applicationId, className }: { applicationId: string; className?: string }) {
  const pathname = usePathname();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [authorized, setAuthorized] = useState(false);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/screening/applicant-quote?applicationId=${encodeURIComponent(applicationId)}`, {
        credentials: "include",
        cache: "no-store",
      });
      if (!res.ok) return setState({ kind: "none" });
      setState({ kind: "ready", view: (await res.json()) as ApplicantScreeningView });
    } catch {
      setState({ kind: "none" });
    }
  }, [applicationId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Back from Stripe: confirm the paid session server-side (the webhook is the same idempotent path).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get("session_id");
    if (params.get("screening") !== "return" || !sessionId) return;
    void fetch("/api/screening/checkout-verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ sessionId }),
    }).finally(() => void load());
  }, [load]);

  if (state.kind !== "ready") return null;
  const { view } = state;

  if (view.check) {
    return (
      <section className={className} data-attr="applicant-screening-status">
        <p className="flex items-center gap-1.5 text-sm font-medium text-foreground">
          <ShieldCheck className="h-4 w-4 shrink-0 text-primary" aria-hidden />
          {view.check.status === "complete" ? "Background check complete" : "Background check in progress"}
          {view.check.idVerified ? " · Verified" : ""}
        </p>
      </section>
    );
  }
  if (view.offer.kind === "id_unavailable") {
    return (
      <section className={className} data-attr="applicant-screening-id-unavailable">
        <p className="text-sm font-medium text-foreground">ID check unavailable</p>
      </section>
    );
  }
  if (view.offer.kind !== "offer") return null;
  const { quote } = view.offer;

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/screening/applicant-checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          applicationId,
          authorize: authorized,
          disclosureVersion: view.disclosure.version,
          returnPath: pathname,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { clientSecret?: string; ran?: boolean; error?: string };
      if (!res.ok) return setError(data.error ?? "Could not start payment. Please try again.");
      if (data.ran) return void (await load());
      if (!data.clientSecret) return setError("Could not start payment. Please try again.");
      setClientSecret(data.clientSecret);
    } catch {
      setError("Could not start payment. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={`space-y-3 ${className ?? ""}`.trim()} data-attr="applicant-screening-card">
      <h3 className="text-sm font-semibold text-foreground">Background check</h3>
      <dl className="space-y-1 text-sm" data-attr="applicant-screening-summary">
        <div className="flex items-center justify-between gap-3">
          <dt className="text-foreground">{quote.packageName} background check</dt>
          <dd className="shrink-0 tabular-nums font-medium">{formatCheckrPrice(quote.packageCents)}</dd>
        </div>
        {quote.idCheckCents > 0 ? (
          <div className="flex items-center justify-between gap-3">
            <dt className="text-foreground">ID verification</dt>
            <dd className="shrink-0 tabular-nums font-medium">{formatCheckrPrice(quote.idCheckCents)}</dd>
          </div>
        ) : null}
        <div className="flex items-center justify-between gap-3 border-t border-border pt-2">
          <dt className="font-semibold text-foreground">Total</dt>
          <dd className="shrink-0 tabular-nums text-base font-bold text-foreground">{formatCheckrPrice(quote.totalCents)}</dd>
        </div>
      </dl>
      {clientSecret ? (
        <StripeEmbeddedCheckout clientSecret={clientSecret} className="min-h-[320px] overflow-hidden rounded-2xl border border-border bg-card" />
      ) : (
        <>
          <div
            className="max-h-40 overflow-y-auto rounded-xl border border-border bg-card p-3 text-xs text-foreground"
            data-attr="applicant-screening-disclosure"
            role="region"
            aria-label="Consumer report disclosure"
          >
            {view.disclosure.text}
          </div>
          <label className="flex items-start gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 shrink-0"
              checked={authorized}
              onChange={(event) => setAuthorized(event.target.checked)}
              data-attr="applicant-screening-authorize"
            />
            <span>{view.disclosure.authorizationLabel}</span>
          </label>
          {error ? <p className="text-xs font-medium text-red-600">{error}</p> : null}
          <Button type="button" disabled={!authorized || busy} onClick={() => start()} data-attr="applicant-screening-pay">
            {`Pay ${formatCheckrPrice(quote.totalCents)} and continue`}
          </Button>
        </>
      )}
    </section>
  );
}
