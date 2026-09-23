"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { portalDashboardPath, type AuthRole } from "@/components/auth/portal-switcher";
import { portalSwitchTargets, type PortalSwitchTarget } from "@/lib/portal-switch-targets";
import type { PortalKind } from "@/lib/portal-types";

export function PortalRoleSwitcher({
  currentKind,
  asSettingsRow = false,
}: {
  currentKind: PortalKind;
  /**
   * Wrap the switcher in the Settings card's row chrome. Opt-in because the
   * dropdown-menu call sites (top bar, mobile nav bar) supply their own
   * padding and must stay aligned with their sibling menu items.
   */
  asSettingsRow?: boolean;
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
      onClick={() => void switchPortal(target.role)}
      disabled={busyRole !== null}
      className="flex w-full items-center gap-2 rounded-2xl px-3 py-2.5 text-left text-sm font-medium text-muted transition hover:bg-card hover:text-foreground disabled:opacity-50"
    >
      <span className="text-base leading-none" aria-hidden>
        ⇄
      </span>
      {busyRole === target.role ? "Switching…" : target.label}
    </button>
  ));

  if (!asSettingsRow) return <>{buttons}</>;

  return <div className="border-b border-border px-4 py-3.5 last:border-0">{buttons}</div>;
}
