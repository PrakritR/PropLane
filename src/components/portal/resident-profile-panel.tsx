"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { Lock, MessageSquareText, Settings2, SlidersHorizontal, Smartphone, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { PortalChangePasswordPanel } from "@/components/portal/portal-change-password-panel";
import { PortalBugFeedbackPanel } from "@/components/portal/portal-bug-feedback-panel";
import { PortalDetailHeader } from "@/components/portal/portal-list-detail-shell";
import { PortalSettingsExtras } from "@/components/portal/portal-settings-extras";
import { PortalTextNotificationsBlock } from "@/components/portal/portal-text-notifications-block";
import {
  PortalSettingsField,
  PortalSettingsFormBody,
  PortalSettingsGroup,
  PortalSettingsLinkRow,
  PortalSettingsNav,
  PortalSettingsProfileHeader,
  PortalSettingsRow,
  PortalSettingsSection,
  PortalSettingsSections,
} from "@/components/portal/portal-settings-ui";
import { AssistantCustomInstructionsSetting } from "@/components/portal/assistant-custom-instructions-setting";
import { NotificationsToggle } from "@/components/native/notifications-toggle";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import {
  normalizeApplicationAxisId,
  readManagerApplicationRows,
  resolveResidentPortalAxisId,
} from "@/lib/manager-applications-storage";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { usePortalSession } from "@/hooks/use-portal-session";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { formatProplaneIdForDisplay } from "@/lib/manager-id";

const SETTINGS_TAB_PARAM = "tab";

type SettingsGroupId = "profile" | "messaging" | "preferences" | "security" | "feedback" | "account";

type SettingsGroup = {
  id: SettingsGroupId;
  label: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
};

function emptyToDash(v: string) {
  const t = v.trim();
  return t.length ? t : "—";
}

export function ResidentProfilePanel() {
  const { showToast } = useAppUi();
  const session = usePortalSession();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const demo = isDemoModeActive();

  const [userId, setUserId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [axisId, setAxisId] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!session.userId) return;
    if (demo) {
      const demoUserId = session.userId;
      const demoEmail = session.email ?? "";
      queueMicrotask(() => {
        const normalizedEmail = demoEmail.trim().toLowerCase();
        const matchingApplication = readManagerApplicationRows()
          .slice()
          .reverse()
          .find((row) => row.email?.trim().toLowerCase() === normalizedEmail);
        setUserId(demoUserId);
        setEmail(demoEmail);
        setName((current) => current || matchingApplication?.name?.trim() || "");
        setPhone((current) => current || matchingApplication?.application?.phone?.trim() || "");
        setAxisId(resolveResidentPortalAxisId({ applicationRowId: matchingApplication?.id }));
      });
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const supabase = createSupabaseBrowserClient();
        const [{ data: profile }, { data: authUser }] = await Promise.all([
          supabase.from("profiles").select("*").eq("id", session.userId).maybeSingle(),
          supabase.auth.getUser(),
        ]);
        if (cancelled) return;

        const normalizedEmail = (session.email ?? "").trim().toLowerCase();
        const matchingApplication = readManagerApplicationRows()
          .slice()
          .reverse()
          .find((row) => row.email?.trim().toLowerCase() === normalizedEmail);

        const resolvedName =
          profile?.full_name?.trim() ||
          matchingApplication?.application?.fullLegalName?.trim() ||
          matchingApplication?.name?.trim() ||
          "";
        const resolvedPhone =
          profile?.phone?.trim() ||
          matchingApplication?.application?.phone?.trim() ||
          "";
        const meta = authUser?.user?.user_metadata as Record<string, unknown> | undefined;
        const metaAxis = typeof meta?.axis_id === "string" ? meta.axis_id : null;

        setUserId(session.userId);
        setEmail(session.email ?? "");
        setName((current) => current || resolvedName);
        setPhone((current) => current || resolvedPhone);
        setAxisId(
          resolveResidentPortalAxisId({
            profileManagerId: profile?.manager_id,
            authUserAxisId: metaAxis,
            applicationRowId: matchingApplication?.id,
          }),
        );

        const appCanonical = matchingApplication?.id
          ? normalizeApplicationAxisId(matchingApplication.id)
          : "";
        const storedManagerAxis = normalizeApplicationAxisId(String(profile?.manager_id ?? ""));
        const needsAxisBackfill = Boolean(appCanonical && storedManagerAxis !== appCanonical);

        const needsProfileBackfill =
          !profile ||
          !String(profile.full_name ?? "").trim() ||
          !String(profile.phone ?? "").trim();

        if (needsProfileBackfill || needsAxisBackfill) {
          void fetch("/api/profile/backfill", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              fullName: resolvedName || undefined,
              phone: resolvedPhone || undefined,
              ...(needsAxisBackfill ? { axisId: appCanonical } : {}),
            }),
          }).catch(() => undefined);
        }
      } catch {
        /* env missing */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [demo, session.email, session.userId]);

  const saveProfile = useCallback(async () => {
    if (!userId) {
      showToast("Sign in to save profile.");
      return;
    }
    if (!name.trim()) {
      showToast("Name is required.");
      return;
    }
    if (demo) {
      showToast("Profile changes are simulated in this demo.");
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fullName: name.trim(), phone: phone.trim() }),
      });
      const raw = await res.text();
      let body: { error?: string; ok?: boolean } = {};
      try {
        body = raw ? (JSON.parse(raw) as { error?: string; ok?: boolean }) : {};
      } catch {
        showToast("Save failed (invalid response).");
        return;
      }
      if (!res.ok) {
        showToast(body.error ?? "Could not save profile.");
        return;
      }
      showToast("Profile saved.");
      setEditing(false);
    } catch {
      showToast("Could not save profile.");
    } finally {
      setSaving(false);
    }
  }, [demo, name, phone, showToast, userId]);

  const editAction = editing ? (
    <div className="flex flex-wrap gap-2">
      <Button
        type="button"
        variant="primary"
        className="px-4 text-[13px]"
        disabled={saving}
        onClick={() => saveProfile()}
      >
        {saving ? "Saving…" : "Save"}
      </Button>
    </div>
  ) : (
    <Button type="button" variant="outline" className="px-4 text-[13px]" onClick={() => setEditing(true)}>
      Edit
    </Button>
  );

  const personalInfoSection = (
    <PortalSettingsSection
      title="Personal information"
      description="Your name and contact details."
      action={editAction}
    >
      <PortalSettingsGroup>
        {editing ? (
          <PortalSettingsFormBody>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground" htmlFor="resident-pf-name">
                  Full name
                </label>
                <Input id="resident-pf-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground" htmlFor="resident-pf-email">
                  Email
                </label>
                <Input id="resident-pf-email" value={email} readOnly className="bg-muted/40" />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground" htmlFor="resident-pf-phone">
                  Phone
                </label>
                <Input
                  id="resident-pf-phone"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  inputMode="tel"
                  autoComplete="tel"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground" htmlFor="resident-pf-id">
                  PropLane ID
                </label>
                <Input
                  id="resident-pf-id"
                  value={formatProplaneIdForDisplay(axisId)}
                  readOnly
                  className="bg-muted/40 font-mono text-sm"
                />
              </div>
            </div>
          </PortalSettingsFormBody>
        ) : (
          <>
            <PortalSettingsField label="Full name" value={emptyToDash(name)} />
            <PortalSettingsField label="Email" value={email} />
            <PortalSettingsField label="Phone" value={emptyToDash(phone)} />
            {/*
              Shown through the display formatter. Accounts created before the
              rebrand still STORE an `AXIS-` id — every lookup accepts both
              prefixes and renaming the stored value is a migration, not a
              label change — but a field captioned "PropLane ID" must never
              read AXIS to the person whose id it is.
            */}
            <PortalSettingsField label="PropLane ID" value={formatProplaneIdForDisplay(axisId)} mono />
          </>
        )}
      </PortalSettingsGroup>
    </PortalSettingsSection>
  );

  const groups = useMemo<SettingsGroup[]>(
    () => [
      {
        id: "profile",
        label: "Profile",
        description: "Name, contact details, and PropLane ID.",
        icon: UserRound,
      },
      {
        id: "messaging",
        label: "Messaging",
        description: "Verify your phone for resident texts and the SMS assistant.",
        icon: Smartphone,
      },
      {
        id: "preferences",
        label: "Preferences",
        description: "Appearance, assistant, and device options.",
        icon: SlidersHorizontal,
      },
      {
        id: "security",
        label: "Login & security",
        description: "Password and sign-in options.",
        icon: Lock,
      },
      {
        id: "feedback",
        label: "Feedback",
        description: "Report issues or share product feedback.",
        icon: MessageSquareText,
      },
      {
        id: "account",
        label: "Account",
        description: "Switch portals, sign out, or delete your resident account.",
        icon: Settings2,
      },
    ],
    [],
  );

  const rawTab = searchParams.get(SETTINGS_TAB_PARAM);
  const activeGroup = groups.find((g) => g.id === rawTab) ?? null;
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
  const skipInitialScroll = useRef(true);
  useEffect(() => {
    if (skipInitialScroll.current) {
      skipInitialScroll.current = false;
      return;
    }
    layoutTopRef.current?.scrollIntoView({ block: "start", behavior: "auto" });
  }, [activeGroup?.id]);

  const renderPane = (id: SettingsGroupId): ReactNode => {
    switch (id) {
      case "profile":
        return personalInfoSection;
      case "messaging":
        return (
          <PortalTextNotificationsBlock
            dataAttrPrefix="resident"
            demo={demo}
            description="Verify your mobile number to receive property updates and securely use the resident text assistant."
          />
        );
      case "preferences":
        return (
          <>
            <PortalSettingsSection title="Appearance" description="How PropLane looks on this device.">
              <PortalSettingsGroup>
                <PortalSettingsRow label="Theme" description="Choose light or dark mode.">
                  <ThemeToggle className="shrink-0" />
                </PortalSettingsRow>
              </PortalSettingsGroup>
            </PortalSettingsSection>
            <AssistantCustomInstructionsSetting role="resident" />
            <NotificationsToggle />
          </>
        );
      case "security":
        return <PortalChangePasswordPanel accountEmail={email} />;
      case "feedback":
        return <PortalBugFeedbackPanel reporterRole="resident" embedded />;
      case "account":
        return <PortalSettingsExtras currentKind="resident" variant="session" />;
    }
  };

  return (
    <ManagerPortalPageShell
      title="Settings"
      subtitle="Manage your account settings and preferences."
      hideTitleOnMobileNav
    >
      <div ref={layoutTopRef} className="lg:flex lg:items-start lg:gap-10">
        <PortalSettingsNav
          className="sticky top-0 max-lg:hidden"
          name={emptyToDash(name)}
          email={email}
          items={groups.map((g) => ({
            id: g.id,
            label: g.label,
            icon: <g.icon className="h-4 w-4" />,
          }))}
          activeId={paneGroup.id}
          onSelect={openGroup}
        />
        <div className="min-w-0 flex-1 lg:max-w-3xl">
          {activeGroup === null ? (
            <div className="space-y-5 lg:hidden">
              <PortalSettingsProfileHeader name={emptyToDash(name)} email={email} />
              <PortalSettingsGroup>
                {groups.map((g) => (
                  <PortalSettingsLinkRow
                    key={g.id}
                    icon={<g.icon className="h-4 w-4" />}
                    label={g.label}
                    description={g.description}
                    onClick={() => openGroup(g.id)}
                    dataAttr={`settings-open-${g.id}`}
                  />
                ))}
              </PortalSettingsGroup>
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
