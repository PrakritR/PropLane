/**
 * Settings → Forms' lease clause template (C113) — a workspace-wide list of
 * named clauses a manager authors once, with `{variable}` placeholders a
 * live preview fills with sample data. Net-new: no clause-body template like
 * this exists anywhere in the product today (the per-property lease editor
 * — `pro-property-lease-panel.tsx` / `pro-lease-questions-editor-modal.tsx`
 * — edits signing QUESTIONS, never clause prose).
 *
 * Stored the same way `workspace-application-form.ts` is: a namespaced,
 * per-workspace JSON blob via `resolveSettingsScope` /
 * `saveWorkspaceNamespaceSettings` — no migration, no new column.
 */

export type LeaseClauseTemplateEntry = {
  id: string;
  title: string;
  body: string;
};

export type WorkspaceLeaseClauseTemplate = {
  clauses: LeaseClauseTemplateEntry[];
  updatedAt?: string;
};

/** `{key}` chips the clause editor offers and the live preview fills in. */
export const LEASE_TEMPLATE_VARIABLES: readonly { key: string; label: string; sample: string }[] = [
  { key: "tenantFullName", label: "Tenant name", sample: "Jordan Rivera" },
  { key: "landlordName", label: "Landlord name", sample: "Axis Housing LLC" },
  { key: "propertyAddress", label: "Property address", sample: "5257 Brooklyn Ave, Unit 3" },
  { key: "leaseStartDate", label: "Lease start date", sample: "June 1, 2026" },
  { key: "leaseEndDate", label: "Lease end date", sample: "May 31, 2027" },
  { key: "rentAmount", label: "Monthly rent", sample: "$2,150.00" },
  { key: "securityDeposit", label: "Security deposit", sample: "$2,150.00" },
];

export function emptyWorkspaceLeaseClauseTemplate(): WorkspaceLeaseClauseTemplate {
  return { clauses: [] };
}

function asClause(raw: unknown): LeaseClauseTemplateEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === "string" && o.id.trim() ? o.id : null;
  if (!id) return null;
  return {
    id,
    title: typeof o.title === "string" ? o.title.slice(0, 200) : "",
    body: typeof o.body === "string" ? o.body.slice(0, 20000) : "",
  };
}

export function normalizeWorkspaceLeaseClauseTemplate(raw: unknown): WorkspaceLeaseClauseTemplate | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const clauses = Array.isArray(o.clauses)
    ? o.clauses.map(asClause).filter((c): c is LeaseClauseTemplateEntry => c !== null)
    : [];
  return {
    clauses,
    updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : undefined,
  };
}

/** Fill every `{variable}` in a clause body with its sample value, for the live preview. */
export function fillClauseSample(body: string): string {
  let out = body;
  for (const variable of LEASE_TEMPLATE_VARIABLES) {
    out = out.split(`{${variable.key}}`).join(variable.sample);
  }
  return out;
}

export function newLeaseClauseEntry(id: string): LeaseClauseTemplateEntry {
  return { id, title: "New clause", body: "" };
}
