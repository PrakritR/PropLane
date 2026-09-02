import type { AgentContext } from "@/lib/tools/context";

/**
 * How a manager-SMS turn is scoped. The work-number owner is always the
 * data/sender boundary; the verified texter is the actor.
 *
 * - `owner`: texter owns this work number and has no incoming co-manager
 *   assignments. Full owned portfolio, same as before.
 * - `combined`: texter owns this work number AND co-manages other houses.
 *   Owned properties stay unrestricted; assigned co-managed properties join
 *   the read set. Writes against another owner's row still fail closed unless
 *   that row is loaded under the other owner.
 * - `delegated`: texter is a co-manager of THIS work-number owner. Only that
 *   owner's assigned properties. The texter's personally owned houses are
 *   excluded.
 */
export type ManagerSmsAccessMode = "owner" | "combined" | "delegated";

export type ManagerSmsAccess = {
  mode: ManagerSmsAccessMode;
  workNumberOwnerId: string;
  actorUserId: string;
  /** Landlord ids whose rows may be read this turn. */
  dataOwnerIds: string[];
  /** Assigned co-managed property ids in this turn. Empty for unrestricted owner. */
  assignedPropertyIds: string[];
};

/** Landlord ids to query for manager-scoped tables. */
export function smsDataOwnerIds(ctx: Pick<AgentContext, "landlordId" | "managerSmsAccess">): string[] {
  const extra = ctx.managerSmsAccess?.dataOwnerIds ?? [];
  const ids = [ctx.landlordId, ...extra]
    .map((id) => id.trim())
    .filter(Boolean);
  return [...new Set(ids)];
}

export function propertyIdFromToolRow(rowData: unknown): string | null {
  if (!rowData || typeof rowData !== "object") return null;
  const row = rowData as Record<string, unknown>;
  for (const key of ["propertyId", "property_id", "assignedPropertyId"]) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const application = row.application;
  if (application && typeof application === "object") {
    const value = (application as Record<string, unknown>).propertyId;
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/**
 * Owner-keyed tables have no trustworthy property id. On a delegated turn they
 * stay visible when the module is granted on at least one assigned property
 * (same rule as `linkedOwnerScopeForModule`). Everything else without a
 * property id is hidden, so an unattributed row cannot leak across houses.
 */
const OWNER_KEYED_TABLES = new Set(["manager_vendor_records"]);

export function smsAccessAllowsRow(
  access: ManagerSmsAccess | null | undefined,
  args: { dataOwnerId: string; rowData: unknown; table: string },
): boolean {
  if (!access || access.mode === "owner") return true;
  const assigned = new Set(access.assignedPropertyIds);
  const propertyId = propertyIdFromToolRow(args.rowData);
  if (access.mode === "combined") {
    if (args.dataOwnerId === access.actorUserId) return true;
    if (!propertyId) return false;
    return assigned.has(propertyId);
  }
  if (args.dataOwnerId !== access.workNumberOwnerId) return false;
  if (!propertyId) return OWNER_KEYED_TABLES.has(args.table);
  return assigned.has(propertyId);
}

export function smsAccessAllowsProperty(
  access: ManagerSmsAccess | null | undefined,
  args: { propertyId: string; recordOwnerId: string; actorUserId: string },
): boolean {
  if (!access || access.mode === "owner") return args.recordOwnerId === args.actorUserId;
  if (access.mode === "combined") {
    if (args.recordOwnerId === access.actorUserId) return true;
    return (
      access.assignedPropertyIds.includes(args.propertyId) &&
      access.dataOwnerIds.includes(args.recordOwnerId)
    );
  }
  return (
    args.recordOwnerId === access.workNumberOwnerId &&
    access.assignedPropertyIds.includes(args.propertyId)
  );
}

export function smsAccessAllowsPropertyRecord(
  ctx: Pick<AgentContext, "landlordId" | "userId" | "managerSmsAccess">,
  rec: { id: string; manager_user_id?: string | null },
): boolean {
  const recordOwnerId = String(rec.manager_user_id ?? "").trim();
  const access = ctx.managerSmsAccess;
  if (!access) return recordOwnerId === ctx.landlordId;
  return smsAccessAllowsProperty(access, {
    propertyId: rec.id,
    recordOwnerId,
    actorUserId: ctx.userId,
  });
}

/** Tools that are landlord-wide and cannot be property-filtered. */
export const DELEGATED_SMS_UNSCOPED_TOOLS = [
  "run_financial_report",
  "get_dashboard_summary",
  "get_automation_settings",
  "update_automation_settings",
  "list_co_managers",
  "get_manager_profile",
  "record_expense",
  "record_income",
  "list_calendar_events",
  "update_manager_availability",
  "create_calendar_event",
] as const;

export function delegatedSmsWithholdsTool(toolName: string): boolean {
  return (DELEGATED_SMS_UNSCOPED_TOOLS as readonly string[]).includes(toolName);
}

export function managerSmsScopePrompt(access: ManagerSmsAccess): string {
  if (access.mode === "delegated") {
    return [
      "This text is on another manager's PropLane number. Answer only about the houses they assigned to you.",
      "Do not mention or act on houses you personally own or houses from any other owner.",
      "If a tool returns nothing, say you cannot see that from this number.",
    ].join(" ");
  }
  if (access.mode === "combined") {
    return [
      "You can answer about houses you own and houses you co-manage.",
      "Changes to a co-managed house that belongs to another owner are only available when that house is in the tool results.",
    ].join(" ");
  }
  return "";
}
