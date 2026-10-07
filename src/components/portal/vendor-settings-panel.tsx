"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import { ListSkeleton } from "@/components/ui/list-skeleton";
import { invalidateSharedGets, sharedGet, writeThroughFetch } from "@/lib/shared-get-cache";
import { PHONE_VERIFIED_EVENT } from "@/lib/vendor-work-number";
import { usePathname, useSearchParams } from "next/navigation";
import {
  Building2,
  CalendarDays,
  CalendarSync,
  ChevronLeft,
  FileText,
  Landmark,
  Lock,
  Mail,
  MessageSquareText,
  Phone,
  Settings,
  ShieldCheck,
  UserRound,
  Wrench,
  Zap,
} from "lucide-react";
import {
  useVendorBusinessProfile,
  SectionSaveBadge,
  VendorBusinessProfilePane,
  VendorLicensesInsurancePane,
  VendorNotificationsPane,
  VendorTradesServiceAreaPane,
  VendorWorkIdentitySection,
  worstSaveState,
} from "@/components/portal/vendor-business-settings";
import { VendorQuickRepliesSettings } from "@/components/portal/vendor-quick-replies-settings";
import { VendorInvoicingSettings } from "@/components/portal/vendor-invoicing-settings";
import {
  VENDOR_SETTINGS_RAIL,
  resolveVendorSettingsTab,
  type VendorSettingsPageId,
  type VendorSettingsRailGroup,
} from "@/lib/portals/vendor-settings-pages";
import { cn } from "@/lib/utils";
import { Input, Select } from "@/components/ui/input";
import {
  PortalSettingsAutosaveField,
  PortalSettingsField,
  PortalSettingsFormBody,
  PortalSettingsGroup,
  PortalSettingsLinkRow,
  PortalSettingsProfileHeader,
  PortalSettingsSection,
  PortalSettingsSections,
  PortalSettingsTitleStyleContext,
  type PortalSettingsSaveState,
} from "@/components/portal/portal-settings-ui";
import { PortalChangePasswordPanel } from "@/components/portal/portal-change-password-panel";
import { PortalPayoutsSettingsPage } from "@/components/portal/portal-payouts-settings-page";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { PortalBugFeedbackPanel } from "@/components/portal/portal-bug-feedback-panel";
import { PortalSettingsExtras } from "@/components/portal/portal-settings-extras";
import { PortalSignOutButton } from "@/components/portal/portal-sign-out-button";
import { PortalTextNotificationsBlock } from "@/components/portal/portal-text-notifications-block";
import { AssistantCustomInstructionsSetting } from "@/components/portal/assistant-custom-instructions-setting";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { DEMO_VENDOR_EMAIL, DEMO_VENDOR_NAME, isDemoModeActive } from "@/lib/demo/demo-session";
import { VENDOR_TRADE_OPTIONS } from "@/lib/work-order-taxonomy";
import { VendorAvailabilityEditor } from "@/components/portal/vendor-availability-editor";
import { VendorIntegrationsSettings } from "@/components/portal/vendor-integrations-settings";
import { VendorWorkNumberSettings } from "@/components/portal/vendor-work-number-settings";

const SETTINGS_TAB_PARAM = "tab";

type VendorSettingsGroupId = VendorSettingsPageId;

type VendorSettingsGroup = {
  id: VendorSettingsGroupId;
  label: string;
  icon: ComponentType<{ className?: string }>;
  group: VendorSettingsRailGroup["label"];
};

const VENDOR_SETTINGS_PAGE_ICONS: Record<VendorSettingsPageId, ComponentType<{ className?: string }>> = {
  profile: UserRound,
  security: Lock,
  preferences: Settings,
  feedback: Mail,
  account: Settings,
  business: Building2,
  capabilities: Wrench,
  licenses: ShieldCheck,
  availability: CalendarDays,
  integrations: CalendarSync,
  payouts: Landmark,
  invoicing: FileText,
  messaging: Phone,
  "quick-replies": Zap,
  "work-number-email": MessageSquareText,
};

type VendorProfileDraft = {
  name: string;
  phone: string;
  email: string;
  preferredLanguage: string;
  smsConsent: boolean;
};

const EMPTY_PROFILE: VendorProfileDraft = {
  name: "",
  phone: "",
  email: "",
  preferredLanguage: "",
  smsConsent: false,
};

type VendorProfileApiRow = {
  name?: string;
  phone?: string;
  email?: string;
  trades?: string[];
  trade?: string;
  preferredLanguage?: string;
};

const DEMO_VENDOR_PROFILE: VendorProfileDraft = {
  name: DEMO_VENDOR_NAME,
  phone: "(206) 555-0142",
  email: DEMO_VENDOR_EMAIL,
  preferredLanguage: "en",
  smsConsent: true,
};
const DEMO_VENDOR_TRADES = ["HVAC", "Appliance repair"];

type DirectoryField = "name" | "phone" | "email" | "preferredLanguage";
const DIRECTORY_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/;
type DirectoryTimerKey = DirectoryField | "smsConsent" | "capabilities";

/** Vendor's own Settings — business profile, work capabilities (feeds auto-match), availability, and feedback. */
export function VendorSettingsPanel() {
  const demo = isDemoModeActive();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [profileDraft, setProfileDraft] = useState<VendorProfileDraft>(() => (demo ? DEMO_VENDOR_PROFILE : EMPTY_PROFILE));
  const [trades, setTrades] = useState<string[]>(() => (demo ? DEMO_VENDOR_TRADES : []));
  const [profileLoading, setProfileLoading] = useState(() => !demo);
  const [unlinked, setUnlinked] = useState(false);

  // The actual Supabase auth login email — distinct from the directory/contact
  // email above, which a vendor can edit and which may differ from what they
  // sign in with (studio VD69 "Signed in as").
  const [signedInEmail, setSignedInEmail] = useState<string | null>(demo ? DEMO_VENDOR_EMAIL : null);
  useEffect(() => {
    if (demo) return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await createSupabaseBrowserClient().auth.getUser();
        if (!cancelled) setSignedInEmail(result.data.user?.email ?? null);
      } catch {
        /* ignore — the row just shows an em dash */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [demo]);

  // Every Directory listing / Work capabilities field autosaves — no Save
  // button anywhere in this pane (captain, 2026-09-27 studio VD02/VD03/VD09).
  const [directoryFieldState, setDirectoryFieldState] = useState<Record<DirectoryField, PortalSettingsSaveState>>({
    name: "idle",
    phone: "idle",
    email: "idle",
    preferredLanguage: "idle",
  });
  const [directoryFieldError, setDirectoryFieldError] = useState<Partial<Record<DirectoryField, string>>>({});
  const [smsConsentState, setSmsConsentState] = useState<PortalSettingsSaveState>("idle");
  const [capabilitiesState, setCapabilitiesState] = useState<PortalSettingsSaveState>("idle");
  const savedProfileRef = useRef<VendorProfileDraft>(profileDraft);
  const directoryTimers = useRef<Partial<Record<DirectoryTimerKey, ReturnType<typeof setTimeout>>>>({});
  useEffect(() => {
    const held = directoryTimers.current;
    return () => {
      for (const timer of Object.values(held)) if (timer) clearTimeout(timer as ReturnType<typeof setTimeout>);
    };
  }, []);
  const scheduleIdle = useCallback((key: DirectoryTimerKey, revert: () => void) => {
    const existing = directoryTimers.current[key];
    if (existing) clearTimeout(existing);
    directoryTimers.current[key] = setTimeout(revert, 2000);
  }, []);

  // Verifying the phone (the Messaging block) changes `contact.phoneVerifiedAt`: drop the shared
  // read so the next reader (the portal banner, this pane) asks the server.
  useEffect(() => {
    if (demo) return;
    const onVerified = () => invalidateSharedGets("/api/vendor/profile");
    window.addEventListener(PHONE_VERIFIED_EVENT, onVerified);
    return () => window.removeEventListener(PHONE_VERIFIED_EVENT, onVerified);
  }, [demo]);

  useEffect(() => {
    if (demo) return;
    void sharedGet("/api/vendor/profile")
      .then(
        (r) =>
          (r.ok ? r.data ?? {} : {}) as {
            profile?: VendorProfileApiRow | null;
            linked?: boolean;
            contact?: { phone?: string; preferredLanguage?: string; smsConsent?: boolean };
          },
      )
      .then(
        (data) => {
          setUnlinked(data.linked === false);
          const p = data.profile;
          const contact = data.contact;
          const next: VendorProfileDraft = {
            name: p?.name ?? "",
            phone: p?.phone ?? "",
            email: p?.email ?? "",
            preferredLanguage: contact?.preferredLanguage || p?.preferredLanguage || "",
            smsConsent: contact?.smsConsent ?? false,
          };
          setProfileDraft(next);
          savedProfileRef.current = next;
          if (p) setTrades(p.trades && p.trades.length > 0 ? p.trades : p.trade ? [p.trade] : []);
        },
      )
      .finally(() => setProfileLoading(false));
  }, [demo]);

  /**
   * One field, saved on blur (text) or immediately (select/checkbox). A
   * failed save keeps whatever was typed and shows why underneath it; an
   * invalid email is caught before it ever reaches the server and is never
   * saved, though the server also rejects a malformed email defensively
   * (`/api/vendor/profile` PATCH) since a client check is never authority.
   */
  async function commitDirectoryField(field: DirectoryField, value: string) {
    // Clear error before any early return, so restoring the original value
    // clears the error even if no save request is sent.
    const isValid = !value || field !== "email" || DIRECTORY_EMAIL_RE.test(value);
    if (!isValid) {
      setDirectoryFieldState((s) => ({ ...s, email: "error" }));
      setDirectoryFieldError((e) => ({ ...e, email: "Enter a valid email address." }));
      return;
    }
    // Clear error for valid fields before early return.
    setDirectoryFieldError((e) => ({ ...e, [field]: undefined }));
    if (value === savedProfileRef.current[field]) return;
    setDirectoryFieldState((s) => ({ ...s, [field]: "saving" }));
    const markSaved = () => {
      savedProfileRef.current = { ...savedProfileRef.current, [field]: value };
      setDirectoryFieldState((s) => ({ ...s, [field]: "saved" }));
      scheduleIdle(field, () => setDirectoryFieldState((s) => (s[field] === "saved" ? { ...s, [field]: "idle" } : s)));
    };
    if (demo) {
      markSaved();
      return;
    }
    try {
      const res = await writeThroughFetch("/api/vendor/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ [field]: value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setDirectoryFieldState((s) => ({ ...s, [field]: "error" }));
        setDirectoryFieldError((e) => ({ ...e, [field]: data.error ?? "Could not save." }));
        return;
      }
      markSaved();
    } catch {
      setDirectoryFieldState((s) => ({ ...s, [field]: "error" }));
      setDirectoryFieldError((e) => ({ ...e, [field]: "No connection. Your change is still here." }));
    }
  }

  async function commitSmsConsent(checked: boolean) {
    setProfileDraft((d) => ({ ...d, smsConsent: checked }));
    setSmsConsentState("saving");
    const markSaved = () => {
      savedProfileRef.current = { ...savedProfileRef.current, smsConsent: checked };
      setSmsConsentState("saved");
      scheduleIdle("smsConsent", () => setSmsConsentState((s) => (s === "saved" ? "idle" : s)));
    };
    if (demo) {
      markSaved();
      return;
    }
    try {
      const res = await writeThroughFetch("/api/vendor/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ smsConsent: checked }),
      });
      if (!res.ok) {
        setSmsConsentState("error");
        return;
      }
      markSaved();
    } catch {
      setSmsConsentState("error");
    }
  }

  const directorySectionState = worstSaveState([
    directoryFieldState.name,
    directoryFieldState.phone,
    directoryFieldState.email,
    directoryFieldState.preferredLanguage,
    smsConsentState,
  ]);

  async function commitTrades(next: string[]) {
    setTrades(next);
    setCapabilitiesState("saving");
    const markSaved = () => {
      setCapabilitiesState("saved");
      scheduleIdle("capabilities", () => setCapabilitiesState((s) => (s === "saved" ? "idle" : s)));
    };
    if (demo) {
      markSaved();
      return;
    }
    try {
      const res = await writeThroughFetch("/api/vendor/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ trades: next }),
      });
      if (!res.ok) {
        setCapabilitiesState("error");
        return;
      }
      markSaved();
    } catch {
      setCapabilitiesState("error");
    }
  }

  // Both writable panes are dead until a manager links the account, so the
  // banner rides with them rather than sitting once at the top of a scroll the
  // vendor may never reach.
  const business = useVendorBusinessProfile(!demo);

  const unlinkedBanner = unlinked ? (
    <p
      className="rounded-lg border px-4 py-3 text-sm portal-banner-pending"
      data-attr="vendor-settings-unlinked-banner"
    >
      Waiting on a property manager to connect with you. You&apos;ll be able to save your profile once linked.
    </p>
  ) : null;

  const groups = useMemo<VendorSettingsGroup[]>(
    () =>
      VENDOR_SETTINGS_RAIL.flatMap((railGroup) =>
        railGroup.pages.map((page) => ({
          id: page.id,
          label: page.label,
          icon: VENDOR_SETTINGS_PAGE_ICONS[page.id],
          group: railGroup.label,
        })),
      ),
    [],
  );

  const rawTab = searchParams.get(SETTINGS_TAB_PARAM);
  const normalizedTab = resolveVendorSettingsTab(rawTab);
  const activeGroup = groups.find((g) => g.id === normalizedTab) ?? null;
  const paneGroup = activeGroup ?? groups[0];

  const pushedDepthRef = useRef(0);
  const backInFlightRef = useRef(false);
  useEffect(() => {
    const onPop = () => {
      if (backInFlightRef.current) {
        backInFlightRef.current = false;
      } else {
        pushedDepthRef.current = Math.max(0, pushedDepthRef.current - 1);
      }
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

  const openGroup = useCallback(
    (id: string) => {
      pushedDepthRef.current += 1;
      window.history.pushState(null, "", urlForTab(id));
    },
    [urlForTab],
  );

  const backToRoot = useCallback(() => {
    if (backInFlightRef.current) return;
    if (pushedDepthRef.current > 0) {
      pushedDepthRef.current -= 1;
      backInFlightRef.current = true;
      window.history.back();
      return;
    }
    window.history.pushState(null, "", urlForTab(null));
  }, [urlForTab]);

  const layoutTopRef = useRef<HTMLDivElement>(null);
  const contentColRef = useRef<HTMLDivElement>(null);
  const skipInitialScroll = useRef(true);
  useEffect(() => {
    if (skipInitialScroll.current) {
      skipInitialScroll.current = false;
      return;
    }
    // Desktop: the content column is its own scroll container; mobile: the shell scrolls.
    contentColRef.current?.scrollTo?.({ top: 0, behavior: "auto" });
    layoutTopRef.current?.scrollIntoView({ block: "start", behavior: "auto" });
  }, [activeGroup?.id]);

  const renderPane = (id: VendorSettingsGroupId): ReactNode => {
    switch (id) {
      case "business":
        // Business details: who you are (name, contact) plus the work phone/email and PropLane work email.
        return (
          <>
            <VendorBusinessProfilePane ctx={business} />
            <VendorWorkIdentitySection ctx={business} />
          </>
        );
      case "licenses":
        return <VendorLicensesInsurancePane ctx={business} />;
      case "invoicing":
        return <VendorInvoicingSettings />;
      case "quick-replies":
        return <VendorQuickRepliesSettings />;
      case "payouts":
        return <PortalPayoutsSettingsPage portal="vendor" />;
      case "profile":
        return (
          <>
            {unlinkedBanner}
            <PortalSettingsSection title="Profile" action={<SectionSaveBadge state={directorySectionState} />}>
              <PortalSettingsGroup>
                {profileLoading ? (
                  <div className="px-4 py-4">
                    <ListSkeleton rows={2} showLeading={false} />
                  </div>
                ) : (
                  <PortalSettingsFormBody className="space-y-0 divide-y divide-border/70 px-0 py-0">
                    <PortalSettingsAutosaveField
                      label="Business name"
                      htmlFor="vendor-settings-name"
                      state={directoryFieldState.name}
                      error={directoryFieldError.name}
                      onRetry={() => void commitDirectoryField("name", profileDraft.name)}
                    >
                      <Input
                        id="vendor-settings-name"
                        value={profileDraft.name}
                        onChange={(e) => setProfileDraft({ ...profileDraft, name: e.target.value })}
                        onBlur={() => void commitDirectoryField("name", profileDraft.name)}
                        data-attr="vendor-settings-name"
                      />
                    </PortalSettingsAutosaveField>
                    <PortalSettingsAutosaveField
                      label="Phone"
                      htmlFor="vendor-settings-phone"
                      state={directoryFieldState.phone}
                      error={directoryFieldError.phone}
                      onRetry={() => void commitDirectoryField("phone", profileDraft.phone)}
                    >
                      <Input
                        id="vendor-settings-phone"
                        value={profileDraft.phone}
                        onChange={(e) => setProfileDraft({ ...profileDraft, phone: e.target.value })}
                        onBlur={() => void commitDirectoryField("phone", profileDraft.phone)}
                        data-attr="vendor-settings-phone"
                      />
                    </PortalSettingsAutosaveField>
                    <PortalSettingsAutosaveField
                      label="Email"
                      htmlFor="vendor-settings-email"
                      state={directoryFieldState.email}
                      error={directoryFieldError.email}
                      onRetry={() => void commitDirectoryField("email", profileDraft.email)}
                    >
                      <Input
                        id="vendor-settings-email"
                        type="email"
                        value={profileDraft.email}
                        onChange={(e) => setProfileDraft({ ...profileDraft, email: e.target.value })}
                        onBlur={() => void commitDirectoryField("email", profileDraft.email)}
                        data-attr="vendor-settings-email"
                      />
                    </PortalSettingsAutosaveField>
                    <PortalSettingsAutosaveField
                      label="Preferred language / Idioma"
                      htmlFor="vendor-language-select"
                      state={directoryFieldState.preferredLanguage}
                      error={directoryFieldError.preferredLanguage}
                      onRetry={() => void commitDirectoryField("preferredLanguage", profileDraft.preferredLanguage)}
                    >
                      <Select
                        id="vendor-language-select"
                        value={profileDraft.preferredLanguage}
                        onChange={(e) => {
                          setProfileDraft({ ...profileDraft, preferredLanguage: e.target.value });
                          void commitDirectoryField("preferredLanguage", e.target.value);
                        }}
                        data-attr="vendor-language-select"
                      >
                        <option value="">Select…</option>
                        <option value="en">English</option>
                        <option value="es">Español</option>
                      </Select>
                    </PortalSettingsAutosaveField>
                    <div className="px-4 py-3.5">
                      <label className="flex items-start gap-2 text-xs font-medium text-muted">
                        <input
                          type="checkbox"
                          className="mt-0.5 h-4 w-4 shrink-0 rounded border-border"
                          checked={profileDraft.smsConsent}
                          onChange={(e) => void commitSmsConsent(e.target.checked)}
                          data-attr="vendor-sms-consent"
                        />
                        <span>
                          Text me about jobs at this number. Message and data rates may apply; reply STOP to opt out.
                        </span>
                      </label>
                    </div>
                  </PortalSettingsFormBody>
                )}
              </PortalSettingsGroup>
            </PortalSettingsSection>
          </>
        );
      case "capabilities":
        return (
          <>
            {unlinkedBanner}
            <VendorTradesServiceAreaPane
              ctx={business}
              trades={trades}
              tradeOptions={VENDOR_TRADE_OPTIONS}
              onTradesChange={(next) => void commitTrades(next)}
              tradesState={capabilitiesState}
              loading={profileLoading}
            />
          </>
        );
      case "availability":
        // Weekly hours, one-off open dates and blocked dates are one decision a
        // vendor makes in one sitting, so they share a pane. This renders the
        // one canonical `VendorAvailabilityEditor` (vendor-availability-editor.tsx)
        // inline (`dialog={false}`) — the same component the vendor Calendar
        // page's "Set availability" dialog uses (`dialog`), so both surfaces
        // share fields, saves, and the VENDOR_AVAILABILITY_CHANGED_EVENT /
        // VENDOR_AVAILABILITY_EDIT_REQUEST_EVENT contract. A second,
        // settings-local editor used to live in this file; it has been removed.
        return <VendorAvailabilityEditor dialog={false} />;
      case "integrations":
        return <VendorIntegrationsSettings />;
      case "work-number-email":
        return <VendorWorkNumberSettings />;
      case "messaging":
        // Phone & notifications: verify the phone job texts come to, then what reaches the inbox and phone.
        return (
          <>
            <PortalTextNotificationsBlock dataAttrPrefix="vendor" demo={demo} title="Verify your phone" />
            <VendorNotificationsPane ctx={business} />
          </>
        );
      case "preferences":
        // A landing-page / default-view picker was scoped out (studio VD69):
        // no such preference is persisted anywhere in the app today for any
        // portal, and this pane only wires settings that already have real
        // storage. Assistant instructions remain the one real preference here.
        return <AssistantCustomInstructionsSetting role="vendor" />;
      case "security":
        return (
          <>
            {/* Inline, matching the exact convention manager and resident Settings
                already use for this same panel — a modal here would be the one-off
                inconsistency, not the established pattern (studio VD69). */}
            <PortalChangePasswordPanel accountEmail={profileDraft.email} />
            <PortalSettingsSection title="Sign out">
              <PortalSettingsGroup>
                <div className="px-4 py-3.5">
                  <PortalSignOutButton dataAttr="vendor-settings-security-sign-out" />
                </div>
              </PortalSettingsGroup>
            </PortalSettingsSection>
          </>
        );
      case "feedback":
        return <PortalBugFeedbackPanel reporterRole="vendor" embedded />;
      case "account":
        return (
          <>
            <PortalSettingsSection title="Account">
              <PortalSettingsGroup>
                <PortalSettingsField label="Signed in as" value={signedInEmail ?? "—"} />
              </PortalSettingsGroup>
            </PortalSettingsSection>
            <PortalSettingsExtras currentKind="vendor" variant="session" />
          </>
        );
    }
  };

  // Manager-settings layout (approved plan vendor-portal-redesign-1006): on desktop a
  // rail of uppercase-labelled groups on the left and the page on the right; on a
  // phone the same groups as link-row cards, each page opening with a back arrow.
  const groupLabelClass = "px-3 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-wider text-muted";
  const navButton = (g: VendorSettingsGroup) => (
    <button
      key={g.id}
      type="button"
      onClick={() => openGroup(g.id)}
      aria-current={g.id === paneGroup.id ? "page" : undefined}
      data-attr={`settings-nav-${g.id}`}
      className={cn(
        "flex min-h-9 w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm",
        g.id === paneGroup.id ? "bg-primary/10 text-primary" : "text-muted hover:bg-accent/40",
      )}
    >
      <g.icon className="h-4 w-4" />
      <span className="flex-1">{g.label}</span>
    </button>
  );
  const homeVisible = activeGroup === null;

  return (
    <ManagerPortalPageShell title="Settings" hideTitleOnMobileNav>
      <div ref={layoutTopRef} data-attr="settings-layout" className="lg:flex lg:h-full lg:min-h-0 lg:flex-1 lg:gap-10">
        <nav aria-label="Settings sections" className="hidden w-[216px] shrink-0 space-y-1 lg:block">
          {VENDOR_SETTINGS_RAIL.map((railGroup, index) => (
            <div key={railGroup.label}>
              <p
                className={cn(groupLabelClass, index === 0 && "pt-0")}
                data-attr={`settings-group-${railGroup.label.toLowerCase()}`}
              >
                {railGroup.label}
              </p>
              {groups.filter((g) => g.group === railGroup.label).map(navButton)}
            </div>
          ))}
        </nav>
        <div
          ref={contentColRef}
          className="min-w-0 flex-1 lg:min-h-0 lg:max-w-[720px] lg:overflow-y-auto lg:overscroll-contain"
        >
          {homeVisible ? (
            <div className="space-y-6 lg:hidden" data-attr="settings-home">
              <PortalSettingsProfileHeader
                name={profileDraft.name || DEMO_VENDOR_NAME}
                email={profileDraft.email || DEMO_VENDOR_EMAIL}
              />
              {VENDOR_SETTINGS_RAIL.map((railGroup) => (
                <div key={railGroup.label} className="space-y-2">
                  <p className={cn(groupLabelClass, "pt-0")}>{railGroup.label}</p>
                  <PortalSettingsGroup>
                    {groups
                      .filter((g) => g.group === railGroup.label)
                      .map((g) => (
                        <PortalSettingsLinkRow
                          key={g.id}
                          icon={<g.icon className="h-4 w-4" />}
                          label={g.label}
                          onClick={() => openGroup(g.id)}
                          dataAttr={`settings-open-${g.id}`}
                        />
                      ))}
                  </PortalSettingsGroup>
                </div>
              ))}
            </div>
          ) : (
            <div className="sticky top-0 z-20 mb-4 flex h-[52px] items-center justify-center bg-background/95 backdrop-blur lg:hidden">
              <button
                type="button"
                onClick={backToRoot}
                aria-label="Back"
                data-attr="settings-back-to-root"
                className="absolute left-0 grid h-11 w-11 place-items-center"
              >
                <ChevronLeft className="h-6 w-6" />
              </button>
              <h2 className="max-w-[70%] truncate text-[17px] font-semibold">{activeGroup.label}</h2>
            </div>
          )}
          <div className={homeVisible ? "max-lg:hidden" : undefined}>
            <h1 className="mb-6 hidden text-2xl font-semibold tracking-tight lg:block" data-attr="settings-page-title">
              {paneGroup.label}
            </h1>
            <PortalSettingsTitleStyleContext.Provider value="heading">
              <PortalSettingsSections>{renderPane(paneGroup.id)}</PortalSettingsSections>
            </PortalSettingsTitleStyleContext.Provider>
          </div>
        </div>
      </div>
    </ManagerPortalPageShell>
  );
}
