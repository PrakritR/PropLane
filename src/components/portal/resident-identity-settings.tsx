"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PortalSettingsGroup, PortalSettingsRow, PortalSettingsSection } from "@/components/portal/portal-settings-ui";

type IdentityState = { status: string; manualReview: string | null; provider?: string | null; verifiedAt?: string | null };
const labels: Record<string, string> = { loading: "Loading…", unavailable: "Unavailable", not_started: "Not started", pending: "Pending", review: "In review", approved: "Verified", declined: "Declined", expired: "Expired", reconciliation: "In review" };

export function ResidentIdentitySettings() {
  const [state, setState] = useState<IdentityState>({ status: "loading", manualReview: null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/resident/identity", { cache: "no-store" });
      if (!response.ok) throw new Error();
      const body = await response.json() as IdentityState;
      setState(body);
    } catch { setState({ status: "unavailable", manualReview: null }); }
  }, []);
  useEffect(() => { queueMicrotask(() => void load()); }, [load]);
  const action = async (kind: "start" | "retry" | "manual-review") => {
    setBusy(true); setError("");
    try {
      const path = kind === "start" ? "/api/resident/identity" : `/api/resident/identity/${kind}`;
      const response = await fetch(path, { method: "POST" });
      const body = await response.json() as { url?: string; error?: string };
      if (!response.ok) throw new Error(body.error || "Please try again.");
      if (body.url) { window.location.assign(body.url); return; }
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Please try again."); }
    finally { setBusy(false); }
  };
  return <>
    <PortalSettingsSection title="Verification" id="verification">
      <PortalSettingsGroup>
        <PortalSettingsRow label="Identity verification">
          <span className="text-sm text-foreground">{labels[state.status] ?? "Unavailable"}</span>
          {["not_started", "pending"].includes(state.status) && <button type="button" className="ml-3 text-sm text-primary" disabled={busy} onClick={() => void action("start")}>{state.status === "pending" ? "Continue" : "Verify"}</button>}
          {state.status === "expired" && <button type="button" className="ml-3 text-sm text-primary" disabled={busy} onClick={() => void action("retry")}>Retry</button>}
        </PortalSettingsRow>
        {state.status === "approved" && state.provider && <PortalSettingsRow label="Provider"><span className="text-sm">{state.provider}</span></PortalSettingsRow>}
        {state.status === "approved" && state.verifiedAt && <PortalSettingsRow label="Verified on"><time className="text-sm" dateTime={state.verifiedAt}>{new Date(state.verifiedAt).toLocaleDateString("en-US", { timeZone: "UTC", year: "numeric", month: "short", day: "numeric" })}</time></PortalSettingsRow>}
        <PortalSettingsRow label="Manual review">
          {state.manualReview ? <span className="text-sm">Requested</span> : state.status === "unavailable" ? <Link className="text-sm text-primary" href="/resident/profile?tab=feedback">Contact PropLane support</Link> : <button type="button" className="text-sm text-primary" disabled={busy || state.status === "loading"} onClick={() => void action("manual-review")}>Request</button>}
        </PortalSettingsRow>
        {state.manualReview && <PortalSettingsRow label="PropLane support"><Link className="text-sm text-primary" href="/resident/profile?tab=feedback">Contact support</Link></PortalSettingsRow>}
        {error && <PortalSettingsRow label={<span role="alert">{error}</span>} />}
      </PortalSettingsGroup>
    </PortalSettingsSection>
    <PortalSettingsSection title="Background check"><PortalSettingsGroup><PortalSettingsRow label="Screening"><span className="text-sm">Unavailable</span></PortalSettingsRow></PortalSettingsGroup></PortalSettingsSection>
  </>;
}
