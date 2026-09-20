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
 * workspace: `resolveSettingsScope` resolves property override → workspace row
 * → account row → default. `assertSettingsScopeOwned` refuses a `propertyId`
 * or `workspaceId` that is not this manager's own — phase A+B never lets one
 * manager name another's workspace here. Editing "All properties, all
 * workspaces" (neither param) never touches an override.
 *
 * `scope` keeps its pre-existing two-value meaning ("property" | "workspace")
 * for callers that predate the workspace rung. `source` is the new, truthful
 * three-value tag ("property" | "workspace" | "account") PLAN-0920-0845 adds.
 */
import { NextResponse } from "next/server";
import {
  loadReminderSettings,
  saveReminderSettings,
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
import {
  ALL_REMINDER_SUBJECT_KINDS,
  assertReminderKindCoManagerAccess,
  assertReminderKindsCoManagerAccess,
} from "@/lib/auth/manager-settings-module-access.server";
import {
  clearPropertyOverride,
  ForeignPropertyError,
  listPropertyOverrides,
  savePropertyOverride,
} from "@/lib/settings/property-overrides.server";
import {
  resolveSettingsScope,
  saveWorkspaceNamespaceSettings,
  type SettingsResolutionSource,
} from "@/lib/settings/scope-resolver.server";
import {
  assertSettingsScopeOwned,
  resolveSettingsScopeParams,
  trackSettingsScopeChanged,
  writeRungFromSource,
} from "@/lib/scope/settings-scope";

export const runtime = "nodejs";

const NAMESPACE = "reminderRules" as const;
const ANALYTICS_MODULE = "reminders";

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

async function loadCurrent(
  db: ReturnType<typeof createSupabaseServiceRoleClient>,
  managerUserId: string,
  propertyId: string | null,
  workspaceId: string | null,
): Promise<{ settings: ReminderSettings; source: SettingsResolutionSource }> {
  const { value, source } = await resolveSettingsScope(
    db,
    { managerUserId, propertyId, workspaceId },
    NAMESPACE,
    { normalize: normalizeReminderSettings, loadAccount: (d, m) => loadReminderSettings(d, m) },
  );
  return { settings: value, source };
}

export async function GET(req: Request) {
  try {
    const ctx = await requireManager();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const scope = resolveSettingsScopeParams(req.url);
    const scopeAccess = await assertSettingsScopeOwned(ctx.db, ctx.userId, scope);
    if (!scopeAccess.ok) return NextResponse.json({ error: scopeAccess.error }, { status: scopeAccess.status });
    const { ownerUserId, propertyId, workspaceId } = scopeAccess;
    // A GET always returns every subject's rule (loadReminderSettings fills in
    // every kind), so read access must be checked against every kind's module —
    // never just the loosest one. The same read gate covers the house scope.
    const access = await assertReminderKindsCoManagerAccess(ctx.db, ctx.userId, ALL_REMINDER_SUBJECT_KINDS, "read");
    if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
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
    const scopeAccess = await assertSettingsScopeOwned(ctx.db, ctx.userId, scope);
    if (!scopeAccess.ok) return NextResponse.json({ error: scopeAccess.error }, { status: scopeAccess.status });
    const { ownerUserId, propertyId, workspaceId } = scopeAccess;

    // Reset — clear the whole house override. Every reminder kind is affected,
    // so it is authorized like an edit to every kind.
    if (body.reset === true) {
      if (!propertyId) {
        return NextResponse.json({ error: "Reset needs a property." }, { status: 400 });
      }
      const access = await assertReminderKindsCoManagerAccess(ctx.db, ctx.userId, ALL_REMINDER_SUBJECT_KINDS, "edit");
      if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
      await clearPropertyOverride(ctx.db, ownerUserId, propertyId, NAMESPACE);
      const { settings, source } = await loadCurrent(ctx.db, ownerUserId, null, workspaceId);
      const overriddenPropertyIds = await listPropertyOverrides(ctx.db, ownerUserId, NAMESPACE);
      await trackSettingsScopeChanged(ctx.db, ctx.userId, { module: ANALYTICS_MODULE, rung: writeRungFromSource(source), ownerUserId, workspaceId });
      return NextResponse.json({ settings, scope: legacyScope(source), inherited: true, overriddenPropertyIds, source });
    }

    // Single-kind patch: authorize exactly the one subject this PATCH touches.
    if (body.kind && body.rule && typeof body.kind === "string") {
      const kind = body.kind as ReminderSubjectKind;
      if (!REMINDER_SUBJECT_KINDS.includes(kind)) {
        return NextResponse.json({ error: "Unknown reminder subject." }, { status: 400 });
      }
      const access = await assertReminderKindCoManagerAccess(ctx.db, ctx.userId, kind, "edit");
      if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
      // Merge onto the CURRENT scope's rules: a house patch edits the house's own
      // override (created on first edit), a workspace patch edits the workspace row.
      const { settings: current } = await loadCurrent(ctx.db, ownerUserId, propertyId, workspaceId);
      const nextSettings = normalizeReminderSettings({
        ...current,
        rules: {
          ...current.rules,
          [kind]: normalizeRule({ ...current.rules[kind], ...(body.rule as Record<string, unknown>) }, DEFAULT_REMINDER_RULES[kind]),
        },
      });
      return NextResponse.json(await persist(ctx, ownerUserId, propertyId, workspaceId, nextSettings));
    }

    // Bulk patch (quiet hours + several rules). Merge onto what is stored so a
    // partial patch cannot blank sibling rules.
    const incoming =
      body.settings && typeof body.settings === "object" && !Array.isArray(body.settings)
        ? (body.settings as Record<string, unknown>)
        : {};
    const incomingRules =
      incoming.rules && typeof incoming.rules === "object" && !Array.isArray(incoming.rules)
        ? (incoming.rules as Record<string, unknown>)
        : {};
    const touchedKinds: readonly ReminderSubjectKind[] =
      "quietHours" in incoming
        ? ALL_REMINDER_SUBJECT_KINDS
        : (Object.keys(incomingRules).filter((k): k is ReminderSubjectKind =>
            (REMINDER_SUBJECT_KINDS as readonly string[]).includes(k),
          ) as ReminderSubjectKind[]);
    if (touchedKinds.length > 0) {
      const access = await assertReminderKindsCoManagerAccess(ctx.db, ctx.userId, touchedKinds, "edit");
      if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
    }

    const { settings: current } = await loadCurrent(ctx.db, ownerUserId, propertyId, workspaceId);
    const nextSettings = normalizeReminderSettings({
      ...current,
      ...incoming,
      rules: { ...current.rules, ...incomingRules },
    });
    return NextResponse.json(await persist(ctx, ownerUserId, propertyId, workspaceId, nextSettings));
  } catch (e) {
    if (e instanceof ForeignPropertyError) return foreign();
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}

/**
 * Write the resolved settings to the right rung: a house's own override, a
 * workspace row, or the account row. Returns the settings plus the scope
 * metadata the client uses to render the "Uses workspace/account defaults" /
 * "Reset" state.
 */
async function persist(
  ctx: { db: ReturnType<typeof createSupabaseServiceRoleClient>; userId: string },
  ownerUserId: string,
  propertyId: string | null,
  workspaceId: string | null,
  settings: ReminderSettings,
) {
  const rung: "property" | "workspace" | "account" = propertyId ? "property" : workspaceId ? "workspace" : "account";
  if (propertyId) {
    await savePropertyOverride(ctx.db, ownerUserId, propertyId, NAMESPACE, settings);
  } else if (workspaceId) {
    await saveWorkspaceNamespaceSettings(ctx.db, workspaceId, ownerUserId, NAMESPACE, settings);
  } else {
    await saveReminderSettings(ctx.db, ownerUserId, settings);
  }
  const overriddenPropertyIds = await listPropertyOverrides(ctx.db, ownerUserId, NAMESPACE);
  await trackSettingsScopeChanged(ctx.db, ctx.userId, { module: ANALYTICS_MODULE, rung, ownerUserId, workspaceId });
  return {
    settings,
    scope: propertyId ? ("property" as const) : ("workspace" as const),
    inherited: false,
    overriddenPropertyIds,
    source: rung,
  };
}
