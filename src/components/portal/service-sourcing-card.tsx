"use client";

import { useCallback, useEffect, useState } from "react";
import { Copy, ExternalLink, RefreshCw } from "lucide-react";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { Button } from "@/components/ui/button";
import { PortalSettingsGroup, PortalSettingsRow, PortalSettingsSection } from "@/components/portal/portal-settings-ui";

type SourcingCandidate = {
  id: string;
  source: string;
  name: string;
  status: string;
  reason: string | null;
  sourceUrl: string | null;
  proposal_id: string | null;
  coverage?: string;
};

type SourcingJob = { state: string; stage: string | null; reason: string | null };
type SourcingPayload = { job: SourcingJob | null; candidates: SourcingCandidate[] };

const STATE_LABELS: Record<string, string> = {
  queued: "Queued",
  sourcing: "Finding vendors",
  waiting: "Waiting for responses",
  quote_collected: "Quote collected",
  needs_attention: "Needs attention",
  paused: "Paused",
  complete: "Complete",
  dormant: "Not started",
};

const SOURCE_LABELS: Record<string, string> = {
  roster: "Your vendors",
  shared: "PropLane network",
  web: "Web search",
};

function displayLabel(value: string, labels: Record<string, string>): string {
  return labels[value] ?? value.replaceAll("_", " ").replace(/^\w/, (letter) => letter.toUpperCase());
}

function safeSourceUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function ServiceSourcingCard({ workOrderId }: { workOrderId: string }) {
  const [data, setData] = useState<SourcingPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<SourcingPayload> => {
    const response = await fetch(`/api/portal/vendor-sourcing?workOrderId=${encodeURIComponent(workOrderId)}`, {
      credentials: "include",
      cache: "no-store",
    });
    const body = (await response.json().catch(() => ({}))) as Partial<SourcingPayload> & { error?: string };
    if (!response.ok) throw new Error(body.error || "Could not load vendor sourcing.");
    return { job: body.job ?? null, candidates: Array.isArray(body.candidates) ? body.candidates : [] };
  }, [workOrderId]);

  useEffect(() => {
    let current = true;
    void load()
      .then((payload) => {
        if (current) setData(payload);
      })
      .catch((cause) => {
        if (current) setError(cause instanceof Error ? cause.message : "Could not load vendor sourcing.");
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [load]);

  const retry = async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await load());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load vendor sourcing.");
    } finally {
      setLoading(false);
    }
  };

  const runAction = async (action: "start" | "pause" | "resume") => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/portal/vendor-sourcing", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workOrderId, action }),
      });
      const body = (await response.json().catch(() => ({}))) as Partial<SourcingPayload> & { error?: string };
      if (!response.ok) throw new Error(body.error || "Could not update vendor sourcing.");
      setData({ job: body.job ?? null, candidates: Array.isArray(body.candidates) ? body.candidates : [] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update vendor sourcing.");
    } finally {
      setBusy(false);
    }
  };

  const copyResponseLink = async (candidateId: string) => {
    setBusy(true); setError(null);
    try {
      const response = await fetch("/api/portal/vendor-sourcing", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workOrderId, action: "response_link", candidateId }) });
      const body = await response.json();
      if (!response.ok || typeof body.url !== "string") throw new Error(body.error || "Response link unavailable.");
      await navigator.clipboard.writeText(body.url);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Response link unavailable."); }
    finally { setBusy(false); }
  };

  const job = data?.job ?? null;
  const state = job?.state ?? "dormant";
  const action = ["paused", "needs_attention"].includes(state) ? "resume" : state === "dormant" ? "start" : ["complete"].includes(state) ? null : "pause";
  const actionLabel = action === "start" ? "Start" : action === "resume" ? "Resume" : "Pause";

  return (
    <div className="space-y-3" data-attr="service-vendor-sourcing" aria-busy={busy}>
      <PortalSettingsSection title="Vendor sourcing">
        <PortalSettingsGroup>
          {loading ? (
            <div className="space-y-3 p-4" role="status" aria-label="Loading vendor sourcing">
              <div className="h-4 w-40 animate-pulse rounded bg-muted/30" />
              <div className="h-3 w-56 animate-pulse rounded bg-muted/30" />
            </div>
          ) : error && !data ? (
            <div className="flex flex-wrap items-center justify-between gap-3 p-4">
              <p className="text-sm text-danger" role="alert">{error}</p>
              <Button variant="outline" onClick={retry}>
                <RefreshCw className="mr-2 h-4 w-4" aria-hidden />Retry
              </Button>
            </div>
          ) : (
            <>
              <PortalSettingsRow label="Status">{displayLabel(state, STATE_LABELS)}</PortalSettingsRow>
              {job?.stage ? <PortalSettingsRow label="Progress">{job.stage}</PortalSettingsRow> : null}
              {job?.reason ? <PortalSettingsRow label="Needs">{job.reason}</PortalSettingsRow> : null}
              {error ? <p className="px-4 pt-2 text-sm text-danger" role="alert">{error}</p> : null}
              {!data?.candidates.length && !job?.reason ? (
                <p className="px-4 py-3 text-sm text-muted">No vendor matches yet.</p>
              ) : null}
              {data?.candidates.map((candidate) => {
                const sourceUrl = safeSourceUrl(candidate.sourceUrl);
                return (
                  <PortalSettingsGroup key={candidate.id}>
                    <PortalSettingsRow label="Vendor">{candidate.name}<PortalIconAction icon={Copy} label={`Copy quote response link for ${candidate.name}`} disabled={busy} onClick={() => copyResponseLink(candidate.id)} /></PortalSettingsRow>
                    <PortalSettingsRow label="Source">{displayLabel(candidate.source, SOURCE_LABELS)}{sourceUrl ? <a className="ml-3 inline-flex min-h-11 items-center gap-1 text-primary underline focus-visible:ring-2 focus-visible:ring-ring" href={sourceUrl} target="_blank" rel="noreferrer" aria-label={`Open source for ${candidate.name}`}><ExternalLink className="h-4 w-4" aria-hidden />Source</a> : null}</PortalSettingsRow>
                    {candidate.coverage ? <PortalSettingsRow label="Service area">{candidate.coverage}</PortalSettingsRow> : null}
                    <PortalSettingsRow label="Contact">{displayLabel(candidate.status, STATE_LABELS)}</PortalSettingsRow>
                    {candidate.reason ? <PortalSettingsRow label="Needs">{candidate.reason}</PortalSettingsRow> : null}
                  </PortalSettingsGroup>
                );
              })}
              {action ? (
                <div className="flex gap-3 border-t border-border p-3">
                  <Button variant={action === "pause" ? "outline" : "primary"} disabled={busy} aria-busy={busy} onClick={() => runAction(action)}>
                    {busy ? "Saving…" : actionLabel}
                  </Button>
                  <Button variant="outline" disabled={busy} onClick={retry}><RefreshCw className="h-4 w-4" aria-hidden /><span className="sr-only">Refresh sourcing</span></Button>
                </div>
              ) : null}
            </>
          )}
        </PortalSettingsGroup>
      </PortalSettingsSection>
    </div>
  );
}
