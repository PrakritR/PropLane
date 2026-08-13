"use client";

import { AuthCard } from "@/components/auth/auth-card";
import { AuthPageHeader } from "@/components/auth/auth-mobile-primitives";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { Button } from "@/components/ui/button";
import { MANAGER_GOOGLE_SERVICES_ONBOARDING_PATH } from "@/lib/auth/manager-google-services-onboarding";
import { formatGoogleCalendarConnectError } from "@/lib/google-calendar/connect-errors";
import { portalDashboardPath } from "@/lib/auth/portal-roles";
import { BANNER_INFO_CLASS, BANNER_NEUTRAL_CLASS } from "@/lib/ui-styles";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";

type GoogleServicesStatus = {
  dismissed: boolean;
  calendarConnected: boolean;
  calendarConfigured: boolean;
  gmailConnected: boolean;
  gmailConfigured: boolean;
  calendarEmail: string | null;
  gmailEmail: string | null;
};

function formatGcalConnectError(reason: string | null): string {
  return formatGoogleCalendarConnectError(reason);
}

function formatGmailConnectError(reason: string | null): string {
  if (!reason) return "Could not connect Gmail.";
  return `Could not connect Gmail: ${decodeURIComponent(reason)}`;
}

function ConnectGoogleServicesContent() {
  const { showToast } = useAppUi();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<GoogleServicesStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [skipping, setSkipping] = useState(false);

  const loadStatus = useCallback(async () => {
    const res = await fetch("/api/auth/manager-google-services", { credentials: "include", cache: "no-store" });
    if (res.status === 401 || res.status === 403) {
      router.replace("/auth/sign-in?next=" + encodeURIComponent(MANAGER_GOOGLE_SERVICES_ONBOARDING_PATH));
      return null;
    }
    const body = (await res.json().catch(() => ({}))) as GoogleServicesStatus & { error?: string };
    if (!res.ok) {
      showToast(body.error ?? "Could not load connection status.");
      return null;
    }
    setStatus(body);
    return body;
  }, [router, showToast]);

  useEffect(() => {
    void (async () => {
      const body = await loadStatus();
      if (body?.dismissed) {
        router.replace(portalDashboardPath("manager"));
        return;
      }
      setLoading(false);
    })();
  }, [loadStatus, router]);

  useEffect(() => {
    const gcal = searchParams.get("gcal");
    const gmailPay = searchParams.get("gmail-pay");
    if (!gcal && !gmailPay) return;

    if (gcal === "connected") showToast("Google Calendar connected.");
    if (gcal === "error") showToast(formatGcalConnectError(searchParams.get("reason")));
    if (gmailPay === "connected") showToast("Gmail connected for payment tracking.");
    if (gmailPay === "error") showToast(formatGmailConnectError(searchParams.get("reason")));

    const params = new URLSearchParams(searchParams.toString());
    params.delete("gcal");
    params.delete("gmail-pay");
    params.delete("reason");
    const next = `${MANAGER_GOOGLE_SERVICES_ONBOARDING_PATH}${params.size ? `?${params}` : ""}`;
    window.history.replaceState({}, "", next);
    void loadStatus();
  }, [loadStatus, searchParams, showToast]);

  const connectCalendar = () => {
    if (!status?.calendarConfigured) {
      showToast("Google Calendar OAuth is not configured on this server.");
      return;
    }
    const origin = encodeURIComponent(window.location.origin);
    const returnTo = encodeURIComponent(MANAGER_GOOGLE_SERVICES_ONBOARDING_PATH);
    window.location.assign(`/api/portal/google-calendar/connect?origin=${origin}&returnTo=${returnTo}`);
  };

  const connectGmail = () => {
    if (!status?.gmailConfigured) {
      showToast("Gmail OAuth is not configured on this server.");
      return;
    }
    const origin = encodeURIComponent(window.location.origin);
    const returnTo = encodeURIComponent(MANAGER_GOOGLE_SERVICES_ONBOARDING_PATH);
    window.location.assign(`/api/portal/gmail-payments/connect?origin=${origin}&returnTo=${returnTo}`);
  };

  const skipForNow = async () => {
    setSkipping(true);
    try {
      const res = await fetch("/api/auth/manager-google-services", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "skip" }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        showToast(body.error ?? "Could not save your choice.");
        return;
      }
      router.replace(portalDashboardPath("manager"));
    } finally {
      setSkipping(false);
    }
  };

  const enterPortal = async () => {
    await fetch("/api/auth/manager-google-services", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "skip" }),
    }).catch(() => undefined);
    router.replace(portalDashboardPath("manager"));
  };

  if (loading || !status) {
    return (
      <AuthCard wide variant="blend">
        <p className="py-10 text-center text-sm text-muted">Loading…</p>
      </AuthCard>
    );
  }

  const canEnter = status.calendarConnected || status.gmailConnected;
  const sharedGoogleEmail =
    status.calendarConnected &&
    status.gmailConnected &&
    status.calendarEmail &&
    status.gmailEmail &&
    status.calendarEmail.toLowerCase() === status.gmailEmail.toLowerCase()
      ? status.calendarEmail
      : null;

  return (
    <AuthCard wide variant="blend">
      <div className="auth-plan-picker auth-plan-picker-wide">
        <AuthPageHeader
          eyebrow="Manager"
          title="Connect Google services"
          subtitle="Optional — connect only what you need. Google asks you to approve each permission separately."
          accent={false}
        />

        <div className={`mt-5 ${BANNER_NEUTRAL_CLASS}`}>
          Link Calendar to sync tours and block double-bookings, or Gmail to read supported payment
          receipt emails and match Zelle/Venmo payments automatically. You can connect either, both, or skip
          and set this up later in Payment setup or Calendar settings.
        </div>

        {sharedGoogleEmail ? (
          <p className="mt-4 text-xs font-medium text-[var(--status-confirmed-fg)]">
            Google account · {sharedGoogleEmail}
          </p>
        ) : null}

        <div className="mt-5 space-y-3">
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-foreground">Google Calendar</p>
                <p className="mt-1 text-xs leading-relaxed text-muted">
                  Synchronize tours and prevent double-booking when prospects book online.
                </p>
                {status.calendarConnected ? (
                  <p className="mt-2 text-xs font-medium text-[var(--status-confirmed-fg)]">
                    Connected
                    {!sharedGoogleEmail && status.calendarEmail ? ` · ${status.calendarEmail}` : ""}
                  </p>
                ) : null}
              </div>
              {!status.calendarConnected ? (
                <Button
                  type="button"
                  variant="primary"
                  className="rounded-full"
                  data-attr="onboarding-connect-calendar"
                  disabled={!status.calendarConfigured}
                  onClick={connectCalendar}
                >
                  Connect Calendar
                </Button>
              ) : null}
            </div>
          </div>

          <div className="rounded-xl border border-border bg-card p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-foreground">Gmail payment receipts</p>
                <p className="mt-1 text-xs leading-relaxed text-muted">
                  Read supported Zelle and Venmo payment emails to automatically match resident payments.
                </p>
                {status.gmailConnected ? (
                  <p className="mt-2 text-xs font-medium text-[var(--status-confirmed-fg)]">
                    Connected
                    {!sharedGoogleEmail && status.gmailEmail ? ` · ${status.gmailEmail}` : ""}
                  </p>
                ) : null}
              </div>
              {!status.gmailConnected ? (
                <Button
                  type="button"
                  variant="primary"
                  className="rounded-full"
                  data-attr="onboarding-connect-gmail"
                  disabled={!status.gmailConfigured}
                  onClick={connectGmail}
                >
                  Connect Gmail for payment tracking
                </Button>
              ) : null}
            </div>
          </div>
        </div>

        {!status.calendarConfigured && !status.gmailConfigured ? (
          <div className={`mt-4 ${BANNER_INFO_CLASS}`}>
            Google OAuth is not configured in this environment. Skip for now and connect later when it is
            available.
          </div>
        ) : null}

        <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button
            type="button"
            variant="outline"
            className="rounded-full"
            data-attr="onboarding-skip-google-services"
            disabled={skipping}
            onClick={() => void skipForNow()}
          >
            {skipping ? "Saving…" : "Skip for now"}
          </Button>
          {canEnter ? (
            <Button
              type="button"
              variant="primary"
              className="rounded-full"
              data-attr="onboarding-enter-portal"
              onClick={enterPortal}
            >
              Enter portal
            </Button>
          ) : null}
        </div>
      </div>
    </AuthCard>
  );
}

export default function ConnectGoogleServicesPage() {
  return (
    <Suspense
      fallback={
        <AuthCard wide variant="blend">
          <p className="py-10 text-center text-sm text-muted">Loading…</p>
        </AuthCard>
      }
    >
      <ConnectGoogleServicesContent />
    </Suspense>
  );
}
