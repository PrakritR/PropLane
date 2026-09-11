import type { PortalDefinition } from "@/lib/portal-types";

export type PortalMobileBackTarget = {
  href: string;
  label: string;
};

/** Native app uses a fixed bottom bar for Dashboard — no chevron back to it. */
function suppressDashboardBackOnNative(target: PortalMobileBackTarget | null): PortalMobileBackTarget | null {
  if (!target) return null;
  if (typeof document === "undefined" || !document.documentElement.hasAttribute("data-native")) {
    return target;
  }
  if (target.label === "Dashboard" || /\/dashboard$/.test(target.href)) return null;
  return target;
}

/** Splits pathname into section parts once the portal's basePath prefix matches, else null. */
function portalSectionParts(pathname: string, definition: PortalDefinition): string[] | null {
  const baseParts = definition.basePath.split("/").filter(Boolean);
  const parts = pathname.split("/").filter(Boolean);

  if (parts.length < baseParts.length + 1) return null;
  for (let i = 0; i < baseParts.length; i += 1) {
    if (parts[i] !== baseParts[i]) return null;
  }
  return parts.slice(baseParts.length);
}

/** Resident / manager mobile back: dashboard from sections; first tab from deeper inbox tabs. */
export function resolvePortalMobileBackTarget(
  pathname: string,
  definition: PortalDefinition,
  searchParams?: Pick<URLSearchParams, "get"> | null,
): PortalMobileBackTarget | null {
  const sectionParts = portalSectionParts(pathname, definition);
  if (!sectionParts) return null;

  const section = sectionParts[0];
  if (!section || section === "dashboard") return null;

  if (section === "applications" && sectionParts[1] === "apply") {
    // An ABSENT `wizardStep` on the apply path means step 1, the wizard's own
    // starting step — not "unknown". The wizard used to stamp `?wizardStep=1`
    // into the URL on first mount purely so this read would see it, and that
    // write cost a server round-trip and a visible skeleton frame every time a
    // resident opened an application link. The write is gone; the default lives
    // here instead, so the dashboard back action stays hidden on step 1 exactly
    // as it did before.
    const raw = searchParams?.get("wizardStep")?.trim();
    const wizardStep = raw ? Number(raw) : 1;
    if (wizardStep >= 1 && wizardStep <= 3) return null;
  }

  const meta = definition.sections.find((entry) => entry.section === section);
  const tabId = sectionParts[1];
  const firstTabId = meta?.tabs[0]?.id;

  if (section === "communication") {
    const channel = tabId;
    const folder = sectionParts[2];
    if ((channel === "inbox" || channel === "email") && folder && folder !== "unopened") {
      return {
        href: `${definition.basePath}/communication/${channel}/unopened`,
        label: meta?.label ?? section,
      };
    }
    if (channel === "sms" && folder && folder !== "all" && folder !== "unopened") {
      return {
        href: `${definition.basePath}/communication/sms/all`,
        label: meta?.label ?? section,
      };
    }
    if (channel === "inbox" || channel === "email" || channel === "sms") {
      return null;
    }
  }

  if (tabId && firstTabId && tabId !== firstTabId) {
    // Alternate section tab (e.g. Previous residents) — dropdown handles navigation.
    return null;
  }

  if (!tabId) {
    return null;
  }

  if (firstTabId && tabId === firstTabId) {
    return null;
  }

  const isDeclaredTab = meta?.tabs.some((entry) => entry.id === tabId) ?? false;
  if (firstTabId && isDeclaredTab) {
    return null;
  }

  const dashboard = definition.sections.find((entry) => entry.section === "dashboard");
  return suppressDashboardBackOnNative({
    href: `${definition.basePath}/dashboard`,
    label: dashboard?.label ?? "Dashboard",
  });
}

export function portalDashboardMobileHeaderLabel(pathname: string, definition: PortalDefinition): string | null {
  const sectionParts = portalSectionParts(pathname, definition);
  if (!sectionParts || sectionParts[0] !== "dashboard") return null;
  return definition.sections.find((entry) => entry.section === "dashboard")?.label ?? "Dashboard";
}

export function portalMobileActiveSectionLabel(pathname: string, definition: PortalDefinition): string | null {
  const sectionParts = portalSectionParts(pathname, definition);
  if (!sectionParts?.[0] || sectionParts[0] === "dashboard") return null;
  const section = sectionParts[0];
  return definition.sections.find((entry) => entry.section === section)?.label ?? section;
}
