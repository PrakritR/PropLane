"use client";

import { WorkspaceApplicationsLeasesSettings } from "@/components/portal/workspace-applications-leases-settings";
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useWorkspaces } from "@/components/portal/workspace-provider";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  CreditCard,
  KeyRound,
  Lock,
  MessageSquareText,
  MessagesSquare,
  Settings,
  SlidersHorizontal,
  Table2,
  UserRound,
  Wallet,
  ClipboardList,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal, ModalFooter, useModalPresentation } from "@/components/ui/modal";
import { PhoneNumberField } from "@/components/ui/phone-number-field";
import { coercePhoneInput, formatSmsPhoneLabel } from "@/lib/phone-e164";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { PortalChangePasswordPanel } from "@/components/portal/portal-change-password-panel";
import { PortalBugFeedbackPanel } from "@/components/portal/portal-bug-feedback-panel";
import { PortalSettingsExtras } from "@/components/portal/portal-settings-extras";
import { ManagerSheetLinkPanel } from "@/components/portal/manager-sheet-link-panel";
import { ManagerApplicationFormSettings } from "@/components/portal/manager-application-form-settings";
import { LeaseDocumentLibraryPanel } from "@/components/portal/lease-document-library-panel";
import { WorkspaceSettings } from "@/components/portal/workspace-settings";
import { workspaceInitials } from "@/components/portal/workspace-switcher";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import {
  PortalSettingsField,
  PortalSettingsGroup,
  PortalSettingsLinkRow,
  PortalSettingsProfileHeader,
  PortalSettingsRow,
  PortalSettingsSection,
  PortalSettingsSections,
  type PortalSettingsSaveState,
} from "@/components/portal/portal-settings-ui";
import { ManagerPlan } from "@/components/portal/pro-plan";
import { ManagerApiKeysPanel } from "@/components/portal/pro-api-keys-panel";
import { ManagerMessagingSettingsPanel } from "@/components/portal/pro-messaging-settings-panel";
import { AutoSendAiDraftsRow } from "@/components/portal/pro-portal-automation-settings-panel";
import { CommunicationSettingsPanel } from "@/components/portal/pro-portal-settings-panels";
import { SettingsModulePage } from "@/components/portal/settings-module-page";
import { SettingsPropertyScopeProvider } from "@/components/portal/settings-property-scope";
import { buildManagerPropertyFilterOptions, MANAGER_PORTFOLIO_REFRESH_EVENTS } from "@/lib/manager-portfolio-access";
import { syncPropertyPipelineFromServer } from "@/lib/demo-property-pipeline";
import { isDemoModeActive, resolveManagerScopeUserId } from "@/lib/demo/demo-session";
import {
  allWorkspacePropertyOptions,
  unionLabeledPropertyOptions,
} from "@/lib/workspaces/selection";
import type { ManagerPortalSettingsTab } from "@/components/portal/pro-portal-settings-modal";
import { MANAGER_PLAN_PORTAL_HASH } from "@/lib/portals/manager-plan-path";
import { AssistantDisplaySetting } from "@/components/portal/assistant-display-setting";
import { AssistantCustomInstructionsSetting } from "@/components/portal/assistant-custom-instructions-setting";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { WhatProplaneSends } from "@/components/portal/what-proplane-sends";
import { DARK_MODE_ENABLED } from "@/lib/theme-storage";
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

/**
 * Every `?tab=` id (current or legacy-aliased) that no longer resolves to a
 * Settings pane for ANY variant, so a bookmark to one of them redirects to
 * Profile instead of rendering blank (S019, captain 2026-09-27). Preferences
 * and Feedback are deliberately absent — the admin variant still shows both.
 * Application form and Lease documents are not part of the redesigned
 * Settings navigation; their configuration is reached from their property
 * sections.
 */
const REMOVED_SETTINGS_TAB_IDS = new Set([
  "notifications",
  "applications",
  "lease",
  "forms",
  "tours",
  "resident",
  "services",
  "tasks",
  "reminders",
  // Legacy aliases that used to resolve to one of the ids above.
  "properties",
  "automation",
  "leases",
  "residents",
  "bookings",
  "inspections",
  "applicationForm",
  "leaseDocuments",
]);

/**
 * Settings simplification (S019/S008, captain 2026-09-27: "simplify settings
 * fully"). The only settings that still apply to a WORKSPACE rather than the
 * account are Communication, Payments, and Integrations — Applications,
 * Leases, Tours, Residents, Services, and Tasks
 * left Settings entirely (their choices move to each property's own section
 * gear, a separate piece of work), and Reminders left with them (reminders
 * run on one fixed schedule now, never a per-workspace or per-house override
 * — see `WhatProplaneSends`).
 *
 * Payments retain property overrides through `SettingsScopeBar`. Communication
 * reads the workspace chosen in the shell's workspace switcher, so a second
 * scope picker on that page would be misleading.
 */
export const WORKSPACE_SCOPED_PANES = new Set<SettingsGroupId>(["payments"]);

/**
 * Application form and Lease documents are not workspace-level settings in
 * the current Settings navigation.
 */
export const WORKSPACE_ONLY_SCOPED_PANES = new Set<SettingsGroupId>();

/** Profile, Billing, Login & security, API & MCP, Account — every setting on these applies to the account, never a workspace or house. Feedback joins this set only for the admin variant, which still shows that pane. */
export const ACCOUNT_TAG_PANES = new Set<SettingsGroupId>(["profile", "billing", "security", "developer", "feedback", "account"]);

/** Preferences (appearance, assistant, device options) is per-device, never account- or workspace-wide. Manager no longer shows this pane at all; admin still does. */
export const DEVICE_TAG_PANES = new Set<SettingsGroupId>(["preferences"]);

/**
 * Exempt from every classification above: Workspace and Communication follow
 * the selected workspace; Integrations manages Google connections outside
 * the property scope. Exported alongside the other
 * classification sets so `tests/unit/settings-account-tags.test.tsx` can
 * assert every nav entry is accounted for exactly once.
 */
export const SETTINGS_SCOPE_EXEMPT_PANES = new Set<SettingsGroupId>(["workspaces", "messaging", "spreadsheets"]);

/** The two fields on this screen a person may write. */
type ProfileField = "fullName" | "phone";

export type SettingsGroupId =
  | "workspaces"
  | "profile"
  | "billing"
  | "messaging"
  | "preferences"
  | "security"
  | "developer"
  | "feedback"
  | "account"
  | "applicationForm"
  | "leaseDocuments"
  | "payments"
  | "payouts"
  | "applicationsLeases"
  | "spreadsheets";

type SettingsGroup = {
  id: SettingsGroupId;
  label: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
  group: "Profile" | "Workspace";
};

function ManagerMessagingSettingsPane() {
  return (
    <>
      <ManagerMessagingSettingsPanel />
      <PortalSettingsSection title="Automation">
        <AutoSendAiDraftsRow />
      </PortalSettingsSection>
      <CommunicationSettingsPanel />
      <WhatProplaneSends />
    </>
  );
}

function HubSettingsModulePane({ tab }: { tab: ManagerPortalSettingsTab }) {
  const { userId } = useManagerUserId();
  const workspaces = useWorkspaces();
  const propertyOptions = useMemo(
    () =>
      unionLabeledPropertyOptions(
        allWorkspacePropertyOptions(workspaces?.workspaces ?? []),
        buildManagerPropertyFilterOptions(resolveManagerScopeUserId(userId)),
      ),
    [userId, workspaces?.workspaces],
  );

  return <SettingsModulePage tab={tab} propertyOptions={propertyOptions} showFormLink />;
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
  const editPresentation = useModalPresentation();
  const workspaces = useWorkspaces();
  const [fullName, setFullName] = useState(dashToEmpty(initialFullName));
  const [phone, setPhone] = useState(phoneDashToEmpty(initialPhone));
  const [editingField, setEditingField] = useState<ProfileField | null>(null);
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
    if (next[field] === savedRef.current[field]) return true;
    if (demo) {
      savedRef.current = next;
      markSaved(field);
      return true;
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
        return false;
      }
      if (!res.ok) {
        setFieldState((prev) => ({ ...prev, [field]: "error" }));
        setFieldError((prev) => ({ ...prev, [field]: body.error ?? "Could not save." }));
        return false;
      }
      if (variant === "manager") {
        cacheLandlordLegalName(landlordLegalNameFromAccountFullName(next.fullName));
      }
      savedRef.current = next;
      markSaved(field);
      return true;
    } catch {
      setFieldState((prev) => ({ ...prev, [field]: "error" }));
      setFieldError((prev) => ({ ...prev, [field]: "No connection. Your change is still here." }));
      return false;
    } finally {
      inFlightRef.current = false;
    }
  }, [demo, fullName, phone, markSaved, variant]);

  const beginEdit = (field: ProfileField) => {
    setFieldError((prev) => ({ ...prev, [field]: undefined }));
    if (field === "fullName") setFullName(savedRef.current.fullName);
    else setPhone(savedRef.current.phone);
    setEditingField(field);
  };
  const cancelEdit = (field: ProfileField) => {
    if (field === "fullName") setFullName(savedRef.current.fullName);
    else setPhone(savedRef.current.phone);
    setFieldError((prev) => ({ ...prev, [field]: undefined }));
    setEditingField(null);
  };
  const saveEdit = async (field: ProfileField) => {
    if (await commit(field)) setEditingField(null);
  };

  const renderEditableProfileRow = (field: ProfileField, label: string, value: string) => {
    const editing = editingField === field && editPresentation === "dialog";
    const inputId = field === "fullName" ? "pf-name" : "pf-phone";
    return (
      <div className="border-b border-border px-4 py-3.5 last:border-0" data-attr={`profile-${field}-row`}>
        <div className="flex min-h-11 items-center justify-between gap-4">
          <span className="text-sm font-medium text-foreground">{label}</span>
          {editing ? (
            <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
              <Input
                id={inputId}
                value={field === "fullName" ? fullName : phone}
                onChange={(event) => field === "fullName" ? setFullName(event.target.value) : setPhone(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void saveEdit(field);
                  if (event.key === "Escape") cancelEdit(field);
                }}
                autoComplete={field === "fullName" ? "name" : "tel"}
                aria-label={label}
                data-attr={field === "fullName" ? "settings-full-name" : "settings-phone"}
                className="h-9 max-w-[18rem] rounded-lg"
              />
              <Button type="button" variant="ghost" onClick={() => cancelEdit(field)}>Cancel</Button>
              <Button type="button" variant="primary" onClick={() => saveEdit(field)}>Save</Button>
            </div>
          ) : (
            <button
              type="button"
              className="flex min-w-0 items-center gap-2 text-right text-sm text-foreground hover:text-primary"
              onClick={() => beginEdit(field)}
              data-attr={`settings-edit-${field}`}
            >
              <span className="max-w-[22rem] truncate">{value || "Add"}</span>
              {fieldState[field] === "saved" ? <Check className="size-4 text-emerald-600" aria-label="Saved" /> : null}
              {fieldState[field] !== "saved" ? <span aria-hidden className="text-muted">Edit</span> : null}
            </button>
          )}
        </div>
        {editing && fieldError[field] ? <p className="mt-1 text-sm text-danger" role="alert">{fieldError[field]}</p> : null}
      </div>
    );
  };

  const personalInfoSection = (
    <>
      <PortalSettingsProfileHeader name={emptyToDash(fullName)} email={initialEmail} />
      <PortalSettingsSection title="Personal information">
        <PortalSettingsGroup>
          {renderEditableProfileRow("fullName", "Full name", fullName)}
          <PortalSettingsField label="Email" value={initialEmail} />
          {renderEditableProfileRow("phone", "Phone", formatSmsPhoneLabel(phone) || "")}
          <PortalSettingsRow label={idLabel}>
            <span className="font-mono text-sm text-foreground">{formatProplaneIdForDisplay(idValue)}</span>
            <PortalIconAction icon={Copy} label={`Copy ${idLabel}`} onClick={() => void navigator.clipboard?.writeText(formatProplaneIdForDisplay(idValue))} data-attr="profile-copy-id" />
          </PortalSettingsRow>
        </PortalSettingsGroup>
      </PortalSettingsSection>
      <Modal
        open={editingField !== null && editPresentation === "drawer"}
        title={editingField === "fullName" ? "Full name" : "Phone"}
        onClose={() => editingField && cancelEdit(editingField)}
        dataAttr="profile-edit-sheet"
        footer={editingField ? (
          <ModalFooter>
            <Button type="button" variant="ghost" onClick={() => cancelEdit(editingField)}>Cancel</Button>
            <Button type="button" variant="primary" onClick={() => saveEdit(editingField)}>Save</Button>
          </ModalFooter>
        ) : null}
      >
        {editingField ? (
          <>
            <label htmlFor={editingField === "fullName" ? "pf-name-sheet" : "pf-phone-sheet"} className="mb-2 block text-sm font-medium text-foreground">
              {editingField === "fullName" ? "Full name" : "Phone"}
            </label>
            {editingField === "fullName" ? (
              <Input id="pf-name-sheet" value={fullName} onChange={(event) => setFullName(event.target.value)} autoComplete="name" />
            ) : (
              <PhoneNumberField id="pf-phone-sheet" value={phone} onChange={setPhone} />
            )}
            {fieldError[editingField] ? <p className="mt-2 text-sm text-danger" role="alert">{fieldError[editingField]}</p> : null}
          </>
        ) : null}
      </Modal>
    </>
  );

  const groups = useMemo<SettingsGroup[]>(() => {
    const list: SettingsGroup[] = [
      {
        id: "profile",
        label: "Profile",
        description: `Name, contact details, and ${idLabel}.`,
        icon: UserRound,
        group: "Profile",
      },
    ];
    // Preferences and Notifications left manager Settings entirely (S019,
    // captain 2026-09-27: "simplify settings fully"): the assistant popup/dock
    // choice moved onto the assistant itself (`AssistantDisplaySetting`),
    // manager alert routing is fixed (portal + email, always), and appearance
    // has no other control worth a pane. Admin keeps this pane unchanged.
    if (variant !== "manager") {
      list.push({
        id: "preferences",
        label: "Preferences",
        description: "Appearance, assistant, and device options.",
        icon: SlidersHorizontal,
        group: "Profile",
      });
    }
    list.push({
      id: "security",
      label: "Login & security",
      description: "Password and sign-in options.",
      icon: Lock,
      group: "Profile",
    });
    // Keys authorize against the manager tool layer, so the pane is manager-only.
    // /demo must never mint a real credential.
    if (!demo && variant === "manager") {
      list.push({
        id: "developer",
        label: "API & MCP",
        description: "Connect your own AI agent to PropLane.",
        icon: KeyRound,
        group: "Profile",
      });
    }
    // Feedback left manager Settings too — "Need help?" in the sidebar is the
    // one feedback path now (`PortalBugFeedbackPanel` still lives there).
    // Admin keeps this pane unchanged.
    if (variant !== "manager") {
      list.push({
        id: "feedback",
        label: "Feedback",
        description: "Report issues or share product feedback.",
        icon: MessageSquareText,
        group: "Profile",
      });
    }
    list.push({
      id: "account",
      label: "Account",
      description: "Switch portals, sign out, or delete your account.",
      icon: Settings,
      group: "Profile",
    });
    // Billing & plan sits in the Profile group (captain, 2026-10-03) but still
    // bills the workspace selected in the sidebar switcher.
    if (!demo && variant === "manager") {
      list.push({
        id: "billing",
        label: "Billing & plan",
        description: "Subscription and payment details.",
        icon: CreditCard,
        group: "Profile",
      });
    }
    // Workspace-level settings: Workspace, Payments and Communication.
    // Integrations are account connections; forms and lease documents are
    // reached from their corresponding property sections.
    if (!demo && variant === "manager") {
      list.push({ id: "workspaces", label: "Workspace", description: "Workspace details, members, properties, and plan.", icon: Settings, group: "Workspace" });
      list.push({
        id: "messaging",
        label: "Communication",
        description: "Your work number and work email, and what PropLane sends.",
        icon: MessagesSquare,
        group: "Workspace",
      });
    }
    if (variant === "manager") {
      list.push(
        { id: "payments", label: "Balance & payouts", description: "PropLane balance, bank accounts, and withdrawals.", icon: Wallet, group: "Workspace" },
        // Captain, Oct 3: the workspace's signing order and lease defaults are their own section.
        { id: "applicationsLeases", label: "Applications & leases", description: "Signing order and lease defaults for this workspace.", icon: ClipboardList, group: "Workspace" },
        { id: "spreadsheets", label: "Integrations", description: "Google Calendar and Sheets.", icon: Table2, group: "Workspace" },
      );
    }
    return list;
  }, [demo, idLabel, variant]);

  // Legacy upgrade CTAs still link to `/portal/profile#portal-plan`; the
  // canonical deep-link is `?tab=billing` (+ optional hash). Stripe returns to
  // `/portal/profile?checkout=…`. Re-run whenever search/hash changes so
  // Workspaces → View plans opens Billing even when Profile is already mounted.
  const [billingOverride, setBillingOverride] = useState(false);
  const rawTab = searchParams.get(SETTINGS_TAB_PARAM);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const q = new URLSearchParams(window.location.search);
    const wantsBilling =
      rawTab === "billing" ||
      window.location.hash === MANAGER_PLAN_PORTAL_HASH ||
      q.has("checkout");
    if (wantsBilling) setBillingOverride(true);
  }, [rawTab, searchParams]);
  useEffect(() => {
    if (rawTab === "vendors") router.replace("/portal/vendors");
    if (rawTab === "team") router.replace("/portal/profile?tab=workspaces");
    if (rawTab === "communication") router.replace("/portal/profile?tab=messaging");
    if (rawTab === "payouts") router.replace("/portal/profile?tab=payments");
    // Settings simplification (S019, captain 2026-09-27): Applications, Lease
    // documents/clauses, Forms, Tours, Residents, Services, Tasks, Reminders,
    // Notifications, and every old alias that pointed at one of them left
    // Settings for good — their choices live on each property's own section,
    // or (Reminders) run on one fixed schedule with no settings pane at all.
    // A bookmark or stale link to any of them must not 404 or render blank,
    // so it lands on Profile rather than a pane that no longer exists.
    if (REMOVED_SETTINGS_TAB_IDS.has(rawTab ?? "")) router.replace("/portal/profile?tab=profile");
  }, [rawTab, router]);
  const billingGroup = groups.find((g) => g.id === "billing") ?? null;
  const settingsHome = (searchParams.get("settingsHome") === "1" || (!rawTab && searchParams.get("profileHome") !== "1" && !billingOverride)) && variant === "manager";
  const profileHome = searchParams.get("profileHome") === "1" && variant === "manager";
  const activeGroup = settingsHome || profileHome ? null :
    groups.find((g) => g.id === rawTab) ?? (billingOverride ? billingGroup : null) ?? null;
  // Desktop always shows a pane (a phone-home link still names its tab); with none it defaults to Profile, the first group.
  const paneGroup = activeGroup ?? groups.find((g) => g.id === rawTab) ?? groups[0];

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
      if (id) { params.delete("settingsHome"); params.delete("profileHome"); }
      const query = params.toString();
      return query ? `${pathname}?${query}` : pathname;
    },
    [pathname, searchParams],
  );

  // The workspace + property scope for Portfolio/Operations settings rides in
  // the URL beside `?tab=` so a reload and the browser back button keep the
  // chosen scope. React state is the live source of truth: `history.pushState`
  // updates the address bar, but Next does not always re-render `useSearchParams`
  // from that write — which is how the pill stayed on All workspaces while Work
  // number titled the last portal workspace.
  const { userId: managerUserId, ready: managerReady } = useManagerUserId();
  const urlWorkspaceId = searchParams.get("workspace") ?? "";
  const urlPropertyIds = useMemo(() => {
    const raw = searchParams.get("property") ?? "";
    return raw
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
  }, [searchParams]);
  const [scopeWorkspaceId, setScopeWorkspaceIdState] = useState(urlWorkspaceId);
  const [, setScopePropertyIdsState] = useState<string[]>(urlPropertyIds);
  useEffect(() => {
    setScopeWorkspaceIdState(urlWorkspaceId);
  }, [urlWorkspaceId]);
  useEffect(() => {
    setScopePropertyIdsState((current) =>
      current.length === urlPropertyIds.length && current.every((id, index) => id === urlPropertyIds[index])
        ? current
        : urlPropertyIds,
    );
  }, [urlPropertyIds]);
  // The picker options come from workspace payloads plus the client property
  // store, which hydrates asynchronously from /api/property-records.
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
  // The FULL account list — `SettingsScopeBar` narrows it to whichever workspace
  // is chosen, so this must not pre-filter to only the currently active one.
  const scopeOptions = useMemo(
    () =>
      unionLabeledPropertyOptions(
        allWorkspacePropertyOptions(workspaces?.workspaces ?? []),
        buildManagerPropertyFilterOptions(resolveManagerScopeUserId(managerUserId)),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [managerUserId, propertyTick, workspaces?.workspaces],
  );
  const setScopeWorkspaceId = useCallback(
    (id: string) => {
      setScopeWorkspaceIdState(id);
      setScopePropertyIdsState([]);
      const params = new URLSearchParams(searchParams.toString());
      if (id) params.set("workspace", id);
      else params.delete("workspace");
      params.delete("property");
      const query = params.toString();
      window.history.pushState(null, "", query ? `${pathname}?${query}` : pathname);
    },
    [pathname, searchParams],
  );
  const setScopePropertyIds = useCallback(
    (ids: string[]) => {
      setScopePropertyIdsState(ids);
      const params = new URLSearchParams(searchParams.toString());
      if (ids.length > 0) params.set("property", ids.join(","));
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
    if (variant === "manager" && !["profile", "security", "developer", "account"].includes(paneGroup.id)) {
      router.back();
      return;
    }
    const params = new URLSearchParams(searchParams.toString());
    params.delete("tab");
    params.set("profileHome", "1");
    window.history.replaceState(null, "", `${pathname}?${params}`);
  }, [variant, paneGroup.id, router, searchParams, pathname]);
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
    contentColRef.current?.scrollTo?.({ top: 0, behavior: "auto" });
    layoutTopRef.current?.scrollIntoView({ block: "start", behavior: "auto" });
  }, [activeGroup?.id]);

  const renderPane = (id: SettingsGroupId): ReactNode => {
    switch (id) {
      case "workspaces":
        return <WorkspaceSettings openNew={searchParams?.get("new") === "1"} />;
      case "profile":
        return personalInfoSection;
      case "payments":
        return <HubSettingsModulePane tab="payments" />;
      case "billing":
        // Billing is a complete operational surface (PLAN-0920-1400): `ManagerPlan`
        // owns the whole page — Plan, Usage, Extra usage, Add-ons, Payment,
        // Invoices, Cancellation — in that order, so Settings deliberately
        // mounts nothing else around it.
        return (
          <div className="min-w-0">
            <ManagerPlan embedded showCurrentPlan={false} showInvoices={false} />
          </div>
        );
      case "messaging":
        return <ManagerMessagingSettingsPane />;
      case "preferences":
        return (
          <>
            {DARK_MODE_ENABLED ? (
              <PortalSettingsSection title="Appearance">
                <PortalSettingsGroup>
                  <PortalSettingsRow label="Theme">
                    <ThemeToggle className="shrink-0" />
                  </PortalSettingsRow>
                </PortalSettingsGroup>
              </PortalSettingsSection>
            ) : null}
            <AssistantDisplaySetting />
            <AssistantCustomInstructionsSetting role={variant} />
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
      case "spreadsheets":
        return variant === "manager" && !demo ? <ManagerSheetLinkPanel /> : null;
      case "applicationsLeases":
        return variant === "manager" ? <WorkspaceApplicationsLeasesSettings /> : null;
      case "applicationForm":
        // Kept per the S014 correction (captain, 06:47): the Applications
        // list-page gear was removed by another worker on the assumption
        // this workspace-default editing still lives in Settings.
        return <ManagerApplicationFormSettings />;
      case "leaseDocuments":
        // Kept per the same S014 correction — the Leases list-page gear was
        // removed on the same assumption.
        return <LeaseDocumentLibraryPanel />;
      case "account":
        return <PortalSettingsExtras currentKind={portalKind} variant="session" />;
    }
  };

  // One settings place (captain, 2026-10-03): the avatar menu has a single
  // Settings row, and this nav carries both groups. PROFILE is the account
  // (never workspace-dependent); WORKSPACE follows the workspace selected in the
  // sidebar switcher, whose name is shown read-only above its rows.
  const WORKSPACE_GROUP_ORDER: SettingsGroupId[] = ["workspaces", "payments", "applicationsLeases", "messaging", "spreadsheets"];
  const profileGroups = groups.filter((g) => g.group === "Profile");
  const workspaceGroups = WORKSPACE_GROUP_ORDER.flatMap((id) => groups.filter((g) => g.id === id));
  const limitedWorkspace = variant === "manager" && Boolean(workspaces?.active && !workspaces.active.owned && !workspaces.active.canManageMembers);
  const locked = (id: string) => limitedWorkspace && ["messaging", "payments", "applicationsLeases", "spreadsheets"].includes(id);
  // Panes whose content is the selected workspace's: remount when the sidebar switches it.
  const followsWorkspace = (id: string) => [...WORKSPACE_GROUP_ORDER, "billing"].includes(id);
  const paneTitle = paneGroup.id === "workspaces" ? "Workspace settings" : paneGroup.label;
  const workspaceName = variant === "manager" && workspaceGroups.length > 0 && workspaces?.active ? (
    <div data-attr="settings-workspace-name" className="flex min-w-0 items-center gap-2.5 px-3 py-2">
      <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary/10 text-[11px] font-bold text-primary" aria-hidden>{workspaceInitials(workspaces.active.name)}</span>
      <span className="truncate text-sm font-semibold text-foreground">{workspaces.active.name}</span>
    </div>
  ) : null;
  const pane = locked(paneGroup.id)
    ? <PortalSettingsGroup><PortalSettingsRow label={<span className="flex items-center gap-2"><Lock className="h-4 w-4" />{paneGroup.label}</span>}><span className="text-[15px] text-muted">Read-only access</span></PortalSettingsRow></PortalSettingsGroup>
    : renderPane(paneGroup.id);
  const scopedPane = WORKSPACE_SCOPED_PANES.has(paneGroup.id) || WORKSPACE_ONLY_SCOPED_PANES.has(paneGroup.id)
    ? <SettingsPropertyScopeProvider workspaceId={workspaces?.active?.id ?? scopeWorkspaceId} onWorkspaceIdChange={setScopeWorkspaceId} propertyIds={[]} onPropertyIdsChange={setScopePropertyIds} options={scopeOptions}>{pane}</SettingsPropertyScopeProvider>
    : pane;
  const groupLabelClass = "px-3 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-wider text-muted";
  const navButton = (g: SettingsGroup) => (
    <button key={g.id} type="button" onClick={() => openGroup(g.id)} aria-current={paneGroup.id === g.id ? "page" : undefined}
      data-attr={`settings-nav-${g.id}`} className={`flex min-h-9 w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm ${paneGroup.id === g.id ? "bg-primary/10 text-primary" : "text-muted hover:bg-accent/40"}`}>
      <g.icon className="h-4 w-4" /><span className="flex-1">{g.label}</span>{locked(g.id) ? <Lock className="h-3.5 w-3.5" /> : null}
    </button>
  );
  const linkRow = (g: SettingsGroup) => (
    <PortalSettingsLinkRow key={g.id} icon={locked(g.id) ? <Lock className="h-4 w-4" /> : <g.icon className="h-4 w-4" />} label={g.label}
      value={g.id === "billing" ? workspaces?.plan?.tier ?? undefined : undefined} onClick={() => openGroup(g.id)} dataAttr={`settings-open-${g.id}`} />
  );
  const homeVisible = activeGroup === null;
  return (
    <ManagerPortalPageShell title="Settings" navigationProvidesTitle hideTitleOnMobileNav>
      <div ref={layoutTopRef} data-attr="settings-layout" className="lg:flex lg:h-full lg:min-h-0 lg:flex-1 lg:gap-10">
        <nav aria-label="Settings sections" className="hidden w-[216px] shrink-0 space-y-1 lg:block">
          {variant === "manager" ? <p className={`${groupLabelClass} pt-0`} data-attr="settings-group-profile">Profile</p> : null}
          {profileGroups.map(navButton)}
          {workspaceGroups.length > 0 ? <>
            <p className={groupLabelClass} data-attr="settings-group-workspace">Workspace</p>
            {workspaceName}
            {workspaceGroups.map(navButton)}
          </> : null}
        </nav>
        <div ref={contentColRef} className="min-w-0 flex-1 lg:min-h-0 lg:max-w-[720px] lg:overflow-y-auto lg:overscroll-contain">
          {homeVisible ? <div className="space-y-6 lg:hidden" data-attr="settings-home">
            <button type="button" aria-label="Back" data-attr="settings-home-back" className="grid h-11 w-11 place-items-center" onClick={() => router.back()}><ChevronLeft className="h-6 w-6" /></button>
            <h2 className="text-[30px] font-semibold tracking-tight">Settings</h2>
            <div className="space-y-2">
              {variant === "manager" ? <p className={`${groupLabelClass} pt-0`}>Profile</p> : null}
              {variant === "manager" ? <button type="button" data-attr="settings-open-profile" onClick={() => openGroup("profile")} className="block w-full text-left" aria-label="Open Profile">
                <PortalSettingsProfileHeader name={emptyToDash(fullName)} email={initialEmail} action={<ChevronRight className="h-4 w-4 text-muted" />} />
              </button> : null}
              <PortalSettingsGroup>{profileGroups.filter((g) => variant !== "manager" || g.id !== "profile").map(linkRow)}</PortalSettingsGroup>
            </div>
            {workspaceGroups.length > 0 ? <div className="space-y-2">
              <p className={`${groupLabelClass} pt-0`}>Workspace</p>
              {workspaceName}
              <PortalSettingsGroup>{workspaceGroups.map(linkRow)}</PortalSettingsGroup>
            </div> : null}
          </div> : <>
            <div className="sticky top-0 z-20 mb-4 flex h-[52px] items-center justify-center bg-background/95 backdrop-blur lg:hidden">
              <button type="button" onClick={backToRoot} aria-label="Back" data-attr="settings-back-to-root" className="absolute left-0 grid h-11 w-11 place-items-center"><ChevronLeft className="h-6 w-6" /></button>
              <h2 className="max-w-[70%] truncate text-[17px] font-semibold">{paneTitle}</h2>
            </div>
          </>}
          <div className={homeVisible ? "max-lg:hidden" : undefined}>
            <h1 className="mb-6 hidden text-2xl font-semibold tracking-tight lg:block">{paneTitle}</h1>
            <PortalSettingsSections key={followsWorkspace(paneGroup.id) ? workspaces?.active?.id ?? "workspace" : "account"}>{scopedPane}</PortalSettingsSections>
          </div>
        </div>
      </div>
    </ManagerPortalPageShell>
  );
}
