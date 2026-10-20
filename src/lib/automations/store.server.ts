import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingSchemaError } from "@/lib/one-number/config.server";
import {
  effectiveAutomationMode,
  getAutomationPreset,
  type AutomationMode,
  type AutomationPreset,
  type AutomationPresetId,
} from "./presets";

/**
 * Settings and the run ledger. Every read treats a missing table or column (42P01 / 42703 /
 * PGRST205: prod runs code before migrations) as "nothing there", so a workspace with no rows keeps
 * every preset's default and the product behaves exactly as before.
 */

export type SavedAutomation = { mode: AutomationMode; template: string | null };

export async function loadAutomationSettings(
  db: SupabaseClient,
  workspaceId: string,
): Promise<Map<AutomationPresetId, SavedAutomation>> {
  const out = new Map<AutomationPresetId, SavedAutomation>();
  try {
    const { data, error } = await db
      .from("workspace_automation_presets")
      .select("preset, mode, template")
      .eq("workspace_id", workspaceId);
    if (error) return out;
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const preset = getAutomationPreset(String(row.preset));
      const mode = row.mode;
      if (!preset || (mode !== "auto" && mode !== "draft" && mode !== "off")) continue;
      out.set(preset.id, { mode, template: typeof row.template === "string" && row.template.trim() ? row.template : null });
    }
  } catch {
    /* nothing there */
  }
  return out;
}

/** Workspaces that have picked a mode for at least one preset: the ones the sweep serves off the shared line. */
export async function loadOptedInWorkspaces(db: SupabaseClient): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const { data, error } = await db.from("workspace_automation_presets").select("workspace_id").limit(5000);
    if (error) return out;
    for (const row of (data ?? []) as Array<{ workspace_id: string }>) out.add(String(row.workspace_id));
  } catch {
    /* nothing there */
  }
  return out;
}

export type ResolvedAutomation = { preset: AutomationPreset; mode: AutomationMode; template: string };

export function resolveAutomation(
  preset: AutomationPreset,
  saved: SavedAutomation | undefined,
): ResolvedAutomation {
  return {
    preset,
    mode: effectiveAutomationMode(preset, saved?.mode),
    template: saved?.template?.trim() || preset.template,
  };
}

export type SaveAutomationResult = { ok: true } | { ok: false; code: string; message: string };

/**
 * Write a pick. A failed write is NEVER swallowed: the Postgres / PostgREST error code is logged and
 * returned, so a missing table or column (42P01 / 42703 / PGRST205) surfaces as a save that says
 * why instead of a preset that silently never saves.
 */
export async function saveAutomationSetting(
  db: SupabaseClient,
  input: {
    workspaceId: string;
    preset: AutomationPresetId;
    mode: AutomationMode;
    /** undefined = keep, null = back to the default wording. */
    template?: string | null;
    userId: string;
  },
): Promise<SaveAutomationResult> {
  try {
    const existing = await loadAutomationSettings(db, input.workspaceId);
    const prior = existing.get(input.preset);
    const template = input.template === undefined ? (prior?.template ?? null) : input.template;
    const { error } = await db.from("workspace_automation_presets").upsert(
      {
        workspace_id: input.workspaceId,
        preset: input.preset,
        mode: input.mode,
        template,
        updated_by: input.userId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "workspace_id,preset" },
    );
    if (error) {
      const code = String((error as { code?: string | null }).code ?? "unknown");
      const message = String((error as { message?: string | null }).message ?? "");
      console.error("[automations] save failed", { table: "workspace_automation_presets", code, message, workspaceId: input.workspaceId, preset: input.preset });
      return { ok: false, code, message };
    }
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[automations] save threw", { table: "workspace_automation_presets", message, workspaceId: input.workspaceId, preset: input.preset });
    return { ok: false, code: "exception", message };
  }
}

/* ─────────────────────────────  the run ledger  ───────────────────────────── */

export type RunClaim = {
  workspaceId: string;
  ownerUserId: string;
  preset: AutomationPresetId;
  idempotencyKey: string;
  audience: "resident" | "group";
  mode: "auto" | "draft";
  propertyId?: string | null;
  phoneKey?: string | null;
  body?: string | null;
};

/**
 * Claim the moment. The unique (workspace, key) is the idempotency: the second sweep, a retry and a
 * concurrent tick all lose the insert. Returns the run id, or null when the moment was already
 * handled (or the ledger is unavailable, in which case nothing is sent: a send we cannot record
 * could repeat every five minutes).
 */
export async function claimRun(db: SupabaseClient, claim: RunClaim): Promise<string | null> {
  try {
    const { data, error } = await db
      .from("workspace_automation_runs")
      .insert({
        workspace_id: claim.workspaceId,
        owner_user_id: claim.ownerUserId,
        preset: claim.preset,
        idempotency_key: claim.idempotencyKey,
        audience: claim.audience,
        status: "sending",
        mode: claim.mode,
        property_id: claim.propertyId ?? null,
        phone_key: claim.phoneKey ?? null,
        body: claim.body ?? null,
      })
      .select("id")
      .maybeSingle();
    if (error || !data) return null;
    return String((data as Record<string, unknown>).id);
  } catch {
    return null;
  }
}

export async function finishRun(
  db: SupabaseClient,
  runId: string,
  patch: { status: "sent" | "held" | "dismissed" | "skipped" | "failed"; reason?: string | null; draftId?: string | null; body?: string | null },
): Promise<void> {
  try {
    await db
      .from("workspace_automation_runs")
      .update({
        status: patch.status,
        reason: patch.reason ?? null,
        ...(patch.draftId ? { draft_id: patch.draftId } : {}),
        ...(patch.body !== undefined ? { body: patch.body } : {}),
        ...(patch.status === "held" ? {} : { decided_at: new Date().toISOString() }),
      })
      .eq("id", runId);
  } catch {
    /* the send already happened; a ledger miss must not throw into the sweep */
  }
}

/** Give the moment back (a quiet-hours or budget refusal): the next sweep tries again. */
export async function releaseRun(db: SupabaseClient, runId: string): Promise<void> {
  try {
    await db.from("workspace_automation_runs").delete().eq("id", runId).eq("status", "sending");
  } catch {
    /* a stuck 'sending' row is reaped by reapStuckRuns */
  }
}

/** A run left 'sending' by a crashed tick is released after ten minutes so its moment can fire. */
export async function reapStuckRuns(db: SupabaseClient, now: Date = new Date()): Promise<void> {
  try {
    await db
      .from("workspace_automation_runs")
      .delete()
      .eq("status", "sending")
      .lt("created_at", new Date(now.getTime() - 10 * 60_000).toISOString());
  } catch {
    /* best effort */
  }
}

export type HeldRun = {
  id: string;
  preset: AutomationPresetId;
  audience: "resident" | "group";
  propertyId: string | null;
  phoneKey: string | null;
  body: string;
  createdAt: string;
  draftId: string | null;
};

export async function listHeldRuns(db: SupabaseClient, workspaceId: string): Promise<HeldRun[]> {
  try {
    const { data, error } = await db
      .from("workspace_automation_runs")
      .select("id, preset, audience, property_id, phone_key, body, created_at, draft_id")
      .eq("workspace_id", workspaceId)
      .eq("status", "held")
      .order("created_at", { ascending: false })
      .limit(100);
    if (error && !isMissingSchemaError(error)) return [];
    return ((data ?? []) as Array<Record<string, unknown>>).flatMap((row) => {
      const preset = getAutomationPreset(String(row.preset));
      if (!preset) return [];
      return [
        {
          id: String(row.id),
          preset: preset.id,
          audience: row.audience === "group" ? ("group" as const) : ("resident" as const),
          propertyId: row.property_id ? String(row.property_id) : null,
          phoneKey: row.phone_key ? String(row.phone_key) : null,
          body: String(row.body ?? ""),
          createdAt: String(row.created_at),
          draftId: row.draft_id ? String(row.draft_id) : null,
        },
      ];
    });
  } catch {
    return [];
  }
}

export async function loadRun(db: SupabaseClient, workspaceId: string, runId: string) {
  try {
    const { data } = await db
      .from("workspace_automation_runs")
      .select("id, workspace_id, owner_user_id, preset, audience, status, mode, property_id, phone_key, body, idempotency_key, draft_id")
      .eq("id", runId)
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    return (data as Record<string, unknown> | null) ?? null;
  } catch {
    return null;
  }
}

/* ─────────────  the existing senders ask: is this preset off for this house?  ───────────── */

export type OffPresetResolver = { isOff: (preset: AutomationPresetId, propertyId: string | null | undefined) => boolean };

const NEVER_OFF: OffPresetResolver = { isOff: () => false };

/**
 * For a sender that already exists (the payment-reminder cron, the resident's service notice):
 * is this preset switched off for the workspace this house is in? Fails open: any read problem
 * answers "not off", so an automation table outage never silences rent reminders.
 */
export async function loadOffPresetResolver(db: SupabaseClient, ownerUserId: string): Promise<OffPresetResolver> {
  try {
    const { data: workspaces, error } = await db
      .from("portal_workspaces")
      .select("id, is_default")
      .eq("owner_user_id", ownerUserId);
    if (error || !workspaces?.length) return NEVER_OFF;
    const ids = (workspaces as Array<{ id: string }>).map((w) => String(w.id));
    const { data: rows, error: rowsError } = await db
      .from("workspace_automation_presets")
      .select("workspace_id, preset")
      .eq("mode", "off")
      .in("workspace_id", ids);
    if (rowsError || !rows?.length) return NEVER_OFF;
    const offByWorkspace = new Map<string, Set<string>>();
    for (const row of rows as Array<{ workspace_id: string; preset: string }>) {
      const set = offByWorkspace.get(String(row.workspace_id)) ?? new Set<string>();
      set.add(String(row.preset));
      offByWorkspace.set(String(row.workspace_id), set);
    }
    const defaultWorkspace = String((workspaces as Array<{ id: string; is_default?: boolean }>).find((w) => w.is_default)?.id ?? ids[0]);
    const houseWorkspace = new Map<string, string>();
    const { data: houses } = await db
      .from("manager_property_records")
      .select("id, workspace_id")
      .eq("manager_user_id", ownerUserId)
      .limit(500);
    for (const house of (houses ?? []) as Array<{ id: string; workspace_id: string | null }>) {
      if (house.workspace_id) houseWorkspace.set(String(house.id), String(house.workspace_id));
    }
    return {
      isOff: (preset, propertyId) => {
        const workspaceId = (propertyId && houseWorkspace.get(propertyId)) || defaultWorkspace;
        return offByWorkspace.get(workspaceId)?.has(preset) ?? false;
      },
    };
  } catch {
    return NEVER_OFF;
  }
}
