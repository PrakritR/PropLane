"use client";

import { AuthCard } from "@/components/auth/auth-card";
import { AuthPageHeader } from "@/components/auth/auth-mobile-primitives";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { Button } from "@/components/ui/button";
import { MANAGER_GOOGLE_SERVICES_ONBOARDING_PATH } from "@/lib/auth/manager-google-services-onboarding";
import { formatGoogleCalendarConnectError } from "@/lib/google-calendar/connect-errors";
import { portalDashboardPath } from "@/lib/auth/portal-roles";
import {
  shouldOfferWorkNumberSetup,
  workNumberOnboardingPhone,
  type WorkNumberOnboardingStatus,
} from "@/lib/sms/work-number-onboarding";
import { BANNER_INFO_CLASS } from "@/lib/ui-styles";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";

/**
 * The full provisioning flow (area code, plan gate, retry diagnostics) stays in
 * Settings — this step SHOWS the state and routes there, rather than growing a
 * second copy of a flow that buys a real phone number.
 */
const MESSAGING_SETTINGS_PATH = "/portal/profile";

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
  const [workNumber, setWorkNumber] = useState<WorkNumberOnboardingStatus | null>(null);

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
    // Best-effort: a failure here must never block the Google step, so the card
    // simply does not render rather than surfacing an error the manager did not
    // ask for during signup.
    void (async () => {
      try {
        const res = await fetch("/api/manager/messaging-number", {
          credentials: "include",
          cache: "no-store",
        });
        if (!res.ok) return;
        const body = (await res.json()) as WorkNumberOnboardingStatus;
        setWorkNumber(body);
      } catch {
        /* ignore */
      }
    })();
  }, []);

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

  /**
   * Mark the step seen and go to the portal.
   *
   * This replaces a "Skip for now" and an "Enter portal" that both POSTed the
   * same `skip` and landed in the same place — the only difference was that one
   * of them was hidden until something was connected. A step this optional needs
   * one button, and a failed write must not strand the manager on it, so the
   * navigation happens either way.
   */
  const continueToPortal = async () => {
    setSkipping(true);
    try {
      await fetch("/api/auth/manager-google-services", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "skip" }),
      }).catch(() => undefined);
      router.replace(portalDashboardPath("manager"));
    } finally {
      setSkipping(false);
    }
  };

  if (loading || !status) {
    return (
      <AuthCard wide variant="blend">
        <p className="py-10 text-center text-sm text-muted">Loading…</p>
      </AuthCard>
    );
  }


  const provisionedNumber = workNumberOnboardingPhone(workNumber);
  const workNumberCard = shouldOfferWorkNumberSetup(workNumber) ? (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">PropLane work number</p>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            Text residents and prospects; replies land in your inbox.
          </p>
          {provisionedNumber ? (
            <p className="mt-2 text-xs font-medium text-[var(--status-confirmed-fg)]">
              Active · {provisionedNumber}
            </p>
          ) : null}
        </div>
        {!provisionedNumber ? (
          <Button
            type="button"
            variant="primary"
            className="rounded-full"
            data-attr="onboarding-set-up-work-number"
            onClick={() => router.push(MESSAGING_SETTINGS_PATH)}
          >
            Set up work number
          </Button>
        ) : null}
      </div>
    </div>
  ) : null;

  return (
    <AuthCard wide variant="blend">
      <div className="auth-plan-picker auth-plan-picker-wide">
        <AuthPageHeader
          eyebrow="Manager"
          title="Connect Google Calendar"
          subtitle="Optional. You can do this later in Settings."
          accent={false}
        />

        <div className="mt-5 space-y-3">
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-foreground">Google Calendar</p>
                <p className="mt-1 text-xs leading-relaxed text-muted">
                  Keeps tours in sync so nothing double-books.
                </p>
                {status.calendarConnected ? (
                  <p className="mt-2 text-xs font-medium text-[var(--status-confirmed-fg)]">
                    Connected
                    {status.calendarEmail ? ` · ${status.calendarEmail}` : ""}
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

          {workNumberCard}
        </div>

        {!status.calendarConfigured ? (
          <div className={`mt-4 ${BANNER_INFO_CLASS}`}>Google sign-in is not set up on this server yet.</div>
        ) : null}

        {/*
          One way forward, not two. "Skip for now" and "Enter portal" did the same
          thing — mark the step seen and go to the portal — and having both made a
          single optional connection look like a decision with consequences.
        */}
        <div className="mt-6">
          <Button
            type="button"
            variant="primary"
            className="w-full rounded-full"
            data-attr="onboarding-google-services-continue"
            disabled={skipping}
            onClick={() => void continueToPortal()}
          >
            {skipping ? "One moment…" : "Continue"}
          </Button>
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
