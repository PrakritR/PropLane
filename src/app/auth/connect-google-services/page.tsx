"use client";

import type { ReactNode } from "react";
import { AuthCard } from "@/components/auth/auth-card";
import { AuthPageHeader } from "@/components/auth/auth-mobile-primitives";
import {
  ManagerOnboardingAssistantEmailSetup,
  ManagerOnboardingPhoneSetup,
  ManagerOnboardingWorkNumberSetup,
} from "@/components/auth/manager-onboarding-inline-setup";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { Button } from "@/components/ui/button";
import { MANAGER_GOOGLE_SERVICES_ONBOARDING_PATH } from "@/lib/auth/manager-google-services-onboarding";
import { formatGoogleCalendarConnectError } from "@/lib/google-calendar/connect-errors";
import { portalDashboardPath } from "@/lib/auth/portal-roles";
import { assistantEmailUpsellMessage } from "@/lib/manager-assistant-email/assistant-email-eligibility-copy";
import type { ManagerAssistantEmailStatus } from "@/lib/manager-assistant-email/manager-assistant-email-status";
import {
  shouldOfferWorkNumberSetup,
  workNumberOnboardingPhone,
  type WorkNumberOnboardingStatus,
} from "@/lib/sms/work-number-onboarding";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";

type GoogleServicesStatus = {
  dismissed: boolean;
  pending: boolean;
  calendarConnected: boolean;
  calendarConfigured: boolean;
  gmailConnected: boolean;
  gmailConfigured: boolean;
  calendarEmail: string | null;
  gmailEmail: string | null;
};

type PhoneSettings = {
  phone: string | null;
  phoneVerifiedAt: string | null;
};

function formatGcalConnectError(reason: string | null): string {
  return formatGoogleCalendarConnectError(reason);
}

function formatGmailConnectError(reason: string | null): string {
  if (!reason) return "Could not connect Gmail.";
  return `Could not connect Gmail: ${decodeURIComponent(reason)}`;
}

function formatUsPhone(e164: string | null | undefined): string {
  const digits = String(e164 ?? "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return e164?.trim() || "";
}

function SetupOptionCard({
  title,
  description,
  statusLabel,
  statusTone = "confirmed",
  action,
  children,
}: {
  title: string;
  description: string;
  statusLabel?: string | null;
  statusTone?: "confirmed" | "muted";
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">{title}</p>
          <p className="mt-1 text-xs leading-relaxed text-muted">{description}</p>
          {statusLabel ? (
            <p
              className={`mt-2 text-xs font-medium ${
                statusTone === "confirmed" ? "text-[var(--status-confirmed-fg)]" : "text-muted"
              }`}
            >
              {statusLabel}
            </p>
          ) : null}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

function ConnectGoogleServicesContent() {
  const { showToast } = useAppUi();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<GoogleServicesStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [skipping, setSkipping] = useState(false);
  const [workNumber, setWorkNumber] = useState<WorkNumberOnboardingStatus | null>(null);
  const [phoneSettings, setPhoneSettings] = useState<PhoneSettings | null>(null);
  const [assistantEmail, setAssistantEmail] = useState<ManagerAssistantEmailStatus | null>(null);

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
      try {
        const [workRes, phoneRes, emailRes] = await Promise.all([
          fetch("/api/manager/messaging-number", { credentials: "include", cache: "no-store" }),
          fetch("/api/manager/phone", { credentials: "include", cache: "no-store" }),
          fetch("/api/manager/assistant-email", { credentials: "include", cache: "no-store" }),
        ]);
        if (workRes.ok) setWorkNumber((await workRes.json()) as WorkNumberOnboardingStatus);
        if (phoneRes.ok) setPhoneSettings((await phoneRes.json()) as PhoneSettings);
        if (emailRes.ok) setAssistantEmail((await emailRes.json()) as ManagerAssistantEmailStatus);
      } catch {
        /* optional signup step — failed reads stay quiet */
      }
    })();
  }, []);

  useEffect(() => {
    void (async () => {
      const body = await loadStatus();
      if (!body) {
        setLoading(false);
        return;
      }
      if (body.dismissed || !body.pending) {
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
  const phoneVerified = Boolean(phoneSettings?.phoneVerifiedAt);
  const phoneDisplay = formatUsPhone(phoneSettings?.phone);
  const assistantAddress = assistantEmail?.address?.trim() || "";
  const assistantReady = Boolean(assistantAddress);
  const assistantUpsell =
    assistantEmail && !assistantEmail.canRequest
      ? assistantEmailUpsellMessage(assistantEmail.planTier, assistantEmail.entitlement)
      : null;
  const offerWorkNumber = shouldOfferWorkNumberSetup(workNumber);

  return (
    <AuthCard wide variant="blend">
      <div className="auth-plan-picker auth-plan-picker-wide">
        <AuthPageHeader
          eyebrow="Manager"
          title="Set up your account"
          subtitle="Optional. You can do this later in Settings."
          accent={false}
        />

        <div className="mt-5 space-y-3">
          <SetupOptionCard
            title="Personal phone"
            description="Verify your cell so PropLane can text you alerts and forward inbound SMS."
            statusLabel={
              phoneVerified && phoneDisplay
                ? `Verified · ${phoneDisplay}`
                : phoneDisplay
                  ? `Added · ${phoneDisplay} — verification pending`
                  : "Not added yet"
            }
            statusTone={phoneVerified ? "confirmed" : "muted"}
          >
            {!phoneVerified ? (
              <ManagerOnboardingPhoneSetup
                initialPhone={phoneSettings?.phone ?? ""}
                phoneVerified={phoneVerified}
                onUpdated={(next) =>
                  setPhoneSettings({
                    phone: next.phone,
                    phoneVerifiedAt: next.phoneVerifiedAt,
                  })
                }
              />
            ) : null}
          </SetupOptionCard>

          <SetupOptionCard
            title="PropLane work number"
            description="Text residents and prospects; replies land in your inbox."
            statusLabel={
              provisionedNumber
                ? `Active · ${provisionedNumber}`
                : offerWorkNumber
                  ? "Not set up yet"
                  : "Available in Settings when SMS is enabled on your plan"
            }
            statusTone={provisionedNumber ? "confirmed" : "muted"}
          >
            {!provisionedNumber && offerWorkNumber && workNumber ? (
              <ManagerOnboardingWorkNumberSetup status={workNumber} onUpdated={setWorkNumber} />
            ) : null}
          </SetupOptionCard>

          <SetupOptionCard
            title="PropLane assistant email"
            description="Email your assistant from any device — same capabilities as texting your work number."
            statusLabel={
              assistantReady
                ? `Ready · ${assistantAddress}`
                : assistantUpsell ?? (assistantEmail?.canRequest ? "Not requested yet" : null)
            }
            statusTone={assistantReady ? "confirmed" : "muted"}
          >
            {!assistantReady && assistantEmail ? (
              <ManagerOnboardingAssistantEmailSetup status={assistantEmail} onUpdated={setAssistantEmail} />
            ) : null}
          </SetupOptionCard>

          <SetupOptionCard
            title="Google Calendar"
            description="Keeps tours in sync so nothing double-books."
            statusLabel={
              status.calendarConnected
                ? `Connected${status.calendarEmail ? ` · ${status.calendarEmail}` : ""}`
                : null
            }
            statusTone="confirmed"
            action={
              !status.calendarConnected ? (
                <Button
                  type="button"
                  variant="primary"
                  className="min-h-0 h-8 rounded-full px-4 text-xs"
                  data-attr="onboarding-connect-calendar"
                  disabled={!status.calendarConfigured}
                  onClick={connectCalendar}
                >
                  Connect Calendar
                </Button>
              ) : null
            }
          />
        </div>

        {!status.calendarConfigured ? (
          <p className="mt-3 text-xs text-muted" data-attr="onboarding-calendar-unavailable">
            Calendar sync isn&apos;t available in this environment. You can connect it later in Settings.
          </p>
        ) : null}

        <div className="mt-6 flex justify-end">
          <Button
            type="button"
            variant="primary"
            className="min-h-0 h-9 rounded-full px-5 text-[13px]"
            data-attr="onboarding-google-services-continue"
            disabled={skipping}
            onClick={() => void continueToPortal()}
          >
            {skipping ? "One moment…" : "Continue to portal"}
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
