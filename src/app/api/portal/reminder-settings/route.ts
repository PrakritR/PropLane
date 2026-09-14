/**
 * Per-manager reminder rules for the reminder spine.
 *
 * Mirrors `/api/portal/automation-settings`: manager-only, service-role write
 * pinned to the authenticated user's id, and the whole payload re-normalized
 * server-side so a hand-crafted request cannot store a lead time outside the
 * clamped range or a subject kind the dispatcher does not know.
 */
import { NextResponse } from "next/server";
import { loadReminderSettings, saveReminderSettings } from "@/lib/reminders/settings.server";
import {
  DEFAULT_REMINDER_RULES,
  REMINDER_SUBJECT_KINDS,
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

export const runtime = "nodejs";

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

export async function GET() {
  try {
    const ctx = await requireManager();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    // A GET always returns every subject's rule (loadReminderSettings fills in
    // every kind), so read access must be checked against every kind's module —
    // never just the loosest one.
    const access = await assertReminderKindsCoManagerAccess(ctx.db, ctx.userId, ALL_REMINDER_SUBJECT_KINDS, "read");
    if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
    const settings = await loadReminderSettings(ctx.db, ctx.userId);
    return NextResponse.json({ settings });
  } catch (e) {
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
    };

    if (body.kind && body.rule && typeof body.kind === "string") {
      const kind = body.kind as ReminderSubjectKind;
      if (!REMINDER_SUBJECT_KINDS.includes(kind)) {
        return NextResponse.json({ error: "Unknown reminder subject." }, { status: 400 });
      }
      // Authorize exactly the one subject this PATCH touches.
      const access = await assertReminderKindCoManagerAccess(ctx.db, ctx.userId, kind, "edit");
      if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
      const current = await loadReminderSettings(ctx.db, ctx.userId);
      const settings = await saveReminderSettings(ctx.db, ctx.userId, {
        ...current,
        rules: {
          ...current.rules,
          [kind]: normalizeRule(
            { ...current.rules[kind], ...(body.rule as Record<string, unknown>) },
            DEFAULT_REMINDER_RULES[kind],
          ),
        },
      });
      return NextResponse.json({ settings });
    }

    // Merge onto what is stored so a partial patch cannot blank sibling rules.
    const incoming =
      body.settings && typeof body.settings === "object" && !Array.isArray(body.settings)
        ? (body.settings as Record<string, unknown>)
        : {};
    const incomingRules =
      incoming.rules && typeof incoming.rules === "object" && !Array.isArray(incoming.rules)
        ? (incoming.rules as Record<string, unknown>)
        : {};
    // `quietHours` applies across every subject's send window, so a change to
    // it is authorized like a change to every kind; a bulk `rules` merge is
    // authorized per the specific kinds it names, rejecting the whole request
    // if any named kind's module is not permitted (never falling through to
    // the widest grant available).
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

    const current = await loadReminderSettings(ctx.db, ctx.userId);
    const settings = await saveReminderSettings(ctx.db, ctx.userId, {
      ...current,
      ...incoming,
      rules: { ...current.rules, ...incomingRules },
    });
    return NextResponse.json({ settings });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
