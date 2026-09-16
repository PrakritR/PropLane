"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useAppUi } from "@/components/providers/app-ui-provider";
import {
  formatGoogleCalendarConnectError,
  GOOGLE_CALENDAR_UNVERIFIED_APP_STEPS,
  isGoogleCalendarOAuthBlocked,
} from "@/lib/google-calendar/connect-errors";
import { BANNER_INFO_CLASS } from "@/lib/ui-styles";

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

/**
 * Status card, not an instruction wall.
 *
 * The panel used to render a "Production Google sign-in" block with two
 * numbered lists (the Advanced/Test-users steps AND the Google Cloud Console
 * publish-to-Production steps) ahead of every connect click, on every host.
 * The publish steps are a ONE-TIME action for whoever owns the Google Cloud
 * project, not something a manager does per connect — they do not belong in
 * this panel at all; see the WS3 handoff notes for the exact console steps.
 * Nothing is explained under the Connect control ahead of time (AGENTS.md
 * § No small grey subtext): the unverified-app screen is Google's own flow to
 * click through, and the numbered Test-users recovery steps appear only after
 * a real `access_denied` — troubleshooting for a failure that happened, not a
 * wall shown before anything went wrong.
 */
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
  const inDialog = presentation === "dialog";

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

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const gcal = params.get("gcal");
    if (!gcal) return;
    if (gcal === "connected") {
      setConnectError(null);
      setConnectBlocked(false);
      showToast("Google Calendar connected.");
    }
    if (gcal === "error") {
      const reason = params.get("reason");
      const message = formatGoogleCalendarConnectError(reason);
      setConnectError(message);
      setConnectBlocked(isGoogleCalendarOAuthBlocked(reason));
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
              <li>Save, then click Connect Google Calendar again and use Advanced → Go to PropLane (unsafe).</li>
            </ol>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 space-y-1">
          {status.connected ? (
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium text-foreground">
                {status.email ?? "Connected"}
              </span>
              <span
                className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-emerald-600 [html[data-theme=dark]_&]:text-emerald-400"
                data-attr="google-calendar-live-badge"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
                Live
              </span>
            </div>
          ) : status.missingSecret ? (
            <p className="text-sm text-muted">
              Google Calendar isn&apos;t set up on this server yet — ask an admin to finish the setup.
            </p>
          ) : (
            <p className="text-sm text-muted">
              {status.configured
                ? "Connect your Google account to sync tours and block double-bookings."
                : status.googleAuthUser
                  ? "You signed in with Google. Link calendar access below to finish."
                  : "Sign in with Continue with Google to link your calendar automatically."}
            </p>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          {status.connected ? (
            <Button type="button" variant="outline" disabled={busy} onClick={() => disconnect()}>
              Disconnect
            </Button>
          ) : (
            <Button type="button" variant="primary" disabled={busy || !status.configured} onClick={startConnect}>
              Connect Google Calendar
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

/** Kept for callers that still surface the unverified-app steps standalone. */
export { GOOGLE_CALENDAR_UNVERIFIED_APP_STEPS };
