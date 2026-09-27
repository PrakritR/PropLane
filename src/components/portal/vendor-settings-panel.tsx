"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import { ListSkeleton } from "@/components/ui/list-skeleton";
import { usePathname, useSearchParams } from "next/navigation";
import {
  Bell,
  Briefcase,
  Building2,
  CalendarClock,
  Landmark,
  Lock,
  MessageSquareText,
  Settings,
  SlidersHorizontal,
  Smartphone,
  Wrench,
} from "lucide-react";
import {
  useVendorBusinessProfile,
  SectionSaveBadge,
  VendorBusinessProfilePane,
  VendorNotificationsPane,
  VendorWorkIdentitySection,
  VendorWorkNumberStatusNote,
  worstSaveState,
} from "@/components/portal/vendor-business-settings";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { PortalCollapsibleSection } from "@/components/portal/portal-collapsible-section";
import {
  PortalSettingsAutosaveField,
  PortalSettingsField,
  PortalSettingsFormBody,
  PortalSettingsGroup,
  PortalSettingsProfileHeader,
  PortalSettingsSection,
  PortalSettingsSections,
  type PortalSettingsSaveState,
} from "@/components/portal/portal-settings-ui";
import { PortalChangePasswordPanel } from "@/components/portal/portal-change-password-panel";
import { PortalPayoutsSettingsPage } from "@/components/portal/portal-payouts-settings-page";
import { PortalDetailHeader } from "@/components/portal/portal-list-detail-shell";
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

const SETTINGS_TAB_PARAM = "tab";

type VendorSettingsGroupId =
  | "business"
  | "work"
  | "payouts"
  | "notifications"
  | "profile"
  | "capabilities"
  | "availability"
  | "messaging"
  | "preferences"
  | "security"
  | "feedback"
  | "account";

/**
 * Legacy tab ids that must keep resolving after the VD01/VD66 regroup —
 * Work contacts / Work number / Work email folded into one "work" section,
 * and Workspace access (studio VD66) was removed outright, so its old deep
 * link now lands on Business profile rather than 404ing.
 */
const VENDOR_SETTINGS_TAB_ALIASES: Record<string, VendorSettingsGroupId> = {
  "work-contacts": "work",
  "work-number": "work",
  "work-email": "work",
  workspaces: "business",
  "workspace-access": "business",
};

type VendorSettingsGroup = {
  id: VendorSettingsGroupId;
  label: string;
  description?: string;
  icon: ComponentType<{ className?: string }>;
  /**
   * Two top-level cards (captain, 2026-09-27 studio VD01/VD66) — never a flat
   * list of every sub-item. Workspace access was removed and Payouts moved
   * into Account, leaving no third "money" group.
   */
  group: "Business" | "Account";
};

/** Top-level card order for the vendor Settings accordion. */
const VENDOR_SETTINGS_TOP_GROUPS = ["Business", "Account"] as const;

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

  useEffect(() => {
    if (demo) return;
    void fetch("/api/vendor/profile", { credentials: "include" })
      .then((r) => r.json())
      .then(
        (data: {
          profile?: VendorProfileApiRow | null;
          linked?: boolean;
          contact?: { phone?: string; preferredLanguage?: string; smsConsent?: boolean };
        }) => {
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
    if (value === savedProfileRef.current[field]) return;
    if (field === "email" && value && !DIRECTORY_EMAIL_RE.test(value)) {
      setDirectoryFieldState((s) => ({ ...s, email: "error" }));
      setDirectoryFieldError((e) => ({ ...e, email: "Enter a valid email address." }));
      return;
    }
    setDirectoryFieldState((s) => ({ ...s, [field]: "saving" }));
    setDirectoryFieldError((e) => ({ ...e, [field]: undefined }));
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
      const res = await fetch("/api/vendor/profile", {
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
      const res = await fetch("/api/vendor/profile", {
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
      const res = await fetch("/api/vendor/profile", {
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

  function toggleTrade(trade: string, on: boolean) {
    const set = new Set(trades);
    if (on) set.add(trade);
    else set.delete(trade);
    void commitTrades([...set]);
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
    () => [
      {
        id: "business",
        label: "Business profile",
        description: "Your business name, contact, and service area — yours, no manager link needed.",
        icon: Building2,
        group: "Business",
      },
      {
        id: "work",
        label: "Work number & email",
        description: "Your business phone/email, plus a free PropLane-provided work number and email.",
        icon: Smartphone,
        group: "Business",
      },
      {
        id: "profile",
        label: "Directory listing",
        description: "Language, texting consent, and payment methods on your manager directory entry.",
        icon: Briefcase,
        group: "Business",
      },
      {
        id: "capabilities",
        label: "Work capabilities",
        description: "The trades managers can match you with.",
        icon: Wrench,
        group: "Business",
      },
      {
        id: "availability",
        label: "Availability",
        description: "Weekly hours, one-off open dates, and blocked dates.",
        icon: CalendarClock,
        group: "Business",
      },
      {
        id: "payouts",
        label: "Payouts",
        // Always the vendor's OWN Stripe Connect account — never a workspace's bank.
        description: "Your balance, bank accounts, and how you withdraw what you're owed.",
        icon: Landmark,
        group: "Account",
      },
      {
        id: "notifications",
        label: "Notifications",
        description: "Which events reach your inbox and phone.",
        icon: Bell,
        group: "Account",
      },
      {
        id: "messaging",
        label: "Messaging",
        description: "Verify your phone for job texts.",
        icon: Smartphone,
        group: "Account",
      },
      {
        id: "preferences",
        label: "Preferences",
        description: "Assistant and device options.",
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
        icon: Settings,
        group: "Account",
      },
    ],
    [],
  );

  const rawTab = searchParams.get(SETTINGS_TAB_PARAM);
  const normalizedTab = rawTab ? (VENDOR_SETTINGS_TAB_ALIASES[rawTab] ?? rawTab) : rawTab;
  const activeGroup = groups.find((g) => g.id === normalizedTab) ?? null;
  const paneGroup = activeGroup ?? groups[0];

  // Exactly 3 cards visible at the top level (C159) — a card auto-opens once
  // its own sub-item becomes the active pane, but otherwise starts closed.
  const [openTopGroups, setOpenTopGroups] = useState<Set<string>>(() => new Set([paneGroup.group]));
  useEffect(() => {
    setOpenTopGroups((cur) => (cur.has(paneGroup.group) ? cur : new Set(cur).add(paneGroup.group)));
  }, [paneGroup.group]);

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
        return <VendorBusinessProfilePane ctx={business} />;
      case "work":
        return <VendorWorkIdentitySection ctx={business} />;
      case "payouts":
        return <PortalPayoutsSettingsPage portal="vendor" />;
      case "notifications":
        return <VendorNotificationsPane ctx={business} />;
      case "profile":
        return (
          <>
            {unlinkedBanner}
            <PortalSettingsSection title="Directory listing" action={<SectionSaveBadge state={directorySectionState} />}>
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
            <PortalSettingsSection title="Work capabilities" action={<SectionSaveBadge state={capabilitiesState} />}>
              <PortalSettingsGroup>
                {profileLoading ? (
                  <div className="px-4 py-4">
                    <ListSkeleton rows={2} showLeading={false} />
                  </div>
                ) : (
                  <PortalSettingsFormBody>
                    <div className="grid gap-2 rounded-lg border border-border bg-muted/30 p-3 sm:grid-cols-2 lg:grid-cols-3" data-vs-trades>
                      {VENDOR_TRADE_OPTIONS.map((option) => {
                        const on = trades.includes(option);
                        return (
                          <label key={option} className="flex cursor-pointer items-center gap-2 text-sm">
                            <input
                              type="checkbox"
                              className="h-4 w-4 rounded border-border"
                              checked={on}
                              onChange={(e) => toggleTrade(option, e.target.checked)}
                              data-attr={`vendor-capability-${option.toLowerCase().replace(/\s+/g, "-")}`}
                            />
                            <span className="font-medium text-foreground">{option}</span>
                          </label>
                        );
                      })}
                    </div>
                  </PortalSettingsFormBody>
                )}
              </PortalSettingsGroup>
            </PortalSettingsSection>
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
      case "messaging":
        return (
          <>
            <VendorWorkNumberStatusNote />
            <PortalTextNotificationsBlock dataAttrPrefix="vendor" demo={demo} />
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

  // C159: exactly 3 top-level cards ("Company profile" / "Payout" / "Settings"),
  // each an accordion disclosing its own real sub-items — never a flat list of
  // every one of the 15 underlying items at once. Shared between the desktop
  // sidebar and the mobile root screen so both stay in lockstep.
  const renderTopGroupCards = () =>
    VENDOR_SETTINGS_TOP_GROUPS.map((groupLabel) => {
      const groupItems = groups.filter((item) => item.group === groupLabel);
      if (groupItems.length === 0) return null;
      const expanded = openTopGroups.has(groupLabel);
      return (
        <PortalCollapsibleSection
          key={groupLabel}
          title={groupLabel}
          expanded={expanded}
          onExpandedChange={(next) =>
            setOpenTopGroups((cur) => {
              const nextSet = new Set(cur);
              if (next) nextSet.add(groupLabel);
              else nextSet.delete(groupLabel);
              return nextSet;
            })
          }
          toggleDataAttr={`vendor-settings-group-${groupLabel.toLowerCase().replace(/\s+/g, "-")}`}
        >
          <PortalSettingsGroup className="rounded-none border-0">
            {groupItems.map((g) => {
              const active = g.id === paneGroup.id;
              return (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => openGroup(g.id)}
                  aria-current={active ? "page" : undefined}
                  data-attr={`settings-nav-${g.id}`}
                  className={cn(
                    "flex w-full items-center gap-2.5 border-b border-border px-4 py-3 text-left text-sm font-medium transition-colors last:border-0",
                    active ? "bg-primary/10 text-foreground" : "text-muted hover:bg-accent/40 hover:text-foreground",
                  )}
                >
                  <g.icon className={cn("h-4 w-4 shrink-0", active ? "text-primary" : "opacity-80")} />
                  <span className="min-w-0 flex-1 truncate">{g.label}</span>
                </button>
              );
            })}
          </PortalSettingsGroup>
        </PortalCollapsibleSection>
      );
    });

  return (
    <ManagerPortalPageShell
      title="Settings"
      hideTitleOnMobileNav
    >
      <div ref={layoutTopRef} className="lg:flex lg:h-full lg:min-h-0 lg:flex-1 lg:gap-10">
        <aside className="hidden w-72 shrink-0 flex-col gap-3 lg:flex lg:h-full lg:min-h-0 lg:overflow-y-auto lg:overscroll-contain lg:self-stretch">
          <PortalSettingsProfileHeader
            name={profileDraft.name || DEMO_VENDOR_NAME}
            email={profileDraft.email || DEMO_VENDOR_EMAIL}
          />
          {renderTopGroupCards()}
        </aside>
        <div
          ref={contentColRef}
          className="min-w-0 flex-1 lg:min-h-0 lg:max-w-3xl lg:overflow-y-auto lg:overscroll-contain"
        >
          {activeGroup === null ? (
            <div className="space-y-3 lg:hidden">
              <PortalSettingsProfileHeader
                name={profileDraft.name || DEMO_VENDOR_NAME}
                email={profileDraft.email || DEMO_VENDOR_EMAIL}
              />
              {renderTopGroupCards()}
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
          <PortalSettingsSections className={activeGroup === null ? "max-lg:hidden" : undefined}>
            {renderPane(paneGroup.id)}
          </PortalSettingsSections>
        </div>
      </div>
    </ManagerPortalPageShell>
  );
}
