/**
 * Per-manager automation for the application → lease handoff.
 *
 * Three independent steps a manager can hand to PropLane, each off by default:
 *
 *   1. `autoApproveApplications`  — approve a submitted application without a manual click.
 *   2. `autoGenerateLease`        — build the lease document as soon as an application is approved.
 *   3. `autoSendLease`            — send that lease to the resident for signature.
 *
 * They form a ladder: sending needs a document, and generating needs an approval. A manager who
 * turns on only step 3 gets nothing until steps 1-2 happen some other way (a manual approve, a
 * manual generate), which is deliberate — each flag automates ONE step and never implies another.
 *
 * This is server-persisted rather than a localStorage preference like `dashboard-preferences.ts`.
 * Those are pure UI choices with no server consumer; this one decides whether money is charged and
 * a legal document is sent, so it must not be per-device — turning auto-approve on at a desk and
 * finding it off on a phone is the kind of surprise that approves the wrong applicant.
 *
 * It lives under `manager_automation_settings.row_data.applicationAutomation`, alongside
 * `applicationSettings` (see `manager-application-settings.ts`) and for the same reason: that
 * table always has a `row_data` JSON column, so this needs NO schema migration and cannot break on
 * a production project whose columns lag dev. Reads and writes merge into the existing blob rather
 * than replacing it, or saving automation would wipe the manager's application fee.
 *
 * AUTOMATION IS NOT AUTHORIZATION. Every gate that guards the manual path still runs on the
 * automated one: a withdrawn application is never approved, and a lease send still goes through
 * `leaseSendGateBlocker` (unapproved application, parties/terms mismatch, unreviewed uploaded
 * lease). These flags remove a click, never a check — see `shouldAutomate` below.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type ApplicationAutomationStep = "autoApproveApplications" | "autoGenerateLease" | "autoSendLease";

export const APPLICATION_AUTOMATION_STEPS: ApplicationAutomationStep[] = [
  "autoApproveApplications",
  "autoGenerateLease",
  "autoSendLease",
];

export type ApplicationAutomationPreferences = Record<ApplicationAutomationStep, boolean>;

/**
 * Everything off. A manager who has never opened the setting keeps the fully manual flow they
 * already have, so this feature can never change behaviour for someone who did not ask for it.
 */
export const DEFAULT_APPLICATION_AUTOMATION: ApplicationAutomationPreferences = {
  autoApproveApplications: false,
  autoGenerateLease: false,
  autoSendLease: false,
};

/**
 * Only a literal `true` enables a step. A stored `"true"`, `1`, or a missing row all read as off:
 * this is the direction where being wrong costs the least, because the failure is "the manager
 * still clicks Approve", not "an application nobody vetted was approved".
 */
export function normalizeApplicationAutomation(raw: unknown): ApplicationAutomationPreferences {
  const row = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out = { ...DEFAULT_APPLICATION_AUTOMATION };
  for (const step of APPLICATION_AUTOMATION_STEPS) {
    out[step] = row[step] === true;
  }
  return out;
}

/** Reasons an automated step is declined, in the order they are checked. */
export type AutomationBlockedReason =
  | "step_disabled"
  | "demo_mode"
  | "application_withdrawn"
  | "already_done"
  | "gate_blocked";

export type AutomationDecision =
  | { run: true }
  | { run: false; reason: AutomationBlockedReason; detail?: string };

/**
 * The ONE decision for whether an automated step may run.
 *
 * Ordering matters: the disabled check comes first so a manager who never enabled a step is never
 * told why it was skipped, and `gateBlocker` comes last so its message describes a real obstacle
 * rather than an option nobody turned on.
 *
 * `gateBlocker` is the caller's existing manual-path guard — `leaseSendGateBlocker` for a send.
 * Passing it is how this stays a click-remover: if the button would have refused, so does the
 * automation, with the same message.
 */
export function shouldAutomate(input: {
  enabled: boolean;
  isDemo?: boolean;
  isWithdrawn?: boolean;
  alreadyDone?: boolean;
  gateBlocker?: string | null;
}): AutomationDecision {
  if (!input.enabled) return { run: false, reason: "step_disabled" };
  // /demo must never write a real row, and an automation that fires there would do exactly that.
  if (input.isDemo) return { run: false, reason: "demo_mode" };
  if (input.isWithdrawn) return { run: false, reason: "application_withdrawn" };
  // Re-running a step would regenerate a document a resident may already have signed, or send a
  // second copy of a lease that is already out.
  if (input.alreadyDone) return { run: false, reason: "already_done" };
  const blocker = input.gateBlocker?.trim();
  if (blocker) return { run: false, reason: "gate_blocked", detail: blocker };
  return { run: true };
}

const ROW_DATA_KEY = "applicationAutomation";

export async function loadApplicationAutomation(
  db: SupabaseClient,
  managerUserId: string,
): Promise<ApplicationAutomationPreferences> {
  const { data, error } = await db
    .from("manager_automation_settings")
    .select("row_data")
    .eq("manager_user_id", managerUserId)
    .maybeSingle();
  if (error) throw error;
  return normalizeApplicationAutomation(
    (data?.row_data as Record<string, unknown> | null)?.[ROW_DATA_KEY],
  );
}

export async function saveApplicationAutomation(
  db: SupabaseClient,
  managerUserId: string,
  prefs: unknown,
): Promise<ApplicationAutomationPreferences> {
  const normalized = normalizeApplicationAutomation(prefs);
  // Read-modify-write the shared blob. Writing `{ [ROW_DATA_KEY]: … }` alone would drop
  // `applicationSettings`, taking the manager's application fee with it.
  const { data: existing } = await db
    .from("manager_automation_settings")
    .select("row_data")
    .eq("manager_user_id", managerUserId)
    .maybeSingle();
  const rowData =
    existing?.row_data && typeof existing.row_data === "object" && !Array.isArray(existing.row_data)
      ? { ...(existing.row_data as Record<string, unknown>) }
      : {};
  rowData[ROW_DATA_KEY] = normalized;
  const { error } = await db.from("manager_automation_settings").upsert(
    {
      manager_user_id: managerUserId,
      row_data: rowData,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "manager_user_id" },
  );
  if (error) throw error;
  return normalized;
}
