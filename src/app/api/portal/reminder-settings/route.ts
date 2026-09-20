/**
 * Per-manager reminder rules for the reminder spine, with optional per-property
 * overrides (PLAN-0916-1040).
 *
 * Manager-only, service-role write pinned to the authenticated user's id, and
 * the whole payload re-normalized server-side so a hand-crafted request cannot
 * store a lead time outside the clamped range or a subject kind the dispatcher
 * does not know.
 *
 * `?propertyId=` scopes a read or write to one house: the override lives in
 * `manager_property_records.row_data.operationsSettings.reminderRules`, keyed
 * PER KIND — a house that customizes one reminder kind stores only that kind;
 * every other kind keeps tracking the workspace value (`mergeReminderSettingsOverride`).
 * Editing "All properties" (no `propertyId`) never touches a house override.
 * The per-module co-manager check runs in front of every path; a `propertyId`
 * outside this manager's workspace, or one a co-manager has no grant for, is
 * a 403, never a silent workspace fallback. A co-manager acting on a house
 * they do not own still writes to the OWNER's row — resolved and authorized
 * by `resolveSettingsPropertyOwner`/`resolveReminderKindsSettingsPropertyOwner`,
 * never a wider check than the module gate every other route already uses.
 */
import { NextResponse } from "next/server";
import {
  loadReminderSettings,
  saveReminderSettings,
  mergeReminderSettingsOverride,
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
  resolveReminderKindsSettingsPropertyOwner,
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
    // every kind), so read access must be checked against every kind's module
    // — never just the loosest one. Scoped to a house, that check also
    // resolves which manager's row to read (owner, or the owner behind an
    // authorized co-manager grant).
    let ownerUserId = ctx.userId;
    if (propertyId) {
      const owner = await resolveReminderKindsSettingsPropertyOwner(ctx.db, ctx.userId, propertyId, ALL_REMINDER_SUBJECT_KINDS, "read");
      if (!owner.ok) return NextResponse.json({ error: owner.error }, { status: owner.status });
      ownerUserId = owner.ownerUserId;
    } else {
      const access = await assertReminderKindsCoManagerAccess(ctx.db, ctx.userId, ALL_REMINDER_SUBJECT_KINDS, "read");
      if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
    }
    const [{ settings, scope, inherited }, overriddenPropertyIds] = await Promise.all([
      resolveOperationsOverride(ctx.db, ownerUserId, propertyId, NAMESPACE, {
        loadWorkspace: () => loadReminderSettings(ctx.db, ownerUserId),
        mergeOverride: mergeReminderSettingsOverride,
      }),
      listPropertyOverrides(ctx.db, ownerUserId, NAMESPACE),
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
    // so it is authorized (and its owner resolved) like an edit to every kind.
    if (body.reset === true) {
      if (!scopedPropertyId) {
        return NextResponse.json({ error: "Reset needs a property." }, { status: 400 });
      }
      const owner = await resolveReminderKindsSettingsPropertyOwner(ctx.db, ctx.userId, scopedPropertyId, ALL_REMINDER_SUBJECT_KINDS, "edit");
      if (!owner.ok) return NextResponse.json({ error: owner.error }, { status: owner.status });
      await clearPropertyOverride(ctx.db, owner.ownerUserId, scopedPropertyId, NAMESPACE);
      const settings = await loadReminderSettings(ctx.db, owner.ownerUserId);
      const overriddenPropertyIds = await listPropertyOverrides(ctx.db, owner.ownerUserId, NAMESPACE);
      return NextResponse.json({ settings, scope: "workspace", inherited: true, overriddenPropertyIds });
    }

    // Single-kind patch: authorize exactly the one subject this PATCH touches,
    // and resolve the owner whose row this house-scoped edit lands on.
    if (body.kind && body.rule && typeof body.kind === "string") {
      const kind = body.kind as ReminderSubjectKind;
      if (!REMINDER_SUBJECT_KINDS.includes(kind)) {
        return NextResponse.json({ error: "Unknown reminder subject." }, { status: 400 });
      }
      let ownerUserId = ctx.userId;
      if (scopedPropertyId) {
        const owner = await resolveReminderKindsSettingsPropertyOwner(ctx.db, ctx.userId, scopedPropertyId, [kind], "edit");
        if (!owner.ok) return NextResponse.json({ error: owner.error }, { status: owner.status });
        ownerUserId = owner.ownerUserId;
      } else {
        const access = await assertReminderKindCoManagerAccess(ctx.db, ctx.userId, kind, "edit");
        if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
      }
      // Merge onto the CURRENT effective rule (override or workspace) so a
      // partial rule patch cannot blank fields this PATCH did not touch.
      const { settings: current } = await resolveOperationsOverride(ctx.db, ownerUserId, scopedPropertyId, NAMESPACE, {
        loadWorkspace: () => loadReminderSettings(ctx.db, ownerUserId),
        mergeOverride: mergeReminderSettingsOverride,
      });
      const normalizedRule = normalizeRule(
        { ...current.rules[kind], ...(body.rule as Record<string, unknown>) },
        DEFAULT_REMINDER_RULES[kind],
        kind,
      );
      const nextSettings = normalizeReminderSettings({ ...current, rules: { ...current.rules, [kind]: normalizedRule } });
      if (scopedPropertyId) {
        // Only the touched kind is written — every sibling kind on this house
        // keeps resolving to the workspace value it already tracked.
        await savePropertyOverride(ctx.db, ownerUserId, scopedPropertyId, NAMESPACE, { [kind]: normalizedRule });
      } else {
        await saveReminderSettings(ctx.db, ownerUserId, nextSettings);
      }
      const overriddenPropertyIds = await listPropertyOverrides(ctx.db, ownerUserId, NAMESPACE);
      return NextResponse.json({
        settings: nextSettings,
        scope: scopedPropertyId ? ("property" as const) : ("workspace" as const),
        inherited: false,
        overriddenPropertyIds,
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
    const touchedKinds: readonly ReminderSubjectKind[] = "quietHours" in incoming ? ALL_REMINDER_SUBJECT_KINDS : touchedRuleKinds;

    let ownerUserId = ctx.userId;
    if (touchedKinds.length > 0) {
      if (scopedPropertyId) {
        const owner = await resolveReminderKindsSettingsPropertyOwner(ctx.db, ctx.userId, scopedPropertyId, touchedKinds, "edit");
        if (!owner.ok) return NextResponse.json({ error: owner.error }, { status: owner.status });
        ownerUserId = owner.ownerUserId;
      } else {
        const access = await assertReminderKindsCoManagerAccess(ctx.db, ctx.userId, touchedKinds, "edit");
        if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
      }
    } else if (scopedPropertyId) {
      // A patch touching zero rule kinds and no quiet hours has nothing to
      // authorize against a specific module, but a `propertyId` still needs a
      // real grant behind it — never resolve a foreign owner for free. Gate
      // it exactly like a full read, the least a house-scoped request may do.
      const owner = await resolveReminderKindsSettingsPropertyOwner(ctx.db, ctx.userId, scopedPropertyId, ALL_REMINDER_SUBJECT_KINDS, "read");
      if (!owner.ok) return NextResponse.json({ error: owner.error }, { status: owner.status });
      ownerUserId = owner.ownerUserId;
    }

    const { settings: current } = await resolveOperationsOverride(ctx.db, ownerUserId, scopedPropertyId, NAMESPACE, {
      loadWorkspace: () => loadReminderSettings(ctx.db, ownerUserId),
      mergeOverride: mergeReminderSettingsOverride,
    });

    if (scopedPropertyId) {
      const patchEntries: Record<string, unknown> = {};
      for (const kind of touchedRuleKinds) {
        patchEntries[kind] = normalizeRule(
          { ...current.rules[kind], ...(incomingRules[kind] as Record<string, unknown>) },
          DEFAULT_REMINDER_RULES[kind],
          kind,
        );
      }
      const nextSettings = normalizeReminderSettings({ ...current, rules: { ...current.rules, ...patchEntries } });
      if (Object.keys(patchEntries).length > 0) {
        await savePropertyOverride(ctx.db, ownerUserId, scopedPropertyId, NAMESPACE, patchEntries);
      }
      const overriddenPropertyIds = await listPropertyOverrides(ctx.db, ownerUserId, NAMESPACE);
      return NextResponse.json({ settings: nextSettings, scope: "property", inherited: false, overriddenPropertyIds });
    }

    const nextSettings = normalizeReminderSettings({ ...current, ...incoming, rules: { ...current.rules, ...incomingRules } });
    await saveReminderSettings(ctx.db, ownerUserId, nextSettings);
    const overriddenPropertyIds = await listPropertyOverrides(ctx.db, ownerUserId, NAMESPACE);
    return NextResponse.json({ settings: nextSettings, scope: "workspace", inherited: false, overriddenPropertyIds });
  } catch (e) {
    if (e instanceof ForeignPropertyError) return foreign();
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
