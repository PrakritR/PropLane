"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { PortalSettingsGroup, PortalSettingsRow, PortalSettingsSection } from "@/components/portal/portal-settings-ui";

type IdentityState = { status: string; manualReview: string | null; provider?: string | null; verifiedAt?: string | null };
const labels: Record<string, string> = { loading: "Loading…", unavailable: "Unavailable", not_started: "Not started", pending: "Pending", review: "In review", approved: "Verified", declined: "Declined", expired: "Expired", reconciliation: "In review" };

export function ResidentIdentitySettings() {
  const searchParams = useSearchParams();
  const returnTo = searchParams.get("returnTo");
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
  // Nothing to offer, nothing to show. With the provider flags disabled — the shipping state —
  // `/api/resident/identity` answers `unavailable` for everyone, so rendering this put a
  // "Verification: Unavailable / Contact PropLane support" block and a permanently "Unavailable"
  // background check into EVERY resident's Settings. The sibling `ResidentVerificationLink`
  // already hides itself on exactly that status. An attestation that is already approved, an
  // outstanding manual review and a live error are still the resident's own state and stay.
  const hasVerificationState = state.status !== "loading" && (state.status !== "unavailable" || Boolean(state.manualReview));
  if (!hasVerificationState && !error) return null;
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
        {state.status === "approved" && returnTo && /^\/(?:rent\/|resident\/tour(?:\/|\?|$))/.test(returnTo) && !returnTo.includes("\\") && <PortalSettingsRow label="Tour"><Link href={returnTo} className="text-sm text-primary">Return to tour</Link></PortalSettingsRow>}
        <PortalSettingsRow label="Manual review">
          {state.manualReview ? <span className="text-sm">Requested</span> : state.status === "unavailable" ? <Link className="text-sm text-primary" href="/resident/profile?tab=feedback">Contact PropLane support</Link> : <button type="button" className="text-sm text-primary" disabled={busy || state.status === "loading"} onClick={() => void action("manual-review")}>Request</button>}
        </PortalSettingsRow>
        {state.manualReview && <PortalSettingsRow label="PropLane support"><Link className="text-sm text-primary" href="/resident/profile?tab=feedback">Contact support</Link></PortalSettingsRow>}
        {error && <PortalSettingsRow label={<span role="alert">{error}</span>} />}
      </PortalSettingsGroup>
    </PortalSettingsSection>
    {state.status !== "unavailable" && <PortalSettingsSection title="Background check"><PortalSettingsGroup><PortalSettingsRow label="Screening"><span className="text-sm">Unavailable</span></PortalSettingsRow></PortalSettingsGroup></PortalSettingsSection>}
  </>;
}
