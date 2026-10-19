"use client";

import { Users } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { portalDashboardPath, type AuthRole } from "@/components/auth/portal-switcher";
import { portalSwitchTargets, type PortalSwitchTarget } from "@/lib/portal-switch-targets";
import type { PortalKind } from "@/lib/portal-types";

export function PortalRoleSwitcher({
  currentKind,
  asSettingsRow = false,
  onSwitched,
}: {
  currentKind: PortalKind;
  /**
   * Wrap the switcher in the Settings card's row chrome. Opt-in because the
   * dropdown-menu call sites (top bar, mobile nav bar) supply their own
   * padding and must stay aligned with their sibling menu items.
   */
  asSettingsRow?: boolean;
  /** A menu host closes itself when a switch is chosen (the row is not a menu item, so nothing else would). */
  onSwitched?: () => void;
}) {
  const router = useRouter();
  const [targets, setTargets] = useState<PortalSwitchTarget[]>([]);
  const [busyRole, setBusyRole] = useState<AuthRole | null>(null);

  useEffect(() => {
    void fetch("/api/auth/portal-roles", { credentials: "include" })
      .then(async (res) => {
        if (!res.ok) return;
        const body = (await res.json()) as { roles?: AuthRole[]; reachableRoles?: AuthRole[] };
        const roles = body.reachableRoles ?? body.roles ?? [];
        setTargets(portalSwitchTargets(currentKind, roles));
      })
      .catch(() => {});
  }, [currentKind]);

  // Renders nothing (not even the settings row wrapper) for single-portal
  // accounts, so the Account card never shows an empty padded strip.
  if (!targets.length) return null;

  const switchPortal = async (role: AuthRole) => {
    setBusyRole(role);
    try {
      const res = await fetch("/api/auth/set-active-portal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      });
      if (!res.ok) return;
      router.push(portalDashboardPath(role));
      router.refresh();
    } catch {
      /* ignore */
    } finally {
      setBusyRole(null);
    }
  };

  const buttons = targets.map((target) => (
    <button
      key={target.role}
      type="button"
      onClick={() => {
        onSwitched?.();
        void switchPortal(target.role);
      }}
      disabled={busyRole !== null}
      className={
        asSettingsRow
          ? "flex min-h-12 w-full items-center gap-3 px-4 text-left text-[15px] text-foreground transition hover:bg-accent/40 disabled:opacity-50"
          : // In a dropdown menu it is a sibling of Settings: the same row metrics as
            // `DropdownMenuItem`, so icon, indent and type line up with it.
            "flex min-h-11 w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-[13.5px] font-medium text-foreground outline-none transition hover:bg-accent/70 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 lg:min-h-0 lg:rounded-[var(--radius-control)] lg:px-[9px] lg:py-[7px] lg:text-[14px] lg:font-normal"
      }
    >
      <Users aria-hidden className={asSettingsRow ? "h-[18px] w-[18px] text-muted" : "h-[16px] w-[16px] shrink-0 text-muted"} />
      {busyRole === target.role ? "Switching…" : target.label}
    </button>
  ));

  if (!asSettingsRow) return <>{buttons}</>;

  return <div className="border-b border-border last:border-0">{buttons}</div>;
}
