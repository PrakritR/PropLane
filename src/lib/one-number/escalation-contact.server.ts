import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadSharedLineConfig, workspaceHasDedicatedNumber } from "@/lib/one-number/config.server";
import { defaultWorkspaceIdFor } from "@/lib/one-number/knowledge/scope.server";
import { readServiceManagerSettings } from "@/lib/service/service-manager.server";
import { resolveSettingsScope, saveWorkspaceNamespaceSettings } from "@/lib/settings/scope-resolver.server";
import { normalizeE164 } from "@/lib/phone-e164";
import {
  formatEscalationContactLine,
  formatUsPhoneDisplay,
  normalizeEscalationContactSettings,
  type EscalationContactSettings,
} from "./escalation-contact";

/** The name a managed home's contact line uses: the operator is the PropLane team, not a person the texter knows. */
export const MANAGED_CONTACT_NAME = "the PropLane team";

export type EscalationContact = {
  /** The one sentence appended to an escalation reply, or null (disabled, no verified phone, unresolved). */
  line: string | null;
  /** "managed" = the operator's phone, "self_serve" = the workspace owner's verified phone. */
  kind: "managed" | "self_serve";
  workspaceId: string | null;
  enabled: boolean;
  /** The number the setting would share, formatted, even when the toggle is off. Null when there is none to share. */
  phoneDisplay: string | null;
};

type Row = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

export async function loadEscalationContactSettings(db: SupabaseClient, ownerUserId: string, workspaceId: string): Promise<EscalationContactSettings> {
  try {
    const resolved = await resolveSettingsScope<EscalationContactSettings>(
      db,
      { managerUserId: ownerUserId, workspaceId },
      "escalationContact",
      { normalize: normalizeEscalationContactSettings },
    );
    return resolved.value;
  } catch {
    // An unreadable setting must not turn the line on for a manager who may have turned it off.
    return { enabled: false, explicit: false };
  }
}

export async function saveEscalationContactEnabled(db: SupabaseClient, workspaceId: string, ownerUserId: string, enabled: boolean): Promise<void> {
  await saveWorkspaceNamespaceSettings(db, workspaceId, ownerUserId, "escalationContact", { enabled });
}

/**
 * A manager's own verified phone: the profile phone with `phone_verified_at`, held by exactly one account. A typed, unverified
 * number is never shared, and a number several accounts hold (test profiles) is nobody's. Returns null for any unclear read.
 */
export async function loadVerifiedManagerPhone(db: SupabaseClient, userId: string): Promise<{ phone: string; firstName: string | null } | null> {
  try {
    const { data, error } = await db.from("profiles").select("phone, phone_verified_at, full_name").eq("id", userId).maybeSingle();
    if (error || !data) return null;
    const row = data as Row;
    const phone = normalizeE164(str(row.phone));
    if (!phone || !row.phone_verified_at) return null;
    const { data: holders, error: holdersError } = await db.from("profiles").select("id").eq("phone", phone).not("phone_verified_at", "is", null).limit(2);
    if (holdersError || (holders ?? []).length !== 1) return null;
    return { phone, firstName: str(row.full_name).split(/\s+/)[0] || null };
  } catch {
    return null;
  }
}

/**
 * Who a texter should text when the assistant cannot answer, resolved from the house / workspace the conversation is about.
 * Nothing here comes from the model or the message. The caller passes the owner of the line the turn ran on and, when it knows
 * it, the home or workspace; a shared line with no home resolves to nobody (`sharedLineWithoutHome`), and the per_workspace
 * PropLane line (every home on it is PropLane-managed) with no home resolves to the operator (`serviceLineWithoutHome`).
 *
 *  - PropLane-managed (`is_service`, or the platform service owner) workspace: the operator's verified escalation phone
 *    (`platform_service_settings.manager_phone_e164` + `manager_phone_verified_at`).
 *  - Self-serve workspace: the owner's verified profile phone, only while the workspace toggle is on (default on).
 *  - A self-serve home on the shared line in per_workspace mode (unpaid: the line points it at its manager's paid number or
 *    the pricing page) shares nothing unless the manager explicitly turned the toggle on.
 */
export async function resolveEscalationContact(
  db: SupabaseClient,
  args: { ownerUserId: string; workspaceId?: string | null; propertyId?: string | null; sharedLineWithoutHome?: boolean; serviceLineWithoutHome?: boolean; onPropLaneLine?: boolean },
): Promise<EscalationContact> {
  const none = (kind: EscalationContact["kind"] = "self_serve", workspaceId: string | null = null, enabled = false, phoneDisplay: string | null = null): EscalationContact => ({
    line: null,
    kind,
    workspaceId,
    enabled,
    phoneDisplay,
  });
  let configPromise: ReturnType<typeof loadSharedLineConfig> | null = null;
  const lineConfig = () => (configPromise ??= loadSharedLineConfig(db));
  try {
    let workspaceId = str(args.workspaceId) || null;
    if (!workspaceId && args.propertyId) {
      const { data } = await db.from("manager_property_records").select("workspace_id").eq("id", args.propertyId).maybeSingle();
      workspaceId = str((data as Row | null)?.workspace_id) || null;
    }
    const service = await readServiceManagerSettings(db).catch(() => null);
    const ownerIsServiceOwner = Boolean(service && service.ownerUserId === args.ownerUserId);
    // The cross-catalog shared line with no home chosen: whose home is unknown, so nobody's phone is shared.
    if (!workspaceId && args.sharedLineWithoutHome) return none();
    const assumeManaged = !workspaceId && Boolean(args.serviceLineWithoutHome) && ownerIsServiceOwner;
    if (!workspaceId) workspaceId = await defaultWorkspaceIdFor(db, args.ownerUserId);
    if (!workspaceId) return none();

    const { data: ws } = await db.from("portal_workspaces").select("id, owner_user_id, is_service").eq("id", workspaceId).maybeSingle();
    const workspace = ws as Row | null;
    if (!workspace) return none("self_serve", workspaceId);
    const ownerUserId = str(workspace.owner_user_id) || args.ownerUserId;
    const managed = workspace.is_service === true || assumeManaged;

    const settings = await loadEscalationContactSettings(db, ownerUserId, workspaceId);
    if (managed) {
      const phone = service?.phoneE164 && service.verifiedAt ? service.phoneE164 : null;
      const display = formatUsPhoneDisplay(phone);
      const line = settings.enabled ? formatEscalationContactLine(MANAGED_CONTACT_NAME, phone) : null;
      return { line, kind: "managed", workspaceId, enabled: settings.enabled, phoneDisplay: display };
    }

    const manager = await loadVerifiedManagerPhone(db, ownerUserId);
    const display = formatUsPhoneDisplay(manager?.phone);
    if (!settings.enabled || !manager) return none("self_serve", workspaceId, settings.enabled, display);

    // Unpaid self-serve on the PropLane line in per_workspace mode keeps the "nothing about the home disclosed" rule:
    // only the manager's explicit ON shares their phone there. In shared mode, or on a number of their own, the default applies.
    if (args.onPropLaneLine && !settings.explicit && !workspaceHasDedicatedNumber(await lineConfig(), workspaceId)) {
      if ((await lineConfig()).mode === "per_workspace") return none("self_serve", workspaceId, settings.enabled, display);
    }
    const line = formatEscalationContactLine(manager.firstName ?? "your manager", manager.phone);
    return { line, kind: "self_serve", workspaceId, enabled: true, phoneDisplay: display };
  } catch {
    return none();
  }
}

export async function escalationContactLine(
  db: SupabaseClient,
  args: Parameters<typeof resolveEscalationContact>[1],
): Promise<string | null> {
  return (await resolveEscalationContact(db, args)).line;
}
