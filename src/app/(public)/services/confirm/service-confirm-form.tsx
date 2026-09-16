"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

type Lookup =
  | { ok: true; workOrder: { id: string; title: string; propertyLabel: string; vendorName: string; verdict?: string; rating?: number } }
  | { ok: false; reason: "invalid" | "expired" };

type Step = "loading" | "ask" | "note" | "rate" | "done_fixed" | "done_not_fixed" | "done_rated" | "invalid" | "expired";

export function ServiceConfirmForm({ token }: { token: string }) {
  const [step, setStep] = useState<Step>(token ? "loading" : "invalid");
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [note, setNote] = useState("");
  const [rating, setRating] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    void (async () => {
      const res = await fetch(`/api/work-orders/confirm?t=${encodeURIComponent(token)}`, { cache: "no-store" });
      const body = (await res.json().catch(() => null)) as Lookup | null;
      if (cancelled) return;
      if (!body || !body.ok) {
        setStep(body && !body.ok && body.reason === "expired" ? "expired" : "invalid");
        return;
      }
      setLookup(body);
      if (body.workOrder.verdict === "fixed") setStep(typeof body.workOrder.rating === "number" ? "done_rated" : "rate");
      else if (body.workOrder.verdict === "not_fixed") setStep("done_not_fixed");
      else if (body.workOrder.verdict === "auto_closed") setStep("expired");
      else setStep("ask");
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const post = async (payload: Record<string, unknown>) => {
    setError(null);
    const res = await fetch("/api/work-orders/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, ...payload }),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; reason?: string; ratingUrl?: string | null };
    if (!body.ok) {
      setError(body.reason === "answered" ? "This question was already answered." : "That link no longer works.");
      return null;
    }
    return body;
  };

  const workOrder = lookup?.ok ? lookup.workOrder : null;
  const title = workOrder?.title ?? "your service request";
  const where = workOrder?.propertyLabel ? ` at ${workOrder.propertyLabel}` : "";

  if (step === "loading") return <p className="mt-4 text-sm text-muted">Loading…</p>;
  if (step === "invalid") return <h1 className="mt-2 text-2xl font-bold tracking-tight text-foreground">That link is not valid.</h1>;
  if (step === "expired") {
    return (
      <>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-foreground">This question has closed.</h1>
        <p className="mt-3 text-[15px] leading-relaxed text-muted">If “{title}” is still not fixed, reply to your property manager in PropLane.</p>
      </>
    );
  }

  if (step === "ask" || step === "note") {
    return (
      <>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-foreground">Was “{title}” fixed?</h1>
        <p className="mt-3 text-[15px] leading-relaxed text-muted">
          {workOrder?.vendorName ?? "The vendor"} marked the visit{where} done.
        </p>
        {step === "ask" ? (
          <div className="mt-6 flex flex-wrap gap-3">
            <Button
              data-attr="service-confirm-fixed"
              onClick={async () => {
                const body = await post({ action: "fixed" });
                if (body) setStep(body.ratingUrl ? "rate" : "done_fixed");
              }}
            >
              Yes, it’s fixed
            </Button>
            <Button variant="secondary" data-attr="service-confirm-not-fixed" onClick={() => setStep("note")}>
              No, still a problem
            </Button>
          </div>
        ) : (
          <div className="mt-6 space-y-3">
            <label className="block text-sm font-medium text-foreground">
              What’s still wrong?
              <textarea
                className="mt-2 w-full rounded-xl border border-border bg-card px-3 py-2 text-sm"
                rows={3}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="Still dripping under the sink"
              />
            </label>
            <div className="flex flex-wrap gap-3">
              <Button
                data-attr="service-confirm-send-not-fixed"
                onClick={async () => {
                  const body = await post({ action: "not_fixed", note });
                  if (body) setStep("done_not_fixed");
                }}
              >
                Send
              </Button>
              <Button variant="secondary" onClick={() => setStep("ask")}>
                Back
              </Button>
            </div>
          </div>
        )}
        {error ? <p className="mt-3 text-sm text-danger">{error}</p> : null}
      </>
    );
  }

  if (step === "rate") {
    return (
      <>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-foreground">Thanks — “{title}” is closed.</h1>
        <p className="mt-3 text-[15px] leading-relaxed text-muted">How was the visit from {workOrder?.vendorName ?? "the vendor"}?</p>
        <div className="mt-5 flex gap-2" role="radiogroup" aria-label="Rating">
          {[1, 2, 3, 4, 5].map((star) => (
            <button
              key={star}
              type="button"
              role="radio"
              aria-checked={rating === star}
              aria-label={`${star} star${star === 1 ? "" : "s"}`}
              data-attr="service-confirm-star"
              onClick={() => setRating(star)}
              className={`h-11 w-11 rounded-full border text-xl ${rating >= star ? "border-primary bg-accent text-primary" : "border-border bg-card text-muted"}`}
            >
              ★
            </button>
          ))}
        </div>
        <div className="mt-5 flex flex-wrap gap-3">
          <Button
            data-attr="service-confirm-rate"
            disabled={rating === 0}
            onClick={async () => {
              const body = await post({ action: "rate", rating });
              if (body) setStep("done_rated");
            }}
          >
            Send rating
          </Button>
          <Button variant="secondary" onClick={() => setStep("done_fixed")}>
            Skip
          </Button>
        </div>
        {error ? <p className="mt-3 text-sm text-danger">{error}</p> : null}
      </>
    );
  }

  if (step === "done_not_fixed") {
    return (
      <>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-foreground">Sorry about that.</h1>
        <p className="mt-3 text-[15px] leading-relaxed text-muted">“{title}” is reopened and your property manager has been told.</p>
      </>
    );
  }

  return (
    <>
      <h1 className="mt-2 text-2xl font-bold tracking-tight text-foreground">
        {step === "done_rated" ? "Thanks for the rating." : "Thanks — all set."}
      </h1>
      <p className="mt-3 text-[15px] leading-relaxed text-muted">“{title}” is closed.</p>
    </>
  );
}
