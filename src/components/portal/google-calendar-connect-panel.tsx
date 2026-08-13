"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { isKnownProductionWebHost } from "@/lib/app-url";
import {
  formatGoogleCalendarConnectError,
  GOOGLE_CALENDAR_PRODUCTION_PUBLISH_STEPS,
  GOOGLE_CALENDAR_UNVERIFIED_APP_STEPS,
  isGoogleCalendarOAuthBlocked,
} from "@/lib/google-calendar/connect-errors";
import { BANNER_INFO_CLASS, BANNER_NEUTRAL_CLASS } from "@/lib/ui-styles";

type GoogleCalendarStatus = {
  connected: boolean;
  email: string | null;
  syncEnabled: boolean;
  configured: boolean;
  schemaReady?: boolean;
  perManager?: boolean;
  googleAuthUser?: boolean;
  missingSecret?: boolean;
  oauthRedirectUri?: string;
  managerEmail?: string | null;
};

function isProductionCalendarHost(): boolean {
  if (typeof window === "undefined") return false;
  return isKnownProductionWebHost(window.location.hostname);
}

export function GoogleCalendarConnectPanel({
  onConnectionChange,
  presentation = "card",
}: {
  onConnectionChange?: () => void;
  presentation?: "card" | "dialog";
}) {
  const { showToast } = useAppUi();
  const [status, setStatus] = useState<GoogleCalendarStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connectBlocked, setConnectBlocked] = useState(false);
  const [showConnectSteps, setShowConnectSteps] = useState(false);
  const inDialog = presentation === "dialog";
  const onProduction = useMemo(() => isProductionCalendarHost(), []);

  const load = useCallback(async () => {
    try {
      await fetch("/api/portal/google-calendar/link-session", {
        method: "POST",
        credentials: "include",
      }).catch(() => undefined);
      const res = await fetch(
        `/api/portal/google-calendar?origin=${encodeURIComponent(window.location.origin)}`,
        { credentials: "include" },
      );
      if (!res.ok) return;
      const data = (await res.json()) as GoogleCalendarStatus;
      setStatus(data);
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const startConnect = useCallback(() => {
    if (!status?.configured) {
      showToast("Google Calendar OAuth is not configured on this server.");
      return;
    }
    setConnectError(null);
    setConnectBlocked(false);
    const origin = encodeURIComponent(window.location.origin);
    const returnTo = encodeURIComponent(`${window.location.pathname}${window.location.search}`);
    showToast("Opening Google sign-in…");
    window.location.assign(
      `/api/portal/google-calendar/connect?origin=${origin}&returnTo=${returnTo}`,
    );
  }, [showToast, status?.configured]);

  const connect = useCallback(() => {
    if (onProduction && !showConnectSteps) {
      setShowConnectSteps(true);
      return;
    }
    startConnect();
  }, [onProduction, showConnectSteps, startConnect]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const gcal = params.get("gcal");
    if (!gcal) return;
    if (gcal === "connected") {
      setConnectError(null);
      setConnectBlocked(false);
      setShowConnectSteps(false);
      showToast("Google Calendar connected.");
    }
    if (gcal === "error") {
      const reason = params.get("reason");
      const message = formatGoogleCalendarConnectError(reason);
      setConnectError(message);
      setConnectBlocked(isGoogleCalendarOAuthBlocked(reason));
      setShowConnectSteps(true);
      showToast(message);
    }
    params.delete("gcal");
    params.delete("reason");
    const next = `${window.location.pathname}${params.size ? `?${params}` : ""}`;
    window.history.replaceState({}, "", next);
    void load();
    onConnectionChange?.();
  }, [load, onConnectionChange, showToast]);

  const disconnect = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/portal/google-calendar", { method: "DELETE", credentials: "include" });
      if (!res.ok) throw new Error("Could not disconnect.");
      await load();
      onConnectionChange?.();
      showToast("Google Calendar disconnected.");
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not disconnect.");
    } finally {
      setBusy(false);
    }
  };

  const toggleSync = async (next: boolean) => {
    setBusy(true);
    try {
      const res = await fetch("/api/portal/google-calendar", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ syncEnabled: next }),
      });
      if (!res.ok) throw new Error("Could not update sync setting.");
      await load();
      onConnectionChange?.();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not update sync setting.");
    } finally {
      setBusy(false);
    }
  };

  if (!status) {
    return inDialog ? <p className="text-sm text-muted">Loading…</p> : null;
  }

  const shellClass = inDialog ? "space-y-4" : "rounded-lg border border-border bg-card p-4 shadow-sm";
  const connectEmail = status.managerEmail?.trim() || status.email?.trim() || null;

  return (
    <div className={shellClass} data-attr="google-calendar-connect-panel">
      {connectError ? (
        <div className={BANNER_INFO_CLASS} data-attr="google-calendar-connect-error">
          <p className="text-sm text-foreground">{connectError}</p>
          {connectBlocked ? (
            <ol className="mt-2 list-decimal space-y-1 pl-4 text-xs text-muted">
              <li>
                Open Google Cloud Console → APIs &amp; Services → OAuth consent screen → Test users → Add users.
              </li>
              <li>
                Add {connectEmail ? <strong>{connectEmail}</strong> : "the Google account you use on PropLane"}.
              </li>
              <li>Save, then click Grant calendar access again and use Advanced → Go to PropLane (unsafe).</li>
            </ol>
          ) : null}
        </div>
      ) : null}

      {!status.connected && (onProduction || showConnectSteps) ? (
        <div className={BANNER_NEUTRAL_CLASS} data-attr="google-calendar-connect-steps">
          <p className="text-sm font-medium text-foreground">
            {onProduction ? "Production Google sign-in" : "Google sign-in"}
          </p>
          <p className="mt-1 text-xs text-muted">
            Google shows an unverified-app warning for Calendar until the OAuth app is published. That is normal —
            localhost skips it only when your account is already a test user.
            {connectEmail ? (
              <>
                {" "}
                PropLane will open Google as <strong>{connectEmail}</strong>.
              </>
            ) : null}
          </p>
          <ol className="mt-2 list-decimal space-y-1 pl-4 text-xs text-muted">
            {GOOGLE_CALENDAR_UNVERIFIED_APP_STEPS.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          {onProduction ? (
            <>
              <p className="mt-3 text-xs font-semibold text-foreground">To allow every manager (no Advanced step):</p>
              <ol className="mt-1 list-decimal space-y-1 pl-4 text-xs text-muted">
                {GOOGLE_CALENDAR_PRODUCTION_PUBLISH_STEPS.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            </>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          {status.connected && status.email ? (
            <p className="text-sm font-medium text-foreground">{status.email}</p>
          ) : status.missingSecret ? (
            <p className="text-sm text-muted">
              Linked via Google sign-in, but server is missing GOOGLE_CALENDAR_CLIENT_SECRET. Add it to Vercel
              environment variables (same secret as Supabase Google provider), then redeploy.
            </p>
          ) : (
            <p className="text-sm text-muted">
              {status.configured
                ? status.googleAuthUser
                  ? "You signed in with Google. Grant calendar access to sync tours and block double-bookings."
                  : "Connect your Google account to sync tours and events."
                : status.googleAuthUser
                  ? "You signed in with Google. Link calendar access below, or sign in again and approve calendar permissions when prompted."
                  : "Sign in with Continue with Google (not email/password) to link your personal calendar automatically."}
            </p>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          {status.connected ? (
            <Button type="button" variant="outline" disabled={busy} onClick={() => disconnect()}>
              Disconnect
            </Button>
          ) : showConnectSteps && onProduction ? (
            <>
              <Button type="button" variant="outline" disabled={busy} onClick={() => setShowConnectSteps(false)}>
                Back
              </Button>
              <Button type="button" variant="primary" disabled={busy || !status.configured} onClick={startConnect}>
                Continue to Google
              </Button>
            </>
          ) : (
            <Button type="button" variant="primary" disabled={busy || !status.configured} onClick={connect}>
              {status.googleAuthUser ? "Grant calendar access" : "Connect"}
            </Button>
          )}
        </div>
      </div>
      {status.connected ? (
        <label className="flex cursor-pointer items-start gap-3 border-t border-border pt-3">
          <input
            type="checkbox"
            className="mt-0.5 accent-primary"
            checked={status.syncEnabled}
            disabled={busy}
            onChange={(e) => void toggleSync(e.target.checked)}
            data-attr="google-calendar-sync-toggle"
          />
          <span className="text-xs text-muted">Two-way sync — Google events here; confirmed tours on Google.</span>
        </label>
      ) : null}
    </div>
  );
}
