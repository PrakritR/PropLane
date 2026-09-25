/**
 * Per-manager reminder rules for the reminder spine, with optional per-property
 * and per-workspace overrides (PLAN-0916-1040, extended by PLAN-0920-0845).
 *
 * Manager-only, service-role write pinned to the authenticated user's id, and
 * the whole payload re-normalized server-side so a hand-crafted request cannot
 * store a lead time outside the clamped range or a subject kind the dispatcher
 * does not know.
 *
 * `?propertyId=` and `?workspaceId=` scope a read or write to one house or one
 * workspace — resolution is house override (PER KIND — a house that
 * customizes one reminder kind stores only that kind, every other kind keeps
 * tracking the rung below it, `mergeReminderSettingsOverride`) → workspace row
 * → account row → default. Editing "All properties, all workspaces" (neither
 * param) never touches an override.
 *
 * The per-module co-manager check runs in front of every path. For a
 * `propertyId`, the owner (and the caller's grant on it) is resolved first
 * through `resolveReminderKindsSettingsPropertyOwner` — a `propertyId`
 * outside this manager's workspace, or one a co-manager has no grant for, is
 * a 403, never a silent fallback. `assertSettingsScopeOwned` then resolves
 * (and, for an explicit `workspaceId`, cross-checks) that owner's workspace —
 * it runs against the ALREADY-authorized owner, so it only resolves ids, it
 * never re-decides access. A bare `workspaceId` (no property) still requires
 * literal ownership: co-manager delegation exists only at the property rung
 * today. A co-manager acting on a house they do not own writes to the
 * OWNER's row.
 *
 * `scope` keeps its pre-existing two-value meaning ("property" | "workspace")
 * for callers that predate the workspace rung. `source` is the new, truthful
 * three-value tag ("property" | "workspace" | "account") PLAN-0920-0845 adds.
 */
import { NextResponse } from "next/server";
import {
  loadReminderSettings,
  loadReminderWorkspaceOverride,
  saveReminderSettings,
  mergeReminderSettingsOverride,
  isEmptyOverride,
} from "@/lib/reminders/settings.server";
import {
  DEFAULT_REMINDER_RULES,
  REMINDER_SUBJECT_KINDS,
  normalizeReminderSettings,
  normalizeRule,
  type ReminderSettings,
  type ReminderSubjectKind,
} from "@/lib/reminders/rules";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import type { CoManagerPermissionLevel } from "@/lib/co-manager-permissions";
import {
  ALL_REMINDER_SUBJECT_KINDS,
  assertReminderKindCoManagerAccess,
  assertReminderKindsCoManagerAccess,
  resolveReminderKindsSettingsPropertyOwner,
} from "@/lib/auth/manager-settings-module-access.server";
import {
  clearPropertyOverride,
  ForeignPropertyError,
  listPropertyOverrides,
  loadPropertyOverride,
  savePropertyOverride,
} from "@/lib/settings/property-overrides.server";
import { saveWorkspaceNamespaceSettings, type SettingsResolutionSource } from "@/lib/settings/scope-resolver.server";
import {
  assertSettingsScopeOwned,
  resolveSettingsScopeParams,
  trackSettingsScopeChanged,
  type ParsedSettingsScope,
} from "@/lib/scope/settings-scope";

export const runtime = "nodejs";

const NAMESPACE = "reminderRules" as const;
const ANALYTICS_MODULE = "reminders";

type Db = ReturnType<typeof createSupabaseServiceRoleClient>;

async function requireManager() {
  const supabaseAuth = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabaseAuth.auth.getUser();
  if (!user?.id) return null;

  const db = createSupabaseServiceRoleClient();
  const [{ data: profile }, { data: roles }] = await Promise.all([
    db.from("profiles").select("role").eq("id", user.id).maybeSingle(),
    db.from("profile_roles").select("role").eq("user_id", user.id),
  ]);
  const roleList = (roles ?? []).map((r) => String(r.role).toLowerCase());
  const legacy = String(profile?.role ?? user.user_metadata?.role ?? "").toLowerCase();
  const isManager = roleList.includes("manager") || legacy === "manager" || legacy === "admin";
  if (!isManager) return null;
  return { db, userId: user.id };
}

function foreign(): NextResponse {
  return NextResponse.json({ error: "That property is not in your workspace." }, { status: 403 });
}

/** The old two-value `scope` field, kept byte-for-byte for existing callers. */
function legacyScope(source: SettingsResolutionSource): "property" | "workspace" {
  return source === "property" ? "property" : "workspace";
}

type ReminderScopeAccess =
  | { ok: true; ownerUserId: string; propertyId: string | null; workspaceId: string | null }
  | { ok: false; status: number; error: string };

/**
 * Resolve which manager's row a scoped reminder-settings call acts on, and
 * authorize it. A `propertyId` resolves (and authorizes) its owner first,
 * per kind, through `resolveReminderKindsSettingsPropertyOwner`
 * (PLAN-0916-1040) — the only rung with co-manager delegation today.
 * `assertSettingsScopeOwned` then runs against that ALREADY-authorized
 * owner purely to resolve (and cross-check) the workspace id; since the
 * owner trivially owns their own scope, this never re-decides access. With
 * no `propertyId`, a named `workspaceId` still requires literal ownership,
 * and the per-kind module check runs against the caller directly.
 */
async function resolveReminderScope(
  ctx: { db: Db; userId: string },
  scope: ParsedSettingsScope,
  kinds: readonly ReminderSubjectKind[],
  level: CoManagerPermissionLevel,
): Promise<ReminderScopeAccess> {
  if (scope.propertyId) {
    const owner = await resolveReminderKindsSettingsPropertyOwner(ctx.db, ctx.userId, scope.propertyId, kinds, level);
    if (!owner.ok) return owner;
    const scopeAccess = await assertSettingsScopeOwned(ctx.db, owner.ownerUserId, scope);
    if (!scopeAccess.ok) return scopeAccess;
    return { ok: true, ownerUserId: owner.ownerUserId, propertyId: scopeAccess.propertyId, workspaceId: scopeAccess.workspaceId };
  }
  const scopeAccess = await assertSettingsScopeOwned(ctx.db, ctx.userId, scope);
  if (!scopeAccess.ok) return scopeAccess;
  const access =
    kinds.length === 1
      ? await assertReminderKindCoManagerAccess(ctx.db, ctx.userId, kinds[0]!, level)
      : await assertReminderKindsCoManagerAccess(ctx.db, ctx.userId, kinds, level);
  if (!access.ok) return access;
  return { ok: true, ownerUserId: scopeAccess.ownerUserId, propertyId: scopeAccess.propertyId, workspaceId: scopeAccess.workspaceId };
}

/**
 * Reminder rules for `(ownerUserId, propertyId?, workspaceId?)` through the
 * full three-rung scope: account row → workspace row → house override, each
 * merged onto the last PER KIND (`mergeReminderSettingsOverride`), so a kind
 * absent from a partial keeps tracking the rung below it. `source` names
 * whichever rung actually held a non-empty override.
 */
async function loadCurrent(
  db: Db,
  ownerUserId: string,
  propertyId: string | null,
  workspaceId: string | null,
): Promise<{ settings: ReminderSettings; source: SettingsResolutionSource }> {
  const account = await loadReminderSettings(db, ownerUserId);
  let settings = account;
  let source: SettingsResolutionSource = "account";

  if (workspaceId) {
    const workspaceRaw = await loadReminderWorkspaceOverride(db, workspaceId);
    if (!isEmptyOverride(workspaceRaw)) {
      settings = mergeReminderSettingsOverride(account, workspaceRaw);
      source = "workspace";
    }
  }

  if (propertyId) {
    const propertyRaw = await loadPropertyOverride(db, ownerUserId, propertyId, NAMESPACE);
    if (!isEmptyOverride(propertyRaw)) {
      settings = mergeReminderSettingsOverride(settings, propertyRaw);
      source = "property";
    }
  }

  return { settings, source };
}

/**
 * Merge `patch`'s own top-level keys onto whatever `reminderRules` raw value
 * is already stored on a workspace row, and save — the workspace-rung
 * counterpart to `savePropertyOverride`'s per-kind partial merge, so an
 * untouched kind (or another house on this workspace) keeps tracking the
 * account value rather than being frozen at today's blob.
 */
async function patchWorkspaceReminderOverride(db: Db, workspaceId: string, ownerUserId: string, patch: Record<string, unknown>): Promise<void> {
  const existingRaw = await loadReminderWorkspaceOverride(db, workspaceId);
  const existing = existingRaw && typeof existingRaw === "object" && !Array.isArray(existingRaw) ? (existingRaw as Record<string, unknown>) : {};
  await saveWorkspaceNamespaceSettings(db, workspaceId, ownerUserId, NAMESPACE, { ...existing, ...patch });
}

export async function GET(req: Request) {
  try {
    const ctx = await requireManager();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const scope = resolveSettingsScopeParams(req.url);
    // A GET always returns every subject's rule (loadReminderSettings fills in
    // every kind), so read access must be checked against every kind's module
    // — never just the loosest one. Scoped to a house, that check also
    // resolves which manager's row to read (owner, or the owner behind an
    // authorized co-manager grant).
    const access = await resolveReminderScope(ctx, scope, ALL_REMINDER_SUBJECT_KINDS, "read");
    if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
    const { ownerUserId, propertyId, workspaceId } = access;
    const [{ settings, source }, overriddenPropertyIds] = await Promise.all([
      loadCurrent(ctx.db, ownerUserId, propertyId, workspaceId),
      listPropertyOverrides(ctx.db, ownerUserId, NAMESPACE),
    ]);
    return NextResponse.json({
      settings,
      scope: legacyScope(source),
      inherited: Boolean(propertyId) && source !== "property",
      overriddenPropertyIds,
      source,
    });
  } catch (e) {
    if (e instanceof ForeignPropertyError) return foreign();
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const ctx = await requireManager();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const body = (await req.json().catch(() => ({}))) as {
      settings?: unknown;
      kind?: string;
      rule?: unknown;
      propertyId?: unknown;
      workspaceId?: unknown;
      reset?: unknown;
    };
    const scope = resolveSettingsScopeParams(req.url, body);

    // Reset — clear the whole house override. Every reminder kind is affected,
    // so it is authorized (and its owner resolved) like an edit to every kind.
    if (body.reset === true) {
      if (!scope.propertyId) {
        return NextResponse.json({ error: "Reset needs a property." }, { status: 400 });
      }
      const access = await resolveReminderScope(ctx, scope, ALL_REMINDER_SUBJECT_KINDS, "edit");
      if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
      const { ownerUserId, workspaceId } = access;
      const propertyId = access.propertyId!;
      await clearPropertyOverride(ctx.db, ownerUserId, propertyId, NAMESPACE);
      const { settings, source } = await loadCurrent(ctx.db, ownerUserId, null, workspaceId);
      const overriddenPropertyIds = await listPropertyOverrides(ctx.db, ownerUserId, NAMESPACE);
      await trackSettingsScopeChanged(ctx.db, ctx.userId, { module: ANALYTICS_MODULE, rung: "property", ownerUserId, workspaceId });
      return NextResponse.json({ settings, scope: legacyScope(source), inherited: true, overriddenPropertyIds, source });
    }

    // Single-kind patch: authorize exactly the one subject this PATCH touches,
    // and resolve the owner whose row this house-scoped edit lands on.
    if (body.kind && body.rule && typeof body.kind === "string") {
      const kind = body.kind as ReminderSubjectKind;
      if (!REMINDER_SUBJECT_KINDS.includes(kind)) {
        return NextResponse.json({ error: "Unknown reminder subject." }, { status: 400 });
      }
      const access = await resolveReminderScope(ctx, scope, [kind], "edit");
      if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
      const { ownerUserId, propertyId, workspaceId } = access;
      // Merge onto the CURRENT effective rule (house → workspace → account) so
      // a partial rule patch cannot blank fields this PATCH did not touch.
      const { settings: current } = await loadCurrent(ctx.db, ownerUserId, propertyId, workspaceId);
      const normalizedRule = normalizeRule(
        { ...current.rules[kind], ...(body.rule as Record<string, unknown>) },
        DEFAULT_REMINDER_RULES[kind],
        kind,
      );
      const nextSettings = normalizeReminderSettings({ ...current, rules: { ...current.rules, [kind]: normalizedRule } });
      let rung: "property" | "workspace" | "account";
      if (propertyId) {
        // Only the touched kind is written — every sibling kind on this house
        // keeps resolving to whatever the workspace/account holds.
        await savePropertyOverride(ctx.db, ownerUserId, propertyId, NAMESPACE, { [kind]: normalizedRule });
        rung = "property";
      } else if (workspaceId) {
        await patchWorkspaceReminderOverride(ctx.db, workspaceId, ownerUserId, { [kind]: normalizedRule });
        rung = "workspace";
      } else {
        await saveReminderSettings(ctx.db, ownerUserId, nextSettings);
        rung = "account";
      }
      const overriddenPropertyIds = await listPropertyOverrides(ctx.db, ownerUserId, NAMESPACE);
      await trackSettingsScopeChanged(ctx.db, ctx.userId, { module: ANALYTICS_MODULE, rung, ownerUserId, workspaceId });
      return NextResponse.json({
        settings: nextSettings,
        scope: propertyId ? ("property" as const) : ("workspace" as const),
        inherited: false,
        overriddenPropertyIds,
        source: rung,
      });
    }

    // Bulk patch (quiet hours + several rules). Merge onto what is stored so a
    // partial patch cannot blank sibling rules. `quietHours` is a workspace-
    // wide clock setting, never a per-house override, so a house-scoped bulk
    // patch only ever applies the `rules` entries it names.
    const incoming =
      body.settings && typeof body.settings === "object" && !Array.isArray(body.settings)
        ? (body.settings as Record<string, unknown>)
        : {};
    const incomingRules =
      incoming.rules && typeof incoming.rules === "object" && !Array.isArray(incoming.rules)
        ? (incoming.rules as Record<string, unknown>)
        : {};
    const touchedRuleKinds = Object.keys(incomingRules).filter((k): k is ReminderSubjectKind =>
      (REMINDER_SUBJECT_KINDS as readonly string[]).includes(k),
    ) as ReminderSubjectKind[];
    const touchesQuietHours = "quietHours" in incoming || "automationSendMode" in incoming;
    const touchedKinds: readonly ReminderSubjectKind[] = touchesQuietHours ? ALL_REMINDER_SUBJECT_KINDS : touchedRuleKinds;

    // A patch touching zero rule kinds and no quiet hours has nothing to
    // authorize against a specific module, but a scoped request still needs a
    // real grant behind it — never resolve a foreign owner for free. Gate it
    // exactly like a full read, the least a scoped request may do.
    const access =
      touchedKinds.length > 0
        ? await resolveReminderScope(ctx, scope, touchedKinds, "edit")
        : await resolveReminderScope(ctx, scope, ALL_REMINDER_SUBJECT_KINDS, "read");
    if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
    const { ownerUserId, propertyId, workspaceId } = access;

    const { settings: current } = await loadCurrent(ctx.db, ownerUserId, propertyId, workspaceId);
    const patchEntries: Record<string, unknown> = {};
    for (const kind of touchedRuleKinds) {
      patchEntries[kind] = normalizeRule(
        { ...current.rules[kind], ...(incomingRules[kind] as Record<string, unknown>) },
        DEFAULT_REMINDER_RULES[kind],
        kind,
      );
    }

    if (propertyId) {
      const nextSettings = normalizeReminderSettings({ ...current, rules: { ...current.rules, ...patchEntries } });
      if (Object.keys(patchEntries).length > 0) {
        await savePropertyOverride(ctx.db, ownerUserId, propertyId, NAMESPACE, patchEntries);
        await trackSettingsScopeChanged(ctx.db, ctx.userId, { module: ANALYTICS_MODULE, rung: "property", ownerUserId, workspaceId });
      }
      const overriddenPropertyIds = await listPropertyOverrides(ctx.db, ownerUserId, NAMESPACE);
      return NextResponse.json({ settings: nextSettings, scope: "property", inherited: false, overriddenPropertyIds, source: "property" });
    }

    if (workspaceId) {
      const nextSettings = normalizeReminderSettings({
        ...current,
        ...(touchesQuietHours ? incoming : {}),
        rules: { ...current.rules, ...patchEntries },
      });
      if (Object.keys(patchEntries).length > 0 || touchesQuietHours) {
        await patchWorkspaceReminderOverride(ctx.db, workspaceId, ownerUserId, {
          ...patchEntries,
          ...(touchesQuietHours
            ? { quietHours: nextSettings.quietHours, automationSendMode: nextSettings.automationSendMode }
            : {}),
        });
        await trackSettingsScopeChanged(ctx.db, ctx.userId, { module: ANALYTICS_MODULE, rung: "workspace", ownerUserId, workspaceId });
      }
      const overriddenPropertyIds = await listPropertyOverrides(ctx.db, ownerUserId, NAMESPACE);
      return NextResponse.json({ settings: nextSettings, scope: "workspace", inherited: false, overriddenPropertyIds, source: "workspace" });
    }

    const nextSettings = normalizeReminderSettings({ ...current, ...incoming, rules: { ...current.rules, ...incomingRules } });
    await saveReminderSettings(ctx.db, ownerUserId, nextSettings);
    await trackSettingsScopeChanged(ctx.db, ctx.userId, { module: ANALYTICS_MODULE, rung: "account", ownerUserId, workspaceId: null });
    const overriddenPropertyIds = await listPropertyOverrides(ctx.db, ownerUserId, NAMESPACE);
    return NextResponse.json({ settings: nextSettings, scope: "workspace", inherited: false, overriddenPropertyIds, source: "account" });
  } catch (e) {
    if (e instanceof ForeignPropertyError) return foreign();
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
