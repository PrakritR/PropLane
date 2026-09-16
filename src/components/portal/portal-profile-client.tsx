"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useWorkspaces } from "@/components/portal/workspace-provider";
import {
  Bell,
  BellRing,
  Building2,
  Calendar,
  CalendarDays,
  CheckSquare,
  ClipboardCheck,
  CreditCard,
  FileText,
  Home,
  KeyRound,
  Lock,
  MessageSquareText,
  MessagesSquare,
  ScrollText,
  Settings2,
  SlidersHorizontal,
  UserRound,
  Wallet,
  Wrench,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PhoneNumberField } from "@/components/ui/phone-number-field";
import { coercePhoneInput, formatSmsPhoneLabel } from "@/lib/phone-e164";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { PortalChangePasswordPanel } from "@/components/portal/portal-change-password-panel";
import { PortalBugFeedbackPanel } from "@/components/portal/portal-bug-feedback-panel";
import { PortalDetailHeader } from "@/components/portal/portal-list-detail-shell";
import { PortalSettingsExtras } from "@/components/portal/portal-settings-extras";
import { WorkspaceSettings } from "@/components/portal/workspace-settings";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import {
  PortalSettingsAutosaveField,
  PortalSettingsField,
  PortalSettingsFormBody,
  PortalSettingsGroup,
  PortalSettingsLinkRow,
  PortalSettingsNav,
  PortalSettingsProfileHeader,
  PortalSettingsRow,
  PortalSettingsSection,
  PortalSettingsSections,
  type PortalSettingsSaveState,
} from "@/components/portal/portal-settings-ui";
import { ManagerPaymentMethodsPanel } from "@/components/portal/manager-payment-methods-panel";
import { ManagerCommsBillingPanel } from "@/components/portal/manager-comms-billing-panel";
import { ManagerPlanAddonsPanel } from "@/components/portal/manager-plan-addons-panel";
import { ManagerPlan } from "@/components/portal/pro-plan";
import { ManagerApiKeysPanel } from "@/components/portal/pro-api-keys-panel";
import { ManagerMessagingSettingsPanel } from "@/components/portal/pro-messaging-settings-panel";
import { ManagerAssistantEmailSettingsPanel } from "@/components/portal/pro-assistant-email-settings-panel";
import { CommunicationSettingsPanel } from "@/components/portal/pro-portal-settings-panels";
import { SettingsModulePage } from "@/components/portal/settings-module-page";
import {
  SettingsPropertyScopeBar,
  SettingsPropertyScopeProvider,
} from "@/components/portal/settings-property-scope";
import { buildManagerPropertyFilterOptions, MANAGER_PORTFOLIO_REFRESH_EVENTS } from "@/lib/manager-portfolio-access";
import { syncPropertyPipelineFromServer } from "@/lib/demo-property-pipeline";
import { isDemoModeActive, resolveManagerScopeUserId } from "@/lib/demo/demo-session";
import { filterPropertyOptionsForActiveWorkspace } from "@/lib/workspaces/selection";
import type { ManagerPortalSettingsTab } from "@/components/portal/pro-portal-settings-modal";
import { PortalTextNotificationsBlock } from "@/components/portal/portal-text-notifications-block";
import { MANAGER_PLAN_PORTAL_HASH } from "@/lib/portals/manager-plan-path";
import { AssistantDisplaySetting } from "@/components/portal/assistant-display-setting";
import { AssistantCustomInstructionsSetting } from "@/components/portal/assistant-custom-instructions-setting";
import { ManagerNotificationRoutingSetting } from "@/components/portal/pro-notification-routing-setting";
import { NotificationsToggle } from "@/components/native/notifications-toggle";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import type { PortalKind } from "@/lib/portal-types";
import { formatProplaneIdForDisplay } from "@/lib/manager-id";
import {
  cacheLandlordLegalName,
  landlordLegalNameFromAccountFullName,
} from "@/lib/manager-landlord-profile";

function dashToEmpty(v: unknown): string {
  return typeof v === "string" && v !== "—" ? v : "";
}

function phoneDashToEmpty(v: unknown): string {
  const phone = coercePhoneInput(v);
  return phone && phone !== "—" ? phone : "";
}

function emptyToDash(v: unknown) {
  const t = typeof v === "string" ? v.trim() : "";
  return t.length ? t : "—";
}

/**
 * Settings categories for the manager layout. The `?tab=` query value is the
 * category id, so `/portal/profile?tab=billing` deep-links to a pane. Category
 * switches use `history.pushState` (which Next syncs into `useSearchParams`)
 * so the browser/gesture back returns from a category to the settings root on
 * phones without a server round trip.
 */
const SETTINGS_TAB_PARAM = "tab";

/** The two fields on this screen a person may write. */
type ProfileField = "fullName" | "phone";

type SettingsGroupId =
  | "workspaces"
  | "profile"
  | "billing"
  | "messaging"
  | "notifications"
  | "preferences"
  | "security"
  | "developer"
  | "feedback"
  | "account"
  | "properties"
  | "applications"
  | "lease"
  | "tours"
  | "resident"
  | "payments"
  | "tasks"
  | "reminders"
  | "bookings"
  | "inspections"
  | "services";

const HUB_MODULE_TABS: Partial<Record<SettingsGroupId, ManagerPortalSettingsTab>> = {
  properties: "properties",
  applications: "applications",
  lease: "lease",
  tours: "tours",
  resident: "resident",
  payments: "payments",
  tasks: "tasks",
  reminders: "automation",
  bookings: "bookings",
  inspections: "inspections",
  services: "services",
};

type SettingsGroup = {
  id: SettingsGroupId;
  label: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
  group: "Account" | "Operations" | "Portfolio";
};

function ManagerMessagingSettingsPane() {
  const [personalPhoneRefreshKey, setPersonalPhoneRefreshKey] = useState(0);
  return (
    <>
      <PortalTextNotificationsBlock
        dataAttrPrefix="manager"
        title="Personal mobile"
        description="Verify your own phone for account alerts and secure messaging setup. This is separate from the workspace work number."
        onVerified={() => setPersonalPhoneRefreshKey((value) => value + 1)}
      />
      <ManagerMessagingSettingsPanel personalPhoneRefreshKey={personalPhoneRefreshKey} />
      <ManagerAssistantEmailSettingsPanel />
      <CommunicationSettingsPanel />
    </>
  );
}

function HubSettingsModulePane({ tab }: { tab: ManagerPortalSettingsTab }) {
  const { userId } = useManagerUserId();
  const workspaces = useWorkspaces();
  const propertyOptions = useMemo(
    () =>
      filterPropertyOptionsForActiveWorkspace(
        buildManagerPropertyFilterOptions(resolveManagerScopeUserId(userId)),
      ),
    [userId, workspaces?.active?.id],
  );
  return <SettingsModulePage tab={tab} propertyOptions={propertyOptions} />;
}

export function PortalProfileClient({
  variant,
  portalKind,
  initialFullName,
  initialEmail,
  initialPhone,
  idLabel,
  idValue,
}: {
  variant: "admin" | "manager";
  portalKind: PortalKind;
  initialFullName: string;
  initialEmail: string;
  initialPhone: string;
  idLabel: string;
  idValue: string;
}) {
  const demo = isDemoModeActive();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const [fullName, setFullName] = useState(dashToEmpty(initialFullName));
  const [phone, setPhone] = useState(phoneDashToEmpty(initialPhone));
  /** Per-field outcome, so a failure is reported on the row it happened to. */
  const [fieldState, setFieldState] = useState<Record<ProfileField, PortalSettingsSaveState>>({
    fullName: "idle",
    phone: "idle",
  });
  const [fieldError, setFieldError] = useState<Partial<Record<ProfileField, string>>>({});
  /** What the server last confirmed. A field differing from this is unsaved. */
  const savedRef = useRef({ fullName: dashToEmpty(initialFullName), phone: phoneDashToEmpty(initialPhone) });
  const savedTimersRef = useRef<Partial<Record<ProfileField, ReturnType<typeof setTimeout>>>>({});
  const inFlightRef = useRef(false);

  // Fresh server props may arrive at any time. They may only overwrite a field
  // the person is not in the middle of changing — an unsaved edit outranks a
  // re-render, or typing a name would be undone by a background refresh.
  useEffect(() => {
    const nextName = dashToEmpty(initialFullName);
    const nextPhone = phoneDashToEmpty(initialPhone);
    if (inFlightRef.current) return;
    setFullName((current) => (current === savedRef.current.fullName ? nextName : current));
    setPhone((current) => (current === savedRef.current.phone ? nextPhone : current));
    savedRef.current = { fullName: nextName, phone: nextPhone };
  }, [initialFullName, initialPhone]);

  useEffect(() => {
    const timers = savedTimersRef.current;
    return () => {
      for (const timer of Object.values(timers)) if (timer) clearTimeout(timer);
    };
  }, []);

  const markSaved = useCallback((field: ProfileField) => {
    setFieldState((prev) => ({ ...prev, [field]: "saved" }));
    const existing = savedTimersRef.current[field];
    if (existing) clearTimeout(existing);
    savedTimersRef.current[field] = setTimeout(() => {
      setFieldState((prev) => (prev[field] === "saved" ? { ...prev, [field]: "idle" } : prev));
    }, 2000);
  }, []);

  /**
   * Write the profile because `field` was just left. Both values go in the one
   * request the API already takes; only the field that changed reports back.
   */
  const commit = useCallback(async (field: ProfileField) => {
    const next = { fullName, phone };
    if (next[field] === savedRef.current[field]) return;
    if (demo) {
      savedRef.current = next;
      markSaved(field);
      return;
    }
    setFieldState((prev) => ({ ...prev, [field]: "saving" }));
    setFieldError((prev) => ({ ...prev, [field]: undefined }));
    inFlightRef.current = true;
    try {
      const res = await fetch("/api/profile", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      const raw = await res.text();
      let body: { error?: string; ok?: boolean } = {};
      try {
        body = raw ? (JSON.parse(raw) as { error?: string; ok?: boolean }) : {};
      } catch {
        setFieldState((prev) => ({ ...prev, [field]: "error" }));
        setFieldError((prev) => ({ ...prev, [field]: "The server sent something unreadable." }));
        return;
      }
      if (!res.ok) {
        setFieldState((prev) => ({ ...prev, [field]: "error" }));
        setFieldError((prev) => ({ ...prev, [field]: body.error ?? "Could not save." }));
        return;
      }
      if (variant === "manager") {
        cacheLandlordLegalName(landlordLegalNameFromAccountFullName(next.fullName));
      }
      savedRef.current = next;
      markSaved(field);
    } catch {
      setFieldState((prev) => ({ ...prev, [field]: "error" }));
      setFieldError((prev) => ({ ...prev, [field]: "No connection. Your change is still here." }));
    } finally {
      inFlightRef.current = false;
    }
  }, [demo, fullName, phone, markSaved, variant]);

  const personalInfoSection = (
    <PortalSettingsSection title="Personal information">
      <PortalSettingsGroup>
        <PortalSettingsAutosaveField
          label="Full name"
          htmlFor="pf-name"
          state={fieldState.fullName}
          error={fieldError.fullName}
          onRetry={() => void commit("fullName")}
        >
          <Input
            id="pf-name"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            onBlur={() => void commit("fullName")}
            autoComplete="name"
            data-attr="settings-full-name"
          />
        </PortalSettingsAutosaveField>
        <PortalSettingsField label="Email" value={initialEmail} />
        <PortalSettingsAutosaveField
          label="Phone"
          htmlFor="pf-phone"
          state={fieldState.phone}
          error={fieldError.phone}
          onRetry={() => void commit("phone")}
        >
          <PhoneNumberField
            id="pf-phone"
            value={phone}
            onChange={setPhone}
            onBlur={() => void commit("phone")}
          />
        </PortalSettingsAutosaveField>
        {/*
          Through the display formatter. Accounts created before the rebrand
          still STORE an `AXIS-` id — every lookup accepts both prefixes and
          renaming the stored value is a migration, not a label change — but
          a field captioned "PropLane ID" must never read AXIS to the person
          whose id it is.
        */}
        <PortalSettingsField label={idLabel} value={formatProplaneIdForDisplay(idValue)} mono />
      </PortalSettingsGroup>
    </PortalSettingsSection>
  );

  const groups = useMemo<SettingsGroup[]>(() => {
    const list: SettingsGroup[] = [
      {
        id: "profile",
        label: "Profile",
        description: `Name, contact details, and ${idLabel}.`,
        icon: UserRound,
        group: "Account",
      },
    ];
    if (!demo && variant === "manager") {
      list.push({ id: "workspaces", label: "Workspaces", description: "Plan limits, your workspaces, and who works in each.", icon: Settings2, group: "Account" });
      list.push({
        id: "billing",
        label: "Billing & plan",
        description: "Subscription and payment details.",
        icon: CreditCard,
        group: "Account",
      });
    }
    if (variant === "manager") {
      list.push({
        id: "notifications",
        label: "Notifications",
        description: "Manager alerts and device notifications.",
        icon: Bell,
        group: "Account",
      });
    }
    list.push(
      {
        id: "preferences",
        label: "Preferences",
        description: "Appearance, assistant, and device options.",
        icon: SlidersHorizontal,
        group: "Account",
      },
      {
        id: "security",
        label: "Login & security",
        description: "Password and sign-in options.",
        icon: Lock,
        group: "Account",
      },
    );
    // Keys authorize against the manager tool layer, so the pane is manager-only.
    // /demo must never mint a real credential.
    if (!demo && variant === "manager") {
      list.push({
        id: "developer",
        label: "API & MCP",
        description: "Connect your own AI agent to PropLane.",
        icon: KeyRound,
        group: "Account",
      });
    }
    list.push(
      {
        id: "feedback",
        label: "Feedback",
        description: "Report issues or share product feedback.",
        icon: MessageSquareText,
        group: "Account",
      },
      {
        id: "account",
        label: "Account",
        description: "Switch portals, sign out, or delete your account.",
        icon: Settings2,
        group: "Account",
      },
    );
    if (variant === "manager") {
      list.push(
        { id: "properties", label: "Properties", description: "Houses in this workspace.", icon: Building2, group: "Portfolio" },
        { id: "applications", label: "Applications", description: "Application handling for this workspace.", icon: FileText, group: "Portfolio" },
        { id: "lease", label: "Leases", description: "Lease automation for this workspace.", icon: ScrollText, group: "Portfolio" },
        { id: "tours", label: "Tours", description: "Tour notice and reminders.", icon: Calendar, group: "Portfolio" },
        { id: "resident", label: "Residents", description: "Resident settings for this workspace.", icon: Home, group: "Portfolio" },
      );
    }
    if (!demo && variant === "manager") {
      list.push(
        {
          id: "messaging",
          label: "Communication",
          description: "Personal mobile, your work number for texts and calls, and what reaches you after a call.",
          icon: MessagesSquare,
          group: "Operations",
        },
      );
    }
    if (variant === "manager") {
      list.push(
        { id: "payments", label: "Payments", description: "Rent reminders and payment rules.", icon: Wallet, group: "Operations" },
        { id: "tasks", label: "Tasks", description: "Task automation.", icon: CheckSquare, group: "Operations" },
        { id: "reminders", label: "Reminders", description: "Reminder matrix and quiet hours.", icon: BellRing, group: "Operations" },
        { id: "bookings", label: "Bookings", description: "Booking rules.", icon: CalendarDays, group: "Operations" },
        { id: "inspections", label: "Inspections", description: "Inspection rules.", icon: ClipboardCheck, group: "Operations" },
        { id: "services", label: "Services", description: "Service rules.", icon: Wrench, group: "Operations" },
      );
    }
    return list;
  }, [demo, idLabel, variant]);

  // Legacy upgrade CTAs across the product still link to
  // `/portal/profile#portal-plan`, and Stripe returns to
  // `/portal/profile?checkout=…&session_id=…`. Both need the billing pane
  // mounted so ManagerPlan's own hash-scroll and checkout-confirm effects run.
  // ManagerPlan clears those params itself (`replaceState` to the bare
  // pathname), so this override is sticky until the manager navigates.
  const [billingOverride, setBillingOverride] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const q = new URLSearchParams(window.location.search);
    if (window.location.hash === MANAGER_PLAN_PORTAL_HASH || q.has("checkout")) {
      setBillingOverride(true);
    }
  }, []);

  const rawTab = searchParams.get(SETTINGS_TAB_PARAM);
  useEffect(() => {
    if (rawTab === "vendors") router.replace("/portal/vendors");
    if (rawTab === "team") router.replace("/portal/profile?tab=workspaces");
    if (rawTab === "communication") router.replace("/portal/profile?tab=messaging");
    if (rawTab === "automation") router.replace("/portal/profile?tab=reminders");
    if (rawTab === "leases") router.replace("/portal/profile?tab=lease");
    if (rawTab === "residents") router.replace("/portal/profile?tab=resident");
  }, [rawTab, router]);
  const billingGroup = groups.find((g) => g.id === "billing") ?? null;
  const activeGroup =
    groups.find((g) => g.id === rawTab) ?? (billingOverride ? billingGroup : null) ?? null;
  // Desktop always shows a pane; with no tab selected it defaults to Profile.
  const paneGroup = activeGroup ?? groups[0];

  // Depth of history entries this component pushed, so the in-page back
  // chevron unwinds the stack (matching the iOS back gesture) instead of
  // appending a "forward"-feeling entry.
  const pushedDepthRef = useRef(0);
  const backInFlightRef = useRef(false);
  useEffect(() => {
    const onPop = () => {
      if (backInFlightRef.current) {
        backInFlightRef.current = false;
      } else {
        pushedDepthRef.current = Math.max(0, pushedDepthRef.current - 1);
      }
      setBillingOverride(false);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const urlForTab = useCallback(
    (id: string | null) => {
      const params = new URLSearchParams(searchParams.toString());
      if (id) params.set(SETTINGS_TAB_PARAM, id);
      else params.delete(SETTINGS_TAB_PARAM);
      const query = params.toString();
      return query ? `${pathname}?${query}` : pathname;
    },
    [pathname, searchParams],
  );

  // The property scope for Operations settings rides in the URL beside `?tab=`
  // so a reload and the browser back button keep the chosen house. pushState is
  // the same history mechanism `openGroup` uses (Next syncs it into
  // useSearchParams). "" is the workspace default ("All properties").
  const { userId: managerUserId, ready: managerReady } = useManagerUserId();
  const workspaces = useWorkspaces();
  const scopeProperty = searchParams.get("property") ?? "";
  // The picker options come from the client property store, which hydrates
  // asynchronously from /api/property-records; recompute when the pipeline syncs
  // (the same tick pattern pro-bookings uses) or the options are empty on load.
  const [propertyTick, setPropertyTick] = useState(0);
  useEffect(() => {
    if (!managerReady || !managerUserId || variant !== "manager") return;
    void syncPropertyPipelineFromServer().then(() => setPropertyTick((n) => n + 1));
  }, [managerReady, managerUserId, variant]);
  useEffect(() => {
    if (variant !== "manager") return;
    const bump = () => setPropertyTick((n) => n + 1);
    for (const eventName of MANAGER_PORTFOLIO_REFRESH_EVENTS) window.addEventListener(eventName, bump);
    return () => {
      for (const eventName of MANAGER_PORTFOLIO_REFRESH_EVENTS) window.removeEventListener(eventName, bump);
    };
  }, [variant]);
  const scopeOptions = useMemo(
    () =>
      filterPropertyOptionsForActiveWorkspace(
        buildManagerPropertyFilterOptions(resolveManagerScopeUserId(managerUserId)),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [managerUserId, workspaces?.active?.id, propertyTick],
  );
  const setScopeProperty = useCallback(
    (id: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (id) params.set("property", id);
      else params.delete("property");
      const query = params.toString();
      window.history.pushState(null, "", query ? `${pathname}?${query}` : pathname);
    },
    [pathname, searchParams],
  );

  const openGroup = useCallback(
    (id: string) => {
      setBillingOverride(false);
      pushedDepthRef.current += 1;
      window.history.pushState(null, "", urlForTab(id));
    },
    [urlForTab],
  );
  const backToRoot = useCallback(() => {
    if (backInFlightRef.current) return;
    setBillingOverride(false);
    if (pushedDepthRef.current > 0) {
      pushedDepthRef.current -= 1;
      backInFlightRef.current = true;
      window.history.back();
      return;
    }
    window.history.pushState(null, "", urlForTab(null));
  }, [urlForTab]);

  // Reset scroll when the pane changes. On desktop the content column is its own
  // scroll container (independent of the rail), so resetting its `scrollTop` is
  // what lands a switched pane at the top; on mobile the whole shell scrolls, so
  // scrollIntoView on the layout top still applies there.
  const layoutTopRef = useRef<HTMLDivElement>(null);
  const contentColRef = useRef<HTMLDivElement>(null);
  const skipInitialScroll = useRef(true);
  useEffect(() => {
    if (skipInitialScroll.current) {
      skipInitialScroll.current = false;
      return;
    }
    contentColRef.current?.scrollTo({ top: 0, behavior: "auto" });
    layoutTopRef.current?.scrollIntoView({ block: "start", behavior: "auto" });
  }, [activeGroup?.id]);

  const renderPane = (id: SettingsGroupId): ReactNode => {
    const moduleTab = HUB_MODULE_TABS[id];
    if (moduleTab) return <HubSettingsModulePane tab={moduleTab} />;
    switch (id) {
      case "workspaces":
        return <WorkspaceSettings openNew={searchParams?.get("new") === "1"} />;
      case "profile":
        return personalInfoSection;
      case "billing":
        // Billing is a complete operational surface. It owns its current-plan
        // state and comparison cards, so Settings deliberately provides no
        // duplicate heading or card around it.
        return (
          <div className="min-w-0 space-y-8">
            <ManagerPlan embedded showCurrentPlan={false} />
            <ManagerPlanAddonsPanel />
            <ManagerPaymentMethodsPanel />
            <ManagerCommsBillingPanel />
          </div>
        );
      case "messaging":
        return <ManagerMessagingSettingsPane />;
      case "preferences":
        return (
          <>
            <PortalSettingsSection title="Appearance">
              <PortalSettingsGroup>
                <PortalSettingsRow label="Theme">
                  <ThemeToggle className="shrink-0" />
                </PortalSettingsRow>
              </PortalSettingsGroup>
            </PortalSettingsSection>
            <AssistantDisplaySetting />
            <AssistantCustomInstructionsSetting role={variant} />
          </>
        );
      case "notifications":
        return (
          <>
            <ManagerNotificationRoutingSetting />
            <NotificationsToggle />
          </>
        );
      case "security":
        return <PortalChangePasswordPanel accountEmail={dashToEmpty(initialEmail) || initialEmail} />;
      case "developer":
        return <ManagerApiKeysPanel />;
      case "feedback":
        return (
          <PortalBugFeedbackPanel
            reporterRole={variant === "admin" ? "admin" : portalKind === "pro" ? "pro" : "manager"}
            embedded
          />
        );
      case "account":
        return <PortalSettingsExtras currentKind={portalKind} variant="session" />;
    }
  };

  /*
    One Settings shape for every portal.

    Admin used to keep a legacy single scroll — every section stacked, nothing
    grouped, no way to jump — while the manager had the grouped rail. There was
    no reason for the difference beyond the order the two were written, so admin
    now takes the same rail with the groups it actually has: no billing, no work
    number, no API keys.
  */
  return (
    <ManagerPortalPageShell
      title="Settings"
      // Billing has its own compact plan status + pricing hierarchy. Keeping
      // the generic Settings header above it wastes the first viewport and
      // competes with the financial decision the manager came to make.
      navigationProvidesTitle={paneGroup.id === "billing"}
      // The mobile/native app bar already reads "Settings" — same as every
      // other manager section, drop the duplicate in-page title on phones.
      hideTitleOnMobileNav
    >
      <div ref={layoutTopRef} className="lg:flex lg:h-full lg:min-h-0 lg:flex-1 lg:gap-10">
        <PortalSettingsNav
          className="max-lg:hidden"
          name={emptyToDash(fullName)}
          email={initialEmail}
          items={groups.map((g) => ({
            id: g.id,
            label: g.label,
            icon: <g.icon className="h-4 w-4" />,
            group: g.group,
          }))}
          activeId={paneGroup.id}
          onSelect={openGroup}
        />
        <div
          ref={contentColRef}
          className="min-w-0 flex-1 lg:min-h-0 lg:max-w-3xl lg:overflow-y-auto lg:overscroll-contain"
        >
          {activeGroup === null ? (
            <div className="space-y-5 lg:hidden">
              <PortalSettingsProfileHeader name={emptyToDash(fullName)} email={initialEmail} />
              {(["Account", "Portfolio", "Operations"] as const).map((group) => {
                const groupItems = groups.filter((item) => item.group === group);
                if (groupItems.length === 0) return null;
                return (
                  <section key={group} className="space-y-2">
                    <h2 className="px-1 text-[11px] font-bold uppercase tracking-[0.12em] text-muted">{group}</h2>
                    <PortalSettingsGroup>
                      {groupItems.map((g) => (
                        <PortalSettingsLinkRow
                          key={g.id}
                          icon={<g.icon className="h-4 w-4" />}
                          label={g.label}
                          onClick={() => openGroup(g.id)}
                          dataAttr={`settings-open-${g.id}`}
                        />
                      ))}
                    </PortalSettingsGroup>
                  </section>
                );
              })}
            </div>
          ) : (
            <div className="mb-4 lg:hidden">
              <PortalDetailHeader
                title={activeGroup.label}
                onBack={backToRoot}
                backLabel="Settings"
                bare
                dataAttrBack="settings-back-to-root"
              />
            </div>
          )}
          {paneGroup.group === "Operations" ? (
            <SettingsPropertyScopeProvider
              propertyId={scopeProperty}
              onPropertyIdChange={setScopeProperty}
              options={scopeOptions}
            >
              <SettingsPropertyScopeBar />
              <PortalSettingsSections className={activeGroup === null ? "max-lg:hidden" : undefined}>
                {renderPane(paneGroup.id)}
              </PortalSettingsSections>
            </SettingsPropertyScopeProvider>
          ) : (
            <PortalSettingsSections className={activeGroup === null ? "max-lg:hidden" : undefined}>
              {renderPane(paneGroup.id)}
            </PortalSettingsSections>
          )}
        </div>
      </div>
    </ManagerPortalPageShell>
  );
}
