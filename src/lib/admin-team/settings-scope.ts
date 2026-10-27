/**
 * The one admin Settings page has a scope dropdown at the top of its nav (plan admin-team-1027, A7): PropLane (the viewer's
 * own panes and the PropLane-wide ones, Overall admins only) and each PropLane Service workspace the viewer can open.
 * Pure: the switcher, the profile client and the tests share these decisions.
 */
export type SettingsScope = {
  /** Overall admin: PropLane is a scope, and the PropLane-wide panes (Admin team) exist. */
  overall: boolean;
  /** Every service workspace the viewer can open (the rail's tiles). */
  workspaces: { id: string; name: string; city: string | null }[];
  /** The workspace Settings is showing now; null = the PropLane scope. */
  currentWorkspaceId: string | null;
};

export const PROPLANE_SCOPE_VALUE = "proplane";

export function settingsScopeOptions(scope: SettingsScope): { value: string; label: string }[] {
  return [
    ...(scope.overall ? [{ value: PROPLANE_SCOPE_VALUE, label: "PropLane" }] : []),
    ...scope.workspaces.map((w) => ({ value: w.id, label: w.city ? `${w.name} · ${w.city}` : w.name })),
  ];
}

export function settingsScopeValue(scope: SettingsScope): string {
  return scope.currentWorkspaceId ?? PROPLANE_SCOPE_VALUE;
}

export type SettingsScopeTarget =
  | { kind: "stay" }
  | { kind: "proplane"; href: string }
  | { kind: "workspace"; workspaceId: string; href: string };

/** Where choosing `next` goes. A workspace is opened (the cookie is set by the authorized open) and Settings stays on screen. */
export function settingsScopeTarget(scope: SettingsScope, next: string): SettingsScopeTarget {
  if (next === settingsScopeValue(scope)) return { kind: "stay" };
  if (next === PROPLANE_SCOPE_VALUE) return scope.overall ? { kind: "proplane", href: "/admin/profile?tab=profile" } : { kind: "stay" };
  if (!scope.workspaces.some((w) => w.id === next)) return { kind: "stay" };
  return { kind: "workspace", workspaceId: next, href: "/portal/profile?tab=workspaces" };
}

/** In a workspace scope an Overall admin's own account panes live under PropLane, so the workspace nav leaves them out. */
export const ACCOUNT_PANE_IDS_IN_PROPLANE_SCOPE = ["profile", "security", "account"] as const;
