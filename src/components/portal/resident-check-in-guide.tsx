"use client";

import { useEffect, useState } from "react";
import { Check, Lock, MapPin } from "lucide-react";
import { CopyIconAction } from "@/components/portal/portal-icon-action";
import { Button } from "@/components/ui/button";
import { PORTAL_LIST_PAGE_BODY } from "@/components/portal/portal-inbox-ui";
import { PortalDataTableEmpty } from "@/components/portal/portal-data-table";
import type { CheckInGuide, CheckInSecretRow, CheckInStep } from "@/lib/check-in-guide";
import { cn } from "@/lib/utils";

function SecretRow({ row, unlockLabel }: { row: CheckInSecretRow; unlockLabel: string | null }) {
  const value = row.value;
  return (
    <div className="flex items-center justify-between gap-3 py-1.5" data-attr="check-in-secret-row">
      <span className="text-xs font-semibold text-muted">{row.label}</span>
      {value === null ? (
        <span className="inline-flex items-center gap-1.5 text-sm font-medium text-muted" data-attr="check-in-masked">
          <Lock className="size-3.5" aria-hidden />
          {unlockLabel ? `Unlocks ${unlockLabel}` : "Locked"}
        </span>
      ) : (
        <span className="flex items-center gap-2">
          <span className="ph-no-capture ph-no-record font-mono text-base font-semibold tracking-wide text-foreground">{value}</span>
          <CopyIconAction
            label={`Copy ${row.label.toLowerCase()}`}
            onCopy={() => navigator.clipboard?.writeText(value)}
            data-attr="check-in-copy"
          />
        </span>
      )}
    </div>
  );
}

function StepCard({ step, index, unlockLabel }: { step: CheckInStep; index: number; unlockLabel: string | null }) {
  return (
    <li className="flex gap-3 border-t border-border/70 px-4 py-4 first:border-t-0" data-attr={`check-in-step-${step.id}`}>
      <span
        aria-hidden
        className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary"
      >
        {index + 1}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-sm font-semibold text-foreground">{step.title}</h3>
          {step.mapsUrl ? (
            <a
              href={step.mapsUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Open in Maps"
              title="Open in Maps"
              data-attr="check-in-open-maps"
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-border text-muted transition-colors hover:border-primary/40 hover:text-foreground"
            >
              <MapPin className="size-4" aria-hidden />
            </a>
          ) : null}
        </div>
        {step.lines.length > 0 ? (
          <div className="mt-1 space-y-0.5 text-sm text-foreground/80">
            {step.lines.map((line) => (
              <p key={line} className="whitespace-pre-wrap">
                {line}
              </p>
            ))}
          </div>
        ) : null}
        {step.secrets.length > 0 ? (
          <div className="mt-2 divide-y divide-border/50">
            {step.secrets.map((row) => (
              <SecretRow key={row.label} row={row} unlockLabel={unlockLabel} />
            ))}
          </div>
        ) : null}
        {step.photoUrl ? (
          <a href={step.photoUrl} target="_blank" rel="noopener noreferrer" className="mt-3 block overflow-hidden rounded-xl border border-border">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={step.photoUrl} alt={step.title} className="aspect-[4/3] w-full object-cover" loading="lazy" />
          </a>
        ) : null}
      </div>
    </li>
  );
}

function checkedInLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "You checked in";
  return `You checked in ${date.toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" })}`;
}

/**
 * The numbered check-in steps, for a long-term resident (My home > Check-in) and a short-stay guest
 * (their Approved stay row). It draws exactly what the server sent: a masked code arrives as `null`,
 * so there is no value in the page to reveal early.
 */
export function ResidentCheckInGuide({ guide, onCheckedIn }: { guide: CheckInGuide; onCheckedIn?: (checkedInAt: string) => void }) {
  const [checkedInAt, setCheckedInAt] = useState(guide.checkedInAt);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCheckedInAt(guide.checkedInAt);
  }, [guide.checkedInAt]);

  if (guide.steps.length === 0) {
    return (
      <div className={PORTAL_LIST_PAGE_BODY}>
        <PortalDataTableEmpty icon="default" message="Your property manager has not added check-in steps yet." />
      </div>
    );
  }

  const canTapIn = guide.revealed && !checkedInAt && Boolean(guide.checkInKey);

  const tapIn = async () => {
    setError(null);
    try {
      const response = await fetch("/api/resident/check-in", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: guide.checkInKey }),
      });
      const body = (await response.json().catch(() => ({}))) as { checkedInAt?: string; error?: string };
      if (!response.ok || !body.checkedInAt) {
        setError(body.error || "Could not save your check-in.");
        return;
      }
      setCheckedInAt(body.checkedInAt);
      onCheckedIn?.(body.checkedInAt);
    } catch {
      setError("Could not save your check-in.");
    }
  };

  return (
    <div className={cn(PORTAL_LIST_PAGE_BODY, "space-y-3")} data-attr="resident-check-in-guide">
      {checkedInAt ? (
        <div className="flex items-center gap-2 rounded-2xl border border-border bg-card px-4 py-3 text-sm font-semibold text-foreground" data-attr="check-in-done">
          <Check className="size-4 text-[var(--status-confirmed-fg)]" aria-hidden />
          {checkedInLabel(checkedInAt)}
        </div>
      ) : null}
      <ol className="overflow-hidden rounded-2xl border border-border bg-card">
        {guide.steps.map((step, index) => (
          <StepCard key={step.id} step={step} index={index} unlockLabel={guide.unlockLabel} />
        ))}
      </ol>
      {canTapIn ? (
        <div className="flex flex-col items-start gap-2">
          <Button type="button" variant="primary" className="rounded-full" data-attr="check-in-im-in" onClick={() => tapIn()}>
            I&apos;m in
          </Button>
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** A short-stay guest's guide, fetched for their own stay: the server decides what is revealed. */
export function ResidentStayCheckIn({ blockId }: { blockId: string }) {
  const [state, setState] = useState<{ status: "loading" } | { status: "error" } | { status: "ready"; guide: CheckInGuide }>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState({ status: "loading" });
    void (async () => {
      try {
        const response = await fetch(`/api/resident/check-in?stay=${encodeURIComponent(blockId)}`, { cache: "no-store" });
        const body = (await response.json().catch(() => ({}))) as { guide?: CheckInGuide };
        if (cancelled) return;
        setState(response.ok && body.guide ? { status: "ready", guide: body.guide } : { status: "error" });
      } catch {
        if (!cancelled) setState({ status: "error" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [blockId, attempt]);

  if (state.status === "loading") return <p className="px-4 py-3 text-sm text-muted">Loading check-in…</p>;
  if (state.status === "error") {
    return (
      <div role="alert" className="flex items-center gap-3 px-4 py-3 text-sm text-danger">
        Check-in could not load.
        <Button type="button" variant="outline" className="rounded-full" onClick={() => setAttempt((n) => n + 1)}>
          Retry
        </Button>
      </div>
    );
  }
  return <ResidentCheckInGuide guide={state.guide} />;
}
