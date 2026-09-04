"use client";

import { useCallback, useEffect, useState } from "react";
import type { GmailPaymentTrackRole, ManagerPaymentReceiptChannel } from "@/lib/gmail-payments/portal-role";
import {
  gmailFilterFromClause,
  gmailFilterSubjectHint,
} from "@/lib/gmail-payments/gmail-query";

export type GmailPaymentTrackStatus = {
  connected: boolean;
  email: string | null;
  configured: boolean;
  lastSyncAt: string | null;
  lastSyncMarkedPaid: number | null;
};

export function useGmailPaymentTrack({
  role,
  channel,
  demo,
  showToast,
}: {
  role: GmailPaymentTrackRole;
  channel?: ManagerPaymentReceiptChannel;
  demo: boolean;
  showToast: (message: string) => void;
}) {
  const apiBase = role === "vendor" ? "/api/vendor/gmail-payments" : "/api/portal/gmail-payments";
  const channelQuery = channel ? `&channel=${encodeURIComponent(channel)}` : "";
  const connectPath =
    role === "vendor"
      ? `/api/vendor/gmail-payments/connect?origin=${encodeURIComponent(typeof window !== "undefined" ? window.location.origin : "")}`
      : `/api/portal/gmail-payments/connect?origin=${encodeURIComponent(typeof window !== "undefined" ? window.location.origin : "")}${channelQuery}`;

  const [gmailStatus, setGmailStatus] = useState<GmailPaymentTrackStatus | null>(null);
  const [gmailBusy, setGmailBusy] = useState(false);

  const loadGmailStatus = useCallback(async () => {
    if (demo) {
      setGmailStatus({ connected: false, email: null, configured: true, lastSyncAt: null, lastSyncMarkedPaid: null });
      return;
    }
    try {
      const statusUrl = channel ? `${apiBase}?channel=${encodeURIComponent(channel)}` : apiBase;
      const res = await fetch(statusUrl, { credentials: "include" });
      const data = (await res.json().catch(() => ({}))) as { status?: GmailPaymentTrackStatus };
      if (res.ok && data.status) setGmailStatus(data.status);
    } catch {
      setGmailStatus(null);
    }
  }, [apiBase, channel, demo]);

  useEffect(() => {
    void loadGmailStatus();
  }, [loadGmailStatus]);

  function linkGmail() {
    if (demo) {
      showToast("Gmail connect is disabled in demo mode.");
      return;
    }
    setGmailBusy(true);
    window.location.assign(connectPath);
  }

  return {
    gmailStatus,
    gmailBusy,
    linkGmail,
    loadGmailStatus,
  };
}

type ManualChannel = "zelle" | "venmo";

export function GmailPaymentTrackSteps({
  role,
  channel,
  paymentInboxAddress,
  autoMarkEnabled,
  onAutoMarkChange,
  gmailStatus,
  gmailBusy,
  onLinkGmail,
  showToast,
  compact,
}: {
  role: GmailPaymentTrackRole;
  channel?: ManualChannel;
  paymentInboxAddress?: string;
  autoMarkEnabled: boolean;
  onAutoMarkChange: (enabled: boolean) => void | Promise<void>;
  gmailStatus: GmailPaymentTrackStatus | null;
  gmailBusy: boolean;
  onLinkGmail: () => void;
  showToast: (message: string) => void;
  compact?: boolean;
}) {
  const refLabel = role === "manager" ? "PL-" : "WO-";
  const filterFrom = channel ? gmailFilterFromClause(channel) : "venmo.com OR zellepay.com";
  const filterSubject = channel ? gmailFilterSubjectHint(channel) : null;
  const channelLabel = channel === "zelle" ? "Zelle" : channel === "venmo" ? "Venmo" : "Zelle/Venmo";

  return (
    <ol className={`list-decimal space-y-3 pl-5 text-xs leading-relaxed text-muted ${compact ? "mt-3" : ""}`}>
      <li className="text-foreground">
        <span className="font-medium text-foreground">Link the Gmail inbox for {channelLabel}</span>
        <span className="text-muted">
          {" "}
          — use the account that receives {channelLabel} payment alerts (it can differ from your other payment inbox).
          We read those emails and match the{" "}
        </span>
        <span className="font-mono">{refLabel}</span>
        <span className="text-muted"> code and amount. Receipts are checked automatically when residents tap Check payment and on a daily schedule.</span>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {gmailStatus?.connected ? (
            <span className="text-sm font-medium text-[var(--status-confirmed-fg)]">
              {gmailStatus.email ?? "Connected"}
            </span>
          ) : (
            <button
              type="button"
              onClick={onLinkGmail}
              disabled={gmailBusy || gmailStatus?.configured === false}
              data-attr={channel ? `manager-payment-${channel}-gmail-link` : `${role}-payment-gmail-link`}
              className="text-sm font-medium text-primary hover:underline disabled:opacity-50"
            >
              {gmailBusy ? "Opening…" : "Link Gmail"}
            </button>
          )}
        </div>
        {gmailStatus?.configured === false ? (
          <p className="mt-1 text-muted">Google sign-in is not configured on this server.</p>
        ) : !gmailStatus?.connected ? (
          <p className="mt-1 text-muted">
            If Google shows &quot;This app is blocked,&quot; skip Link Gmail and set up the Gmail filter below instead.
          </p>
        ) : null}
      </li>

      {paymentInboxAddress && role === "manager" ? (
        <li className="text-foreground">
          <span className="font-medium text-foreground">Set up a Gmail filter</span>
          <span className="text-muted"> (optional if Gmail is linked above)</span>
          <ul className="mt-2 list-disc space-y-1 pl-4">
            <li>
              In the Gmail account that receives your {channelLabel} alerts, open Settings → Filters → Create filter.
            </li>
            <li>
              From: <span className="font-mono">{filterFrom}</span>
              {filterSubject ? (
                <>
                  {" "}
                  — optionally add Subject contains <span className="font-mono">{filterSubject}</span> if you get too
                  much other mail from those senders.
                </>
              ) : null}
            </li>
            <li>
              Choose “Forward it to” and add{" "}
              <code className="break-all rounded bg-card px-1 py-0.5 text-[11px] text-foreground">
                {paymentInboxAddress}
              </code>{" "}
              <button
                type="button"
                onClick={() =>
                  void navigator.clipboard?.writeText(paymentInboxAddress).then(() => showToast("Copied."))
                }
                className="font-medium text-primary hover:underline"
              >
                Copy
              </button>
            </li>
            <li>Save the filter. Forwarded {channelLabel} receipts are matched as soon as they arrive.</li>
          </ul>
        </li>
      ) : null}

      {role === "manager" ? (
        <li className="text-foreground">
          <label className="flex cursor-pointer items-start gap-2">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={autoMarkEnabled}
              onChange={(e) => void onAutoMarkChange(e.target.checked)}
              data-attr={channel ? `manager-payment-${channel}-auto-mark` : "manager-payment-auto-mark-toggle"}
            />
            <span>
              <span className="font-medium text-foreground">Automatically mark matching charges paid</span>
              <span className="block text-muted">
                Turn this on so {channelLabel} receipts mark the right charge without a manual review.
              </span>
            </span>
          </label>
        </li>
      ) : null}
    </ol>
  );
}

export function GmailPaymentAutoTrackPanel({
  role,
  demo,
  paymentInboxAddress,
  autoMarkEnabled,
  onAutoMarkChange,
  showToast,
}: {
  role: GmailPaymentTrackRole;
  demo: boolean;
  paymentInboxAddress?: string;
  autoMarkEnabled: boolean;
  onAutoMarkChange: (enabled: boolean) => void | Promise<void>;
  showToast: (message: string) => void;
}) {
  const { gmailStatus, gmailBusy, linkGmail } = useGmailPaymentTrack({
    role,
    demo,
    showToast,
  });

  const roleHint =
    role === "manager"
      ? "incoming Zelle/Venmo from residents"
      : "incoming Zelle/Venmo payouts from your manager";

  return (
    <div className="rounded-xl border border-border bg-muted/30 px-4 py-3 space-y-3">
      <p className="text-xs font-medium uppercase tracking-wide text-muted">Auto-track receipts</p>
      <p className="text-sm text-foreground">
        Link each Gmail inbox that receives payment alerts (Zelle and Venmo can use different addresses). We match the{" "}
        <span className="font-mono">{role === "manager" ? "PL-" : "WO-"}</span> code and amount, then mark{" "}
        {role === "manager" ? "the charge" : "the service"} paid.
      </p>
      <div className="rounded-xl border border-border bg-card px-4 py-3">
        <GmailPaymentTrackSteps
          role={role}
          paymentInboxAddress={paymentInboxAddress}
          autoMarkEnabled={autoMarkEnabled}
          onAutoMarkChange={onAutoMarkChange}
          gmailStatus={gmailStatus}
          gmailBusy={gmailBusy}
          onLinkGmail={linkGmail}
          showToast={showToast}
        />
      </div>
    </div>
  );
}
