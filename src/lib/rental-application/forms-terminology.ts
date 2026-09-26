/**
 * Settings → Forms naming (C113). A manager can rename what "Application"
 * and "Lease" are called across the Forms page itself — e.g. "Intake form"
 * instead of "Application". Stored per workspace using the same generic
 * namespaced-settings store `workspace-application-form.ts` already uses
 * (`resolveSettingsScope` / `saveWorkspaceNamespaceSettings`), so this adds
 * no schema.
 *
 * Scope: this renames the labels Forms itself renders (section headings,
 * variant rows). It deliberately does NOT attempt to rewrite every other nav
 * label, tab heading, or notification body across the app — that is a much
 * larger, higher-risk propagation (dozens of call sites, some of them
 * outbound message copy) left for a follow-up once this naming control has
 * shipped and been used.
 */

export type FormsTerminology = {
  /** Custom label for "Application", or null to use the default. */
  applicationLabel: string | null;
  /** Custom label for "Lease", or null to use the default. */
  leaseLabel: string | null;
  updatedAt?: string;
};

export const DEFAULT_APPLICATION_TERM = "Application";
export const DEFAULT_LEASE_TERM = "Lease";

export function emptyFormsTerminology(): FormsTerminology {
  return { applicationLabel: null, leaseLabel: null };
}

function asLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 60) : null;
}

export function normalizeFormsTerminology(raw: unknown): FormsTerminology | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  return {
    applicationLabel: asLabel(o.applicationLabel),
    leaseLabel: asLabel(o.leaseLabel),
    updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : undefined,
  };
}

/** The label Forms should show for "Application", honoring a custom rename. */
export function applicationTerm(terminology: FormsTerminology | null | undefined): string {
  return terminology?.applicationLabel ?? DEFAULT_APPLICATION_TERM;
}

/** The label Forms should show for "Lease", honoring a custom rename. */
export function leaseTerm(terminology: FormsTerminology | null | undefined): string {
  return terminology?.leaseLabel ?? DEFAULT_LEASE_TERM;
}
