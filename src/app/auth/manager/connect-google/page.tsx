"use client";

import { CalendarDays, Check, ChevronRight, Mail, ShieldCheck } from "lucide-react";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { AuthCard } from "@/components/auth/auth-card";
import { AuthPageHeader } from "@/components/auth/auth-mobile-primitives";
import { useAuthWelcomeChrome } from "@/components/auth/use-auth-welcome-chrome";
import { Button } from "@/components/ui/button";
import { isGmailPaymentsOAuthBlocked } from "@/lib/gmail-payments/connect-errors";
import { GMAIL_PAYMENTS_ENABLED } from "@/lib/gmail-payments/enabled";
import { MANAGER_GOOGLE_SERVICES_PATH } from "@/lib/auth/manager-google-services";

type ServiceStatus = {
  connected: boolean;
  email: string | null;
  configured: boolean;
};

const EMPTY_STATUS: ServiceStatus = { connected: false, email: null, configured: true };

function gmailOnboardingError(reason: string | null): string {
  if (isGmailPaymentsOAuthBlocked(reason)) {
    return "Google has not approved Gmail access for this account yet. You can skip for now and connect later without blocking account setup.";
  }
  return reason?.trim() || "Gmail could not be connected. You can retry or skip for now.";
}

function ServiceCard({
  service,
  title,
  description,
  icon,
  status,
  loading,
}: {
  service: "calendar" | "gmail";
  title: string;
  description: string;
  icon: React.ReactNode;
  status: ServiceStatus;
  loading: boolean;
}) {
  const connectEndpoint =
    service === "calendar"
      ? "/api/portal/google-calendar/connect"
      : "/api/portal/gmail-payments/connect";
  const href = `${connectEndpoint}?returnTo=${encodeURIComponent(MANAGER_GOOGLE_SERVICES_PATH)}`;
  const connectedLabel = status.email ? `Connected as ${status.email}` : "Connected";

  return (
    <section className="rounded-[18px] border border-border/75 bg-card/65 p-4 shadow-[0_12px_34px_-28px_rgba(15,23,42,0.45)] sm:p-5">
      <div className="flex min-w-0 items-start gap-3.5">
        <span
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary"
          aria-hidden
        >
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h2 className="text-[15px] font-semibold text-foreground sm:text-base">{title}</h2>
            {status.connected ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-[var(--status-confirmed-bg)] px-2 py-0.5 text-[10px] font-semibold text-[var(--status-confirmed-fg)]">
                <Check className="h-3 w-3" aria-hidden /> Connected
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted sm:text-[13px]">{description}</p>
          {status.connected ? (
            <p className="mt-2 break-all text-xs font-medium text-[var(--status-confirmed-fg)]">{connectedLabel}</p>
          ) : null}
        </div>
      </div>

      <Button
        asChild
        variant={status.connected ? "outline" : "primary"}
        className="mt-4 w-full justify-between px-4"
      >
        <a
          href={href}
          data-attr={`manager-google-onboarding-connect-${service}`}
          aria-disabled={loading || !status.configured ? true : undefined}
          onClick={(event) => {
            if (loading || !status.configured) event.preventDefault();
          }}
        >
          <span>
            {loading
              ? "Checking connection…"
              : !status.configured
                ? "Google connection unavailable"
                : status.connected
                  ? `Reconnect ${service === "calendar" ? "Calendar" : "Gmail"}`
                  : `Connect ${service === "calendar" ? "Calendar" : "Gmail"}`}
          </span>
          <ChevronRight className="h-4 w-4" aria-hidden />
        </a>
      </Button>
    </section>
  );
}

function GoogleServicesContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [calendar, setCalendar] = useState<ServiceStatus>(EMPTY_STATUS);
  const [gmail, setGmail] = useState<ServiceStatus>(EMPTY_STATUS);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  useAuthWelcomeChrome(true);

  const oauthMessage = useMemo(() => {
    if (searchParams.get("calendar") === "connected") return "Google Calendar is connected.";
    if (searchParams.get("gmail") === "connected") return "Gmail payment tracking is connected.";
    const calendarReason = searchParams.get("calendarReason");
    if (searchParams.get("calendar") === "error") {
      return calendarReason || "Google Calendar could not be connected. You can retry or skip for now.";
    }
    const gmailReason = searchParams.get("gmailReason");
    if (searchParams.get("gmail") === "error") {
      return gmailOnboardingError(gmailReason);
    }
    return null;
  }, [searchParams]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [calendarResponse, gmailResponse] = await Promise.all([
          fetch("/api/portal/google-calendar", { credentials: "include", cache: "no-store" }),
          fetch("/api/portal/gmail-payments", { credentials: "include", cache: "no-store" }),
        ]);
        if (cancelled) return;
        if (calendarResponse.status === 401 || gmailResponse.status === 401) {
          router.replace(`/auth/sign-in?next=${encodeURIComponent(MANAGER_GOOGLE_SERVICES_PATH)}`);
          return;
        }
        const calendarBody = (await calendarResponse.json().catch(() => ({}))) as Partial<ServiceStatus> & {
          error?: string;
        };
        const gmailBody = (await gmailResponse.json().catch(() => ({}))) as {
          status?: Partial<ServiceStatus>;
          error?: string;
        };
        if (!calendarResponse.ok || !gmailResponse.ok) {
          throw new Error(calendarBody.error || gmailBody.error || "Could not check Google connections.");
        }
        setCalendar({
          connected: calendarBody.connected === true,
          email: calendarBody.email?.trim() || null,
          configured: calendarBody.configured !== false,
        });
        setGmail({
          connected: gmailBody.status?.connected === true,
          email: gmailBody.status?.email?.trim() || null,
          configured: gmailBody.status?.configured !== false,
        });
      } catch (error) {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : "Could not check Google connections.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  const hasConnection = calendar.connected || gmail.connected;

  return (
    <AuthCard wide variant="blend">
      <div className="mx-auto w-full max-w-[42rem]">
        <AuthPageHeader
          showLogo
          title="Connect Google services"
          subtitle="Choose only the tools you want. Each connection opens its own Google permission screen."
          accent={false}
        />

        <div className="mx-auto mt-4 flex max-w-xl items-start gap-2 rounded-2xl border border-primary/15 bg-primary/[0.055] px-3.5 py-3 text-xs leading-relaxed text-muted sm:mt-5">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
          <p>Calendar access never grants Gmail access, and Gmail access never grants Calendar access.</p>
        </div>

        {oauthMessage ? (
          <p
            role="status"
            className="mt-4 rounded-2xl border border-border bg-card/70 px-3.5 py-3 text-center text-xs leading-relaxed text-foreground"
          >
            {oauthMessage}
          </p>
        ) : null}
        {loadError ? (
          <p role="alert" className="mt-4 text-center text-xs text-rose-600">
            {loadError} You can still skip this step and connect later in Settings.
          </p>
        ) : null}

        <div className="mt-4 grid min-w-0 gap-3 sm:mt-5 sm:grid-cols-2">
          <ServiceCard
            service="calendar"
            title="Google Calendar"
            description="Synchronize tours and use your busy time to prevent double-booking."
            icon={<CalendarDays className="h-5 w-5" />}
            status={calendar}
            loading={loading}
          />
          {/* Gmail receipt matching is off (PRP-130) — `gmail.readonly` is a
              RESTRICTED Google scope, and Zelle/Venmo are recorded by hand for
              now. Calendar alone is only "sensitive", which is the whole point
              of removing this card. */}
          {GMAIL_PAYMENTS_ENABLED ? (
            <ServiceCard
              service="gmail"
              title="Gmail payment receipts"
              description="Read supported payment receipts and automatically match them to payments. PropLane cannot send or delete email."
              icon={<Mail className="h-5 w-5" />}
              status={gmail}
              loading={loading}
            />
          ) : null}
        </div>

        <div className="mt-5 flex flex-col items-center gap-3 sm:mt-6">
          <Button
            type="button"
            data-attr="manager-google-onboarding-continue"
            className="w-full max-w-sm"
            onClick={() => window.location.replace("/portal/dashboard")}
          >
            {hasConnection ? "Continue to your portal" : "Skip for now"}
          </Button>
          <p className="text-center text-[11px] leading-relaxed text-muted">
            You can connect, disconnect, or change either service later from Calendar or Payments.
          </p>
        </div>
      </div>
    </AuthCard>
  );
}

export default function ManagerGoogleServicesPage() {
  return (
    <Suspense
      fallback={
        <AuthCard wide variant="blend">
          <p className="py-10 text-center text-sm text-muted">Loading Google connections…</p>
        </AuthCard>
      }
    >
      <GoogleServicesContent />
    </Suspense>
  );
}
