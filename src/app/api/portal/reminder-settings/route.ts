/**
 * Per-manager reminder rules for the reminder spine, with optional per-property
 * overrides (PLAN-0916-1040).
 *
 * Manager-only, service-role write pinned to the authenticated user's id, and
 * the whole payload re-normalized server-side so a hand-crafted request cannot
 * store a lead time outside the clamped range or a subject kind the dispatcher
 * does not know.
 *
 * `?propertyId=` scopes a read or write to one house: the override lives whole
 * in `manager_property_records.row_data.operationsSettings.reminderRules`.
 * Editing "All properties" (no `propertyId`) never touches a house override.
 * The per-module co-manager check runs in front of every path; a `propertyId`
 * outside this manager's workspace is a 403, never a silent workspace fallback.
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
  resolveOperationsOverride,
  savePropertyOverride,
} from "@/lib/settings/property-overrides.server";

export const runtime = "nodejs";

const NAMESPACE = "reminderRules" as const;

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

function readPropertyId(url: string): string | null {
  const raw = new URL(url).searchParams.get("propertyId");
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}

function foreign(): NextResponse {
  return NextResponse.json({ error: "That property is not in your workspace." }, { status: 403 });
}

export async function GET(req: Request) {
  try {
    const ctx = await requireManager();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const propertyId = readPropertyId(req.url);
    // A GET always returns every subject's rule (loadReminderSettings fills in
    // every kind), so read access must be checked against every kind's module —
    // never just the loosest one. The same read gate covers the house scope.
    const access = await assertReminderKindsCoManagerAccess(ctx.db, ctx.userId, ALL_REMINDER_SUBJECT_KINDS, "read");
    if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
    const [{ settings, scope, inherited }, overriddenPropertyIds] = await Promise.all([
      resolveOperationsOverride(ctx.db, ctx.userId, propertyId, NAMESPACE, {
        loadWorkspace: () => loadReminderSettings(ctx.db, ctx.userId),
        normalize: normalizeReminderSettings,
      }),
      listPropertyOverrides(ctx.db, ctx.userId, NAMESPACE),
    ]);
    return NextResponse.json({ settings, scope, inherited, overriddenPropertyIds });
  } catch (e) {
    if (e instanceof ForeignPropertyError) return foreign();
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const ctx = await requireManager();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const propertyId = readPropertyId(req.url);
    const body = (await req.json().catch(() => ({}))) as {
      settings?: unknown;
      kind?: string;
      rule?: unknown;
      propertyId?: unknown;
      reset?: unknown;
    };
    // `propertyId` may ride in the body (PATCH/reset) or the query; the body wins.
    const bodyPropertyId = typeof body.propertyId === "string" && body.propertyId.trim() ? body.propertyId.trim() : null;
    const scopedPropertyId = bodyPropertyId ?? propertyId;

    // Reset — clear the whole house override. Every reminder kind is affected,
    // so it is authorized like an edit to every kind.
    if (body.reset === true) {
      if (!scopedPropertyId) {
        return NextResponse.json({ error: "Reset needs a property." }, { status: 400 });
      }
      const access = await assertReminderKindsCoManagerAccess(ctx.db, ctx.userId, ALL_REMINDER_SUBJECT_KINDS, "edit");
      if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
      await clearPropertyOverride(ctx.db, ctx.userId, scopedPropertyId, NAMESPACE);
      const settings = await loadReminderSettings(ctx.db, ctx.userId);
      const overriddenPropertyIds = await listPropertyOverrides(ctx.db, ctx.userId, NAMESPACE);
      return NextResponse.json({ settings, scope: "workspace", inherited: true, overriddenPropertyIds });
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
      // override (created on first edit), a workspace patch edits the workspace.
      const { settings: current } = await resolveOperationsOverride(ctx.db, ctx.userId, scopedPropertyId, NAMESPACE, {
        loadWorkspace: () => loadReminderSettings(ctx.db, ctx.userId),
        normalize: normalizeReminderSettings,
      });
      const nextSettings = normalizeReminderSettings({
        ...current,
        rules: {
          ...current.rules,
          [kind]: normalizeRule({ ...current.rules[kind], ...(body.rule as Record<string, unknown>) }, DEFAULT_REMINDER_RULES[kind]),
        },
      });
      return NextResponse.json(await persist(ctx, scopedPropertyId, nextSettings));
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

    const { settings: current } = await resolveOperationsOverride(ctx.db, ctx.userId, scopedPropertyId, NAMESPACE, {
      loadWorkspace: () => loadReminderSettings(ctx.db, ctx.userId),
      normalize: normalizeReminderSettings,
    });
    const nextSettings = normalizeReminderSettings({
      ...current,
      ...incoming,
      rules: { ...current.rules, ...incomingRules },
    });
    return NextResponse.json(await persist(ctx, scopedPropertyId, nextSettings));
  } catch (e) {
    if (e instanceof ForeignPropertyError) return foreign();
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}

/**
 * Write the resolved settings to the right place: a house's own override, or
 * the workspace row. Returns the settings plus the scope metadata the client
 * uses to render the "Uses workspace defaults" / "Reset" state.
 */
async function persist(
  ctx: { db: ReturnType<typeof createSupabaseServiceRoleClient>; userId: string },
  propertyId: string | null,
  settings: ReturnType<typeof normalizeReminderSettings>,
) {
  if (propertyId) {
    await savePropertyOverride(ctx.db, ctx.userId, propertyId, NAMESPACE, settings);
  } else {
    await saveReminderSettings(ctx.db, ctx.userId, settings);
  }
  const overriddenPropertyIds = await listPropertyOverrides(ctx.db, ctx.userId, NAMESPACE);
  return {
    settings,
    scope: propertyId ? ("property" as const) : ("workspace" as const),
    inherited: false,
    overriddenPropertyIds,
  };
}
