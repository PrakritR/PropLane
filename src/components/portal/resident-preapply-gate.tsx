"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { AlertCircle, Check, Circle, Loader2 } from "lucide-react";
import { StripeEmbeddedCheckout } from "@/components/stripe-embedded-checkout";
import { Button } from "@/components/ui/button";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { formatCheckrPrice } from "@/lib/checkr/packages";
import type { PreApplyStep } from "@/lib/screening/preapply";
import type { PreApplyApiView } from "@/lib/screening/preapply-view";

const VERIFY_ID_HREF = "/resident/profile?tab=profile#verification";
const POLL_MS = 8000;

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; view: PreApplyApiView }
  | { kind: "unavailable" };

function stepGlyph(step: PreApplyStep | "application", active: boolean): ReactNode {
  if (step === "application") return <Circle className="h-4 w-4 shrink-0 text-muted" aria-hidden />;
  if (step.status === "done") return <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden />;
  if (step.status === "in_progress") return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" aria-hidden />;
  if (step.status === "blocked") return <AlertCircle className="h-4 w-4 shrink-0 text-red-600" aria-hidden />;
  return <Circle className={`h-4 w-4 shrink-0 ${active ? "text-primary" : "text-muted"}`} aria-hidden />;
}

function stepStatusText(step: PreApplyStep): string {
  if (step.status === "done") return "Done";
  if (step.status === "in_progress") return step.satisfied ? "Ordered" : "In progress";
  if (step.status === "blocked") return step.reason === "unavailable" ? "Unavailable" : "Needs review";
  return "To do";
}

/**
 * What an applicant completes BEFORE the application form opens, chosen by the property's manager: Verify ID,
 * Background check, either, both or none. One step list (Verify ID, Background check, Application) with a status per
 * step; coming back later lands on the next step. The form (`children`) only mounts once every required step is
 * satisfied. This is the screen, not the rule: the server refuses the application submit on its own
 * (`preApplySubmitGate`).
 *
 * A listing that requires nothing, a /demo session, a signed-out visitor and a listing the server cannot resolve all
 * render the form unchanged.
 */
export function ResidentPreApplyGate({ propertyId, children }: { propertyId?: string | null; children: ReactNode }) {
  const property = propertyId?.trim() ?? "";
  const demo = isDemoModeActive();
  const [state, setState] = useState<LoadState>(property && !demo ? { kind: "loading" } : { kind: "unavailable" });
  const [authorized, setAuthorized] = useState(false);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [passed, setPassed] = useState(false);

  const load = useCallback(async () => {
    if (!property || demo) return;
    try {
      const res = await fetch(`/api/screening/preapply?propertyId=${encodeURIComponent(property)}`, {
        credentials: "include",
        cache: "no-store",
      });
      if (res.status >= 500) return setState((prev) => (prev.kind === "ready" ? prev : { kind: "unavailable" }));
      // Signed out, not a resident account, or a listing the server cannot resolve: the form decides, the server enforces.
      if (!res.ok) return setState({ kind: "ready", view: { required: false, satisfied: true } as PreApplyApiView });
      const next = (await res.json()) as PreApplyApiView;
      if (next.satisfied) setPassed(true);
      setState({ kind: "ready", view: next });
    } catch {
      setState((prev) => (prev.kind === "ready" ? prev : { kind: "unavailable" }));
    }
  }, [property, demo]);

  useEffect(() => {
    void load();
  }, [load]);

  // Back from Stripe: confirm the paid session server-side (the webhook is the same idempotent path), then re-read.
  useEffect(() => {
    if (!property || demo) return;
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get("session_id");
    if (params.get("preapply") !== "return" || !sessionId) return;
    void fetch("/api/screening/checkout-verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ sessionId }),
    }).finally(() => void load());
  }, [property, demo, load]);

  // A step that finishes elsewhere (Checkr's email, the Persona page) shows up on return or on the next poll.
  const waiting =
    state.kind === "ready" && state.view.required && !state.view.satisfied &&
    state.view.steps.some((step) => step.status === "in_progress" && !step.satisfied);
  const personaPending = state.kind === "ready" && state.view.provider === "persona" && state.view.next === "verify_id";
  useEffect(() => {
    if (!waiting && !personaPending) return;
    const timer = window.setInterval(() => void load(), POLL_MS);
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [waiting, personaPending, load]);

  if (!property || demo) return <>{children}</>;
  if (passed) return <>{children}</>;
  if (state.kind === "loading") return <p className="text-sm text-muted">Loading requirements…</p>;
  if (state.kind === "unavailable") {
    return (
      <div className="space-y-2" data-attr="preapply-unavailable">
        <p className="text-sm font-medium text-foreground">Requirements are unavailable right now.</p>
        <Button type="button" variant="secondary" onClick={() => load()}>
          Try again
        </Button>
      </div>
    );
  }
  const { view } = state;
  if (!view.required || view.satisfied) return <>{children}</>;

  const nextStep = view.steps.find((step) => step.id === view.next) ?? null;

  const pay = async () => {
    setBusy(true);
    setError(null);
    try {
      const params = new URLSearchParams(window.location.search);
      for (const key of ["preapply", "session_id", "screening"]) params.delete(key);
      const query = params.toString();
      const res = await fetch("/api/screening/preapply/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          propertyId: property,
          authorize: authorized,
          disclosureVersion: view.disclosure.version,
          returnPath: `${window.location.pathname}${query ? `?${query}` : ""}`,
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

  const action = (() => {
    if (!nextStep) return null;
    if (nextStep.status === "blocked") {
      return (
        <p className="text-sm font-medium text-foreground" data-attr="preapply-blocked">
          {nextStep.reason === "unavailable" ? "ID check unavailable" : "Your ID could not be verified. Contact the property manager."}
        </p>
      );
    }
    if (nextStep.status === "in_progress") {
      return (
        <p className="text-sm font-medium text-foreground" data-attr="preapply-waiting">
          {nextStep.id === "verify_id" ? "Waiting for your ID check to clear." : "Your background check is in progress."}
        </p>
      );
    }
    if (nextStep.id === "verify_id" && view.provider === "persona") {
      return (
        <Link href={VERIFY_ID_HREF} className="inline-flex" data-attr="preapply-verify-id-link">
          <Button type="button" variant="primary">Verify ID</Button>
        </Link>
      );
    }
    const quote = view.quote;
    if (!quote) return <p className="text-sm font-medium text-foreground">Nothing to pay right now.</p>;
    return (
      <div className="space-y-3" data-attr="preapply-card">
        <dl className="space-y-1 text-sm" data-attr="preapply-summary">
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
              data-attr="preapply-disclosure"
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
                data-attr="preapply-authorize"
              />
              <span>{view.disclosure.authorizationLabel}</span>
            </label>
            {error ? <p className="text-xs font-medium text-red-600">{error}</p> : null}
            <Button type="button" disabled={!authorized || busy} onClick={() => pay()} data-attr="preapply-pay">
              {`Pay ${formatCheckrPrice(quote.totalCents)} and continue`}
            </Button>
          </>
        )}
      </div>
    );
  })();

  return (
    <section className="mx-auto w-full max-w-xl space-y-4 rounded-2xl border border-border bg-card p-4 sm:p-6" data-attr="preapply-gate">
      <ol className="space-y-2" data-attr="preapply-steps">
        {view.steps.map((step) => (
          <li key={step.id} className="flex items-center gap-2 text-sm" data-attr={`preapply-step-${step.id}`} data-status={step.status}>
            {stepGlyph(step, step.id === view.next)}
            <span className={`font-medium ${step.id === view.next ? "text-foreground" : "text-muted"}`}>{step.label}</span>
            <span className="ml-auto text-xs text-muted">{stepStatusText(step)}</span>
          </li>
        ))}
        <li className="flex items-center gap-2 text-sm" data-attr="preapply-step-application" data-status="locked">
          {stepGlyph("application", false)}
          <span className="font-medium text-muted">Application</span>
        </li>
      </ol>
      {action}
    </section>
  );
}
