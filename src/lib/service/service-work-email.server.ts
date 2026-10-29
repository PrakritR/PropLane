import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  firstNameOf,
  localFollowsBase,
  mailboxLocalIsDerivedFrom,
  serviceWorkspaceMailboxLocalFor,
} from "@/lib/manager-assistant-email/assistant-mailbox-local.server";
import {
  ensureManagerAssistantEmail,
  isAssistantEmailProvisioningEnabled,
  loadWorkspaceAssistantEmail,
  probeAssistantEmailStorageReady,
  setWorkspaceAssistantMailboxLocal,
} from "@/lib/manager-assistant-email/manager-assistant-email.server";
import { loadServiceWorkspace, type ServiceWorkspaceRow } from "@/lib/service/service-owner.server";

/**
 * The work email of a PropLane-managed (service) workspace.
 *
 * PropLane runs these workspaces, so the address is PropLane's own: it is minted when the workspace is added and is
 * NOT gated on the owner's communication entitlement. Named by the service rule (`ambikahomes@`), it follows a
 * rename of the workspace unless somebody customized it. Every function answers with a result instead of throwing:
 * a failed mint or follow is a warning for the caller to report, never a reason to fail creating or renaming.
 */
export type ServiceWorkEmailResult = {
  address: string | null;
  /** Set when the address could not be minted or followed; the workspace change itself still went through. */
  warning?: string;
  /** The address moved to a new local part (the old one is held as a 30-day alias). */
  changed?: boolean;
};

const MINT_FAILED = "The work email could not be set up yet.";

type Target = { id: string; ownerUserId: string; owned: true; isDefault: boolean; name: string };

const targetOf = (ws: ServiceWorkspaceRow): Target => ({
  id: ws.id,
  ownerUserId: ws.ownerUserId,
  owned: true,
  isDefault: ws.isDefault,
  name: ws.name,
});

async function ownerFirstName(db: SupabaseClient, ownerUserId: string): Promise<string> {
  const { data } = await db.from("profiles").select("full_name, email").eq("id", ownerUserId).maybeSingle();
  return firstNameOf(String(data?.full_name ?? "").trim(), String(data?.email ?? "").trim().toLowerCase());
}

async function provisioningReady(db: SupabaseClient): Promise<boolean> {
  return isAssistantEmailProvisioningEnabled() && (await probeAssistantEmailStorageReady(db));
}

/** Mint the workspace's address by the service rule if it has none; a workspace that has one keeps it. */
export async function mintServiceWorkspaceWorkEmail(db: SupabaseClient, workspaceId: string): Promise<ServiceWorkEmailResult> {
  try {
    const ws = await loadServiceWorkspace(db, workspaceId);
    if (!ws) return { address: null, warning: MINT_FAILED };
    if (!(await provisioningReady(db))) return { address: null, warning: MINT_FAILED };
    const row = await ensureManagerAssistantEmail(db, ws.ownerUserId, targetOf(ws), { service: true });
    return { address: row.address };
  } catch (cause) {
    console.warn("service-workspace work-email mint failed", cause instanceof Error ? cause.message : cause);
    return { address: null, warning: MINT_FAILED };
  }
}

/**
 * After a service workspace's name changed from `oldName`: mint the address if it has none; if it still follows the
 * naming rule for the old name (never customized) move it to the rule's local for the new name through the same set
 * path an owner uses (the old local is held as a 30-day alias); a customized address is left alone.
 */
export async function followServiceWorkspaceRename(
  db: SupabaseClient,
  workspaceId: string,
  oldName: string,
): Promise<ServiceWorkEmailResult> {
  try {
    const ws = await loadServiceWorkspace(db, workspaceId);
    if (!ws || !(await provisioningReady(db))) return { address: null, warning: MINT_FAILED };
    const target = targetOf(ws);
    const row = await loadWorkspaceAssistantEmail(db, target);
    if (!row) return await mintServiceWorkspaceWorkEmail(db, workspaceId);

    const first = await ownerFirstName(db, ws.ownerUserId);
    if (!mailboxLocalIsDerivedFrom(oldName, first, row.mailboxLocal)) return { address: row.address };
    const base = serviceWorkspaceMailboxLocalFor(ws.name, first);
    const current = row.mailboxLocal ?? "";
    if (!base || localFollowsBase(current, base)) return { address: row.address };

    for (const candidate of [base, ...Array.from({ length: 8 }, (_, i) => `${base}-${i + 2}`)]) {
      const set = await setWorkspaceAssistantMailboxLocal(db, ws.ownerUserId, target, candidate);
      if (set.ok) return { address: set.address, changed: set.address !== row.address };
      if (set.state !== "taken") break;
    }
    return { address: row.address, warning: "The work email could not follow the new name." };
  } catch (cause) {
    console.warn("service-workspace work-email follow failed", cause instanceof Error ? cause.message : cause);
    return { address: null, warning: "The work email could not follow the new name." };
  }
}

export type ServiceWorkEmailSetResult =
  | { ok: true; address: string }
  | { ok: false; status: number; error: string; state?: "invalid" | "reserved" | "taken" };

/** Staff changing the address by hand (the caller has already authorized and audited). */
export async function setServiceWorkspaceWorkEmailLocal(
  db: SupabaseClient,
  ws: ServiceWorkspaceRow,
  local: string,
): Promise<ServiceWorkEmailSetResult> {
  try {
    const target = targetOf(ws);
    // A workspace that somehow has none is named by the service rule first, so a later reader sees one rule.
    if (!(await loadWorkspaceAssistantEmail(db, target))) await ensureManagerAssistantEmail(db, ws.ownerUserId, target, { service: true });
    const set = await setWorkspaceAssistantMailboxLocal(db, ws.ownerUserId, target, local);
    if (set.ok) return { ok: true, address: set.address };
    return { ok: false, status: set.state === "taken" ? 409 : 400, error: set.message, state: set.state };
  } catch (cause) {
    console.warn("service-workspace work-email set failed", cause instanceof Error ? cause.message : cause);
    return { ok: false, status: 500, error: "Could not change the work email. Try again shortly." };
  }
}
