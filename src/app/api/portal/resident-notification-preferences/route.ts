import { NextResponse } from "next/server";

import { authorizeResidentRole } from "@/lib/auth/resident-role-access";
import {
  NOTIFICATION_CATEGORIES,
  loadNotificationPreferences,
  loadResidentTextSettings,
  normalizeNotificationPreferences,
  normalizeResidentTextSettings,
  saveNotificationPreferences,
  saveResidentTextSettings,
  type ChannelPreference,
  type NotificationPreferences,
} from "@/lib/notification-preferences";
import { isPhoneOptedOut } from "@/lib/sms-consent";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

/**
 * The resident's own in-app + email + text notification preferences.
 *
 * `notification_preferences` has RLS enabled with NO policies, so it is
 * service-role-only — every read/write below goes through
 * `createSupabaseServiceRoleClient`, never a browser client. Authorization is
 * the shared resident predicate (`authorizeResidentRole`), which consults
 * `profile_roles` rather than the legacy `profiles.role` column, and the
 * caller's own session id is the ONLY identity ever used to read or write a
 * row — no `user_id` is ever accepted from a query string or request body.
 */

const SMS_STOP_MESSAGE =
  "You texted STOP, so PropLane cannot text this number. Reply START to any PropLane text message to resume text notifications.";

type SmsAvailability =
  | { available: true }
  | { available: false; reason: "no_phone" }
  | { available: false; reason: "opted_out"; message: string };

type ServiceRoleClient = ReturnType<typeof createSupabaseServiceRoleClient>;

type AuthedContext = {
  db: ServiceRoleClient;
  userId: string;
  phone: string;
};

/**
 * Authenticates the caller and confirms the resident role. Returns a ready
 * 401/403 response on failure, or the authorized context (service-role db,
 * the caller's own user id, and their profile phone) otherwise.
 */
async function authorize(): Promise<
  { ok: true; ctx: AuthedContext } | { ok: false; response: NextResponse }
> {
  const auth = await createSupabaseServerClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) {
    return { ok: false, response: NextResponse.json({ error: "Not authenticated." }, { status: 401 }) };
  }

  const db = createSupabaseServiceRoleClient();
  const { data: profile } = await db
    .from("profiles")
    .select("role, phone")
    .eq("id", user.id)
    .maybeSingle();
  const legacyRole = String(profile?.role ?? user.user_metadata?.role ?? "")
    .trim()
    .toLowerCase();
  if (!(await authorizeResidentRole(db, { userId: user.id, legacyRole }))) {
    return { ok: false, response: NextResponse.json({ error: "Residents only." }, { status: 403 }) };
  }

  return { ok: true, ctx: { db, userId: user.id, phone: String(profile?.phone ?? "").trim() } };
}

/**
 * Text delivery is blocked when there is no phone on file at all, or when the
 * unified opt-out check (`isPhoneOptedOut`, the single choke point across both
 * the phone-keyed and user-keyed consent stores) says the number texted STOP.
 * The UI must show this rather than let a resident flip an SMS toggle that
 * will never deliver.
 */
async function resolveSmsAvailability(ctx: AuthedContext): Promise<SmsAvailability> {
  if (!ctx.phone) return { available: false, reason: "no_phone" };
  const optedOut = await isPhoneOptedOut(ctx.db, ctx.phone, { userId: ctx.userId });
  if (optedOut) return { available: false, reason: "opted_out", message: SMS_STOP_MESSAGE };
  return { available: true };
}

export async function GET() {
  try {
    const auth = await authorize();
    if (!auth.ok) return auth.response;
    const { db, userId } = auth.ctx;

    // Read directly (rather than the swallow-on-error `loadNotificationPreferences`
    // helper) so a genuine read failure surfaces as an error instead of silently
    // resolving to "every category, all channels on" — the same shape as an
    // unset resident, which a client could then PATCH and durably overwrite.
    const { data: row, error } = await db
      .from("notification_preferences")
      .select("row_data")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) {
      return NextResponse.json({ error: "Could not load notification preferences." }, { status: 500 });
    }

    const preferences = normalizeNotificationPreferences(row?.row_data ?? null);
    const text = normalizeResidentTextSettings((row?.row_data as Record<string, unknown> | null)?.resident);
    const sms = await resolveSmsAvailability(auth.ctx);

    return NextResponse.json({ categories: NOTIFICATION_CATEGORIES, preferences, text, sms });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not load notification preferences.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

type ChannelPatch = { email?: unknown; sms?: unknown };
type PatchBody = { preferences?: unknown; text?: unknown };

/**
 * Merges an incoming per-category channel patch ONTO the caller's current
 * saved preferences (never onto a bare default object and never a raw
 * overwrite of `row_data`), so saving one category's toggle never resets any
 * other category back to its default. `inbox` is clamped ON here regardless
 * of what the patch requests — `normalizeNotificationPreferences` (called
 * again inside `saveNotificationPreferences`) enforces the identical clamp,
 * so this is defense in depth on the server, not the UI, and not the only
 * place the guarantee lives.
 */
function applyPreferencesPatch(current: NotificationPreferences, rawPatch: unknown): NotificationPreferences {
  const patch = rawPatch && typeof rawPatch === "object" ? (rawPatch as Record<string, unknown>) : {};
  const next: NotificationPreferences = { ...current };
  for (const category of NOTIFICATION_CATEGORIES) {
    const rawChannel = patch[category];
    if (!rawChannel || typeof rawChannel !== "object") continue;
    const channelPatch = rawChannel as ChannelPatch;
    const existing: ChannelPreference = current[category];
    next[category] = {
      inbox: true,
      email: typeof channelPatch.email === "boolean" ? channelPatch.email : existing.email,
      sms: typeof channelPatch.sms === "boolean" ? channelPatch.sms : existing.sms,
    };
  }
  return next;
}

export async function PATCH(req: Request) {
  try {
    const auth = await authorize();
    if (!auth.ok) return auth.response;
    const { db, userId } = auth.ctx;

    let body: PatchBody;
    try {
      body = (await req.json()) as PatchBody;
    } catch {
      return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
    }
    // The resident's own text settings (quiet hours) ride the same route.
    if (body.text && typeof body.text === "object") {
      const current = await loadResidentTextSettings(db, userId);
      const incoming = body.text as { quietHours?: Record<string, unknown> };
      const text = await saveResidentTextSettings(db, userId, {
        ...current,
        quietHours: { ...current.quietHours, ...(incoming.quietHours ?? {}) },
      });
      if (!body.preferences) {
        const sms = await resolveSmsAvailability(auth.ctx);
        return NextResponse.json({ categories: NOTIFICATION_CATEGORIES, preferences: await loadNotificationPreferences(db, userId), text, sms });
      }
    }
    if (!body.preferences || typeof body.preferences !== "object") {
      return NextResponse.json({ error: "preferences must be an object." }, { status: 400 });
    }

    const { data: row, error: readError } = await db
      .from("notification_preferences")
      .select("row_data")
      .eq("user_id", userId)
      .maybeSingle();
    if (readError) {
      return NextResponse.json({ error: "Could not load notification preferences." }, { status: 500 });
    }

    const current = normalizeNotificationPreferences(row?.row_data ?? null);
    const merged = applyPreferencesPatch(current, body.preferences);
    const saved = await saveNotificationPreferences(db, userId, merged);
    const [sms, text] = await Promise.all([resolveSmsAvailability(auth.ctx), loadResidentTextSettings(db, userId)]);

    return NextResponse.json({ categories: NOTIFICATION_CATEGORIES, preferences: saved, text, sms });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not save notification preferences.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
