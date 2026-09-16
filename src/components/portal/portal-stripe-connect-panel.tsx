"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { ManagerPortalPageShell, PORTAL_HEADER_ACTION_BTN } from "@/components/portal/portal-metrics";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { openStripeConnectOnboarding } from "@/lib/stripe-connect-onboarding-client";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { track } from "@/lib/analytics/track-client";

type ConnectStatus = {
  connected: boolean;
  accountId: string | null;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  transfersEnabled?: boolean;
  paymentReady?: boolean;
  transfersStatus?: string | null;
  detailsSubmitted: boolean;
  demo?: boolean;
  message?: string;
  stripeError?: string;
};

/** Realistic "already connected" mock shown in the /demo sandbox — never hits real Stripe. */
const DEMO_CONNECT_STATUS: ConnectStatus = {
  connected: true,
  accountId: "acct_demo_sandbox",
  chargesEnabled: true,
  payoutsEnabled: true,
  transfersEnabled: true,
  paymentReady: true,
  detailsSubmitted: true,
};

export function PortalStripeConnectPanel({
  basePath,
  variant = "page",
  apiBase = "/api/stripe/connect",
  returnPath,
  dataAttrPrefix = "stripe-connect",
  onConnectDone,
  analyticsScope,
  onOpenPaymentSetup,
}: {
  basePath: string;
  variant?: "page" | "embedded" | "inline" | "header";
  /** Base path for the status/onboard API pair — defaults to the manager Connect routes. */
  apiBase?: string;
  /** Path the client cleans `?connect=` params off of after returning from Stripe. Defaults to `${basePath}/payments`. */
  returnPath?: string;
  /** Prefix for data-attr hooks on the connect/update button. */
  dataAttrPrefix?: string;
  /** Called after Stripe redirects back with `?connect=done` (same-tab return). */
  onConnectDone?: () => void;
  /** Opens the unified payment setup modal (Stripe). */
  onOpenPaymentSetup?: () => void;
  /**
   * When "vendor", emit the `payout_setup_started` / `payout_setup_completed`
   * funnel events for vendor Connect onboarding. Omitted for the manager panel
   * so its analytics behavior is unchanged.
   */
  analyticsScope?: "vendor";
}) {
  const { showToast } = useAppUi();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [status, setStatus] = useState<ConnectStatus | null>(null);
  const [statusLoaded, setStatusLoaded] = useState(false);
  const handledConnectParam = useRef(false);
  const payoutSetupStartedThisSession = useRef(false);
  const payoutCompletedFired = useRef(false);
  const resolvedReturnPath = returnPath ?? `${basePath}/payments`;
  const payoutsPath = `${basePath}/payments/payouts`;

  const loadStatus = useCallback(async () => {
    if (isDemoModeActive()) {
      setStatus(DEMO_CONNECT_STATUS);
      setStatusLoaded(true);
      return;
    }
    try {
      const res = await fetch(`${apiBase}/status`, { credentials: "include" });
      const body = (await res.json()) as ConnectStatus & { error?: string };
      if (!res.ok) {
        setStatus(null);
        return;
      }
      setStatus(body);
    } catch {
      setStatus(null);
    } finally {
      setStatusLoaded(true);
    }
  }, [apiBase]);

  useEffect(() => {
    const id = window.setTimeout(() => void loadStatus(), 0);
    return () => window.clearTimeout(id);
  }, [loadStatus]);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      if (e.data?.type === "axis-stripe-connect") {
        void loadStatus();
      }
    };
    const onCustom = () => void loadStatus();
    window.addEventListener("message", onMsg);
    window.addEventListener("axis-stripe-connect-refresh", onCustom);
    return () => {
      window.removeEventListener("message", onMsg);
      window.removeEventListener("axis-stripe-connect-refresh", onCustom);
    };
  }, [loadStatus]);

  useEffect(() => {
    if (typeof window === "undefined" || handledConnectParam.current) return;
    const q = new URLSearchParams(window.location.search).get("connect");
    if (q !== "done" && q !== "refresh") return;
    handledConnectParam.current = true;
    if (q === "done") {
      if (analyticsScope === "vendor") payoutSetupStartedThisSession.current = true;
      showToast("Bank account linked. You're ready to receive resident payments.");
      onConnectDone?.();
    } else {
      showToast("Setup link expired. Try again.");
    }
    window.history.replaceState({}, "", resolvedReturnPath);
    queueMicrotask(() => {
      if (q === "done") setActionError(null);
      void loadStatus();
    });
  }, [analyticsScope, loadStatus, onConnectDone, resolvedReturnPath, showToast]);

  // Vendor payout-onboarding funnel: fire `payout_setup_completed` once when the
  // vendor's Connect account reaches payout-ready after a setup was started in
  // this session (a `startConnect` click or a `?connect=done` return from
  // Stripe) — an already-ready account merely loading its status is not a
  // completion. The eventual server-confirmed source is Phase 2's
  // `account.updated` webhook.
  useEffect(() => {
    if (
      analyticsScope !== "vendor" ||
      payoutCompletedFired.current ||
      !payoutSetupStartedThisSession.current ||
      !status
    )
      return;
    const ready =
      status.connected &&
      Boolean(status.paymentReady ?? (status.transfersEnabled && status.payoutsEnabled));
    if (ready) {
      payoutCompletedFired.current = true;
      track("payout_setup_completed");
    }
  }, [analyticsScope, status]);

  const startConnect = useCallback(async (): Promise<boolean> => {
    setBusy(true);
    setActionError(null);
    if (analyticsScope === "vendor") {
      track("payout_setup_started");
      payoutSetupStartedThisSession.current = true;
    }
    const opened = await openStripeConnectOnboarding({
      apiBase,
      showToast: (message) => {
        if (message.startsWith("Could not") || message.includes("pop-ups")) {
          setActionError(message);
        }
        showToast(message);
      },
    });
    if (opened) setActionError(null);
    setBusy(false);
    return opened;
  }, [apiBase, showToast, analyticsScope]);

  const openBankManagement = useCallback(() => {
    if (isDemoModeActive()) {
      setManageOpen(true);
      return;
    }
    router.push(payoutsPath);
  }, [payoutsPath, router]);

  const handleLinkedBankClick = useCallback(() => {
    if (isDemoModeActive()) {
      openBankManagement();
      return;
    }
    void startConnect().then((opened) => {
      if (!opened) openBankManagement();
    });
  }, [openBankManagement, startConnect]);

  const ready =
    status &&
    status.connected &&
    Boolean(status.paymentReady ?? (status.transfersEnabled && status.payoutsEnabled)) &&
    !status.demo;

  const blockingError = actionError ?? status?.stripeError ?? null;

  const bankManageModal = (
    <Modal open={manageOpen} title="Bank account" onClose={() => setManageOpen(false)}>
      <PortalStripeConnectPanel
        basePath={basePath}
        variant="embedded"
        apiBase={apiBase}
        returnPath={returnPath}
        dataAttrPrefix={dataAttrPrefix}
        onConnectDone={onConnectDone}
      />
    </Modal>
  );

  if (variant === "header") {
    if (status?.demo) return null;

    if (!statusLoaded) {
      return (
        <div
          className={`${PORTAL_HEADER_ACTION_BTN} h-9 w-[5.5rem] shrink-0 animate-pulse rounded-full bg-accent/30`}
          aria-hidden
        />
      );
    }

    if (ready) {
      return (
        <>
          <Button
            type="button"
            variant="outline"
            className={`shrink-0 ${PORTAL_HEADER_ACTION_BTN} portal-badge-success ring-1 ring-[color-mix(in_srgb,currentColor_25%,transparent)] hover:opacity-90`}
            disabled={busy}
            onClick={handleLinkedBankClick}
            data-attr={`${dataAttrPrefix}-linked`}
            aria-label="Manage linked bank account"
            title={blockingError ?? "View or update your linked bank account"}
          >
            {busy ? "Opening…" : "Bank linked"}
          </Button>
          {bankManageModal}
        </>
      );
    }

    const needsFinish = Boolean(status?.connected);
    const label = needsFinish ? "Finish setup" : "Link bank";
    const openSetup = onOpenPaymentSetup ?? (() => void startConnect());

    return (
      <Button
        type="button"
        variant={needsFinish ? "primary" : "outline"}
        className={`shrink-0 ${PORTAL_HEADER_ACTION_BTN}`}
        disabled={busy}
        onClick={() => openSetup()}
        data-attr={`${dataAttrPrefix}-link`}
        title={blockingError ?? (needsFinish ? "Finish payment setup (bank)" : "Open payment setup")}
      >
        {busy ? "Opening…" : label}
      </Button>
    );
  }

  if (variant === "inline") {
    if (status?.demo) return null;

    if (!statusLoaded) {
      return (
        <div
          className="inline-flex h-9 min-w-[11.5rem] shrink-0 rounded-full border border-border bg-accent/30"
          aria-hidden
        />
      );
    }

    const statusLabel = ready ? "Bank linked" : status?.connected ? "Finish bank setup" : "Bank not linked";

    return (
      <>
        <div className="flex h-9 w-full min-w-0 max-w-full items-center gap-1 rounded-2xl border border-border bg-accent/30 p-1 sm:w-auto sm:rounded-full">
          <button
            type="button"
            className={`flex min-h-9 min-w-0 flex-1 items-center truncate rounded-full px-4 py-1.5 text-sm font-semibold transition hover:opacity-90 sm:min-w-[7.5rem] sm:flex-none ${
              ready
                ? "portal-badge-success ring-1 ring-[color-mix(in_srgb,currentColor_25%,transparent)]"
                : blockingError
                  ? "text-rose-700 dark:text-rose-400"
                  : "text-muted"
            }`}
            title={blockingError ?? statusLabel}
            disabled={busy}
            onClick={() => (ready ? handleLinkedBankClick() : void startConnect())}
            data-attr={ready ? `${dataAttrPrefix}-linked` : undefined}
          >
            {blockingError ? "Bank error" : statusLabel}
          </button>
          <button
            type="button"
            data-attr={`${dataAttrPrefix}-link`}
            className={`flex min-h-9 shrink-0 items-center rounded-full px-4 py-1.5 text-sm font-semibold transition-all duration-150 disabled:opacity-60 ${
              ready
                ? "border border-border bg-card/80 text-foreground shadow-[var(--shadow-sm)] hover:border-primary/30"
                : "btn-cobalt hover:opacity-90"
            }`}
            disabled={busy}
            onClick={() => (ready ? handleLinkedBankClick() : void startConnect())}
          >
            {busy ? "Opening…" : ready ? "Update" : "Link"}
          </button>
        </div>
        {ready ? bankManageModal : null}
      </>
    );
  }

  const liveOnLocalHttp =
    typeof window !== "undefined" &&
    window.location.protocol === "http:" &&
    (process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY?.trim().startsWith("pk_live_") ?? false);

  const stripeTestMode =
    typeof window !== "undefined" &&
    (process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY?.trim().startsWith("pk_test_") ?? false);

  const body = (
    <div className={`space-y-3 text-sm text-muted ${variant === "embedded" ? "" : "max-w-2xl"}`}>
      {status?.demo ? (
        <p className="rounded-xl border px-4 py-3 text-sm portal-banner-pending">
          {status.message ?? "Add Stripe keys to enable bank linking."}
        </p>
      ) : null}

      {variant !== "embedded" ? (
        <>
          {stripeTestMode && !status?.demo ? (
            <p className="rounded-xl border px-4 py-3 text-sm portal-banner-pending [html[data-native]_&]:hidden">
              Stripe test mode is active. Onboarding uses sandbox test banks (e.g. code <span className="font-mono">000000</span>).
              Set live keys (<span className="font-mono">sk_live_</span> / <span className="font-mono">pk_live_</span>) in production to link a real account.
            </p>
          ) : null}

          {liveOnLocalHttp && !blockingError ? (
            <p className="rounded-xl border px-4 py-3 text-sm portal-banner-pending [html[data-native]_&]:hidden">
              You are using live Stripe keys on http://localhost. Bank linking requires HTTPS. Use test keys locally, or deploy
              to your https production URL.
            </p>
          ) : null}
        </>
      ) : null}

      {blockingError ? (
        <p className="rounded-xl border px-4 py-3 text-sm portal-banner-danger">{blockingError}</p>
      ) : null}

      {!status?.demo ? (
        <div
          className={
            variant === "embedded"
              ? "flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-card px-3 py-2.5"
              : "rounded-2xl border border-border bg-card px-4 py-5"
          }
        >
          {ready ? (
            <div className="flex w-full flex-wrap items-center justify-between gap-3">
              <span className="inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold portal-badge-success ring-1 ring-[color-mix(in_srgb,currentColor_25%,transparent)]">
                Bank linked
              </span>
              <Button
                type="button"
                variant="outline"
                data-attr={`${dataAttrPrefix}-update`}
                className="rounded-full"
                disabled={busy}
                onClick={() => startConnect()}
              >
                {busy ? "Opening…" : "Update bank details"}
              </Button>
            </div>
          ) : (
            <div className="flex w-full flex-wrap items-center justify-between gap-3">
              <span className="inline-flex items-center rounded-full border border-border bg-accent/30 px-2.5 py-0.5 text-[11px] font-semibold text-muted ring-1 ring-[color-mix(in_srgb,currentColor_25%,transparent)]">
                {status?.connected ? "Finish setup" : "Not connected"}
              </span>
              <Button
                type="button"
                variant="primary"
                data-attr={`${dataAttrPrefix}-link`}
                className="rounded-full"
                disabled={busy}
                onClick={() => startConnect()}
              >
                {busy ? "Opening…" : "Link bank account"}
              </Button>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );

  if (variant === "embedded") {
    return body;
  }

  return <ManagerPortalPageShell title="Bank account">{body}</ManagerPortalPageShell>;
}
