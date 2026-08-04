/**
 * Durable Claw two-way messaging: manager personal phone ↔ resident phone
 * via the shared agent line (payment / lease / move-in / leasing).
 */

import { listAdminUserIds } from "@/lib/auth/admin-role";
import {
  clawLeasingAgentPhoneE164,
  normalizeE164Us,
} from "@/lib/claw-messenger.server";
import { isLegacyClawSharedSmsNumber, legacyClawSharedPhoneDigits } from "@/lib/claw-leasing-links";
import { residentPortalUrl } from "@/lib/claw-resident-links";
import { isPortalSandboxEmail } from "@/lib/portal-sandbox-accounts";
import { sendFromManagerWorkNumber, sendPropLaneSms } from "@/lib/proplane-sms-transport.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { notifyManagerOfInboundSms, upsertManagerInboxNotice } from "@/lib/sms-inbox-notice.server";

export type ClawThreadTopic =
  | "payment"
  | "lease"
  | "leasing"
  | "move_in"
  | "general"
  | "applications"
  | "maintenance"
  | "services";

export type ClawMessagingThread = {
  id: string;
  managerUserId: string;
  managerPhone: string;
  residentPhone: string;
  residentUserId: string | null;
  residentEmail: string | null;
  topic: ClawThreadTopic;
  lastMessageAt: string;
};

const TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Default test / staging pairing when no durable thread exists yet. */
const DEFAULT_MANAGER_PHONE = "+15103098345";
const DEFAULT_RESIDENT_PHONE = "+15105794001";

function threadId(managerUserId: string, residentPhone: string): string {
  return `claw_thread_${managerUserId}_${residentPhone.replace(/\D/g, "")}`;
}

/**
 * Admin ops cell for shared-line trial forwarding — DB-backed on the Axis
 * admin account's own profile (any account identified by admin-role.ts:
 * `profile_roles`, legacy `profiles.role`, or the primary-admin email) so
 * updating Settings → Phone re-points every forward without an env/redeploy.
 * Falls back to the configured env phone / hardcoded trial default when no
 * admin profile has a phone on file yet. Cached for a few seconds because a
 * single inbound SMS resolves it several times.
 */
const ADMIN_FORWARD_PHONE_TTL_MS = 5000;
let adminForwardPhoneCache: { phone: string; expiresAt: number } | null = null;

export async function resolveAdminForwardPhone(): Promise<string> {
  const now = Date.now();
  if (adminForwardPhoneCache && adminForwardPhoneCache.expiresAt > now) {
    return adminForwardPhoneCache.phone;
  }
  let resolved: string | null = null;
  try {
    const db = createSupabaseServiceRoleClient();
    const adminIds = await listAdminUserIds(db);
    if (adminIds.length > 0) {
      const { data } = await db
        .from("profiles")
        .select("id, phone")
        .in("id", adminIds)
        .not("phone", "is", null)
        .order("id");
      for (const row of (data ?? []) as { phone?: unknown }[]) {
        const phone = normalizeE164Us(String(row.phone ?? ""));
        if (phone) {
          resolved = phone;
          break;
        }
      }
    }
  } catch {
    /* fall through to env / hardcoded default */
  }
  const env = clawManagerForwardPhonesFromEnv();
  const phone = resolved ?? env[0] ?? DEFAULT_MANAGER_PHONE;
  adminForwardPhoneCache = { phone, expiresAt: now + ADMIN_FORWARD_PHONE_TTL_MS };
  return phone;
}

export function clawManagerForwardPhonesFromEnv(): string[] {
  return (process.env.CLAW_MESSENGER_MANAGER_FORWARD_PHONES ?? "")
    .split(",")
    .map((s) => normalizeE164Us(s.trim()))
    .filter((p): p is string => Boolean(p));
}

export function clawManagerDebounceBypassPhones(): string[] {
  return [...new Set([...clawManagerForwardPhonesFromEnv(), DEFAULT_MANAGER_PHONE])];
}

/** Default resident phone for manager→resident relay when no thread is open. */
export function clawDefaultResidentPhoneFromEnv(): string | null {
  const fromEnv = normalizeE164Us((process.env.CLAW_MESSENGER_DEFAULT_RESIDENT_PHONE ?? "").trim());
  if (fromEnv) return fromEnv;
  // Known local/test pairing used throughout the Claw messaging work.
  return DEFAULT_RESIDENT_PHONE;
}

/** SMS body the resident sees when their manager texts the agent line. */
export function labelClawSmsFromManager(text: string): string {
  const body = text.trim() || "(empty)";
  return `(Your property manager)\n${body}`;
}

/**
 * Carbon-copy to the manager when PropLane sends an automated text to the resident.
 * Resident still gets the plain message; manager sees property + resident + sent body.
 */
export function labelClawSmsFromPropLaneForManager(
  text: string,
  opts?: {
    propertyLabel?: string | null;
    residentName?: string | null;
    residentPhone?: string | null;
  },
): string {
  const body = text.trim() || "(empty)";
  const property = opts?.propertyLabel?.trim() || "Unknown property";
  const name = opts?.residentName?.trim() || "Resident";
  const phone = opts?.residentPhone?.trim() || "";
  const residentLine = phone ? `${name} (${phone})` : name;
  return [`Property: ${property}`, `Resident: ${residentLine}`, `Sent: ${body}`].join("\n");
}

/** Fallback when we only know the phone (no profile resolved yet). */
export function labelClawSmsFromResident(text: string, residentPhone?: string | null): string {
  const body = text.trim() || "(empty)";
  const phone = residentPhone?.trim() || "";
  return [
    "Property: Unknown property",
    `Resident: ${phone ? `Resident (${phone})` : "Resident"}`,
    `Said: ${body}`,
  ].join("\n");
}

/**
 * Explicit, optional ADDITIONS to the shared-line manager roster (e.g. an ops
 * cell that needs command access before its profile is fully provisioned).
 * Empty by default — DB-driven registration (`resolveRegisteredClawManagers`)
 * is the source of truth for who participates in the shared Claw line.
 */
export function clawMappedManagerEmails(): string[] {
  return (process.env.CLAW_MESSENGER_MANAGER_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * DB-driven shared-line registration: any manager whose profile is stamped
 * with the shared Claw agent number participates automatically — every
 * manager gets that stamp at onboarding (`assignSharedClawLeasingNumberToManager`)
 * and it's swept nightly for stragglers (`backfillManagerWorkNumbers`), so
 * "has an account" already implies "registered" with no separate opt-in step.
 * Sandbox/demo accounts (`isPortalSandboxEmail`) are excluded here — this is
 * the single choke point that keeps demo/test rows out of every shared-line
 * lookup (default listing, manager-phone recognition, notification fan-out)
 * downstream, not just the public catalog.
 * Ordered oldest-registered-first — the deterministic anchor manager when an
 * inbound text names no specific listing.
 */
export async function resolveRegisteredClawManagers(): Promise<
  Array<{ userId: string; email: string; fullName: string | null; personalPhone: string | null }>
> {
  const db = createSupabaseServiceRoleClient();
  // profiles.sms_from_number and phone_verified_at are settable by ANY
  // authenticated user (GET/POST/PUT /api/manager/phone have no role check —
  // any resident/vendor can verify their own phone, and the shared Claw line
  // auto-stamps sms_from_number on that same route). The role filter below is
  // what keeps a non-manager account from self-registering onto the shared
  // line's manager roster (and, via isMappedManagerPhone, the manager-command
  // surface) purely by verifying their own phone.
  // Query only rows stamped with the shared Claw line itself — per-manager
  // Twilio numbers must not consume the row cap and push shared-line managers
  // out of the roster. Stamps are written as E.164 (`assignSharedClawLeasingNumberToManager`);
  // the digit variants cover any legacy formatting, and the
  // isLegacyClawSharedSmsNumber re-check below stays as the authority.
  const sharedLineVariants = [...legacyClawSharedPhoneDigits()].flatMap((d) => {
    const national = d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
    return [`+${d}`, d, `+1${national}`, `1${national}`, national];
  });
  const { data } = await db
    .from("profiles")
    .select("id, email, full_name, phone, phone_verified_at, sms_from_number, role, created_at")
    .in("sms_from_number", [...new Set(sharedLineVariants)])
    .in("role", ["manager", "pro", "admin", "owner"])
    .order("created_at", { ascending: true })
    .limit(500);

  if ((data?.length ?? 0) >= 500) {
    console.error(
      "[claw-messaging] resolveRegisteredClawManagers hit the 500-row cap — newer shared-line managers may be missing from the roster",
    );
  }

  const out: Array<{ userId: string; email: string; fullName: string | null; personalPhone: string | null }> = [];
  for (const row of data ?? []) {
    const smsFromNumber = String((row as { sms_from_number?: unknown }).sms_from_number ?? "");
    if (!isLegacyClawSharedSmsNumber(smsFromNumber)) continue;
    const email = String((row as { email?: unknown }).email ?? "").trim().toLowerCase();
    if (!email || isPortalSandboxEmail(email)) continue;
    const userId = String((row as { id?: unknown }).id ?? "").trim();
    if (!userId) continue;
    // Manager identity on the shared line must come from a VERIFIED phone —
    // an unverified profiles.phone is user-editable and forgeable.
    const verified = Boolean((row as { phone_verified_at?: string | null }).phone_verified_at);
    const personalPhone = verified
      ? normalizeE164Us(String((row as { phone?: unknown }).phone ?? "")) || null
      : null;
    out.push({
      userId,
      email,
      fullName: String((row as { full_name?: unknown }).full_name ?? "").trim() || null,
      personalPhone,
    });
  }
  return out;
}

export async function resolveMappedManagerContacts(): Promise<
  Array<{ userId: string; email: string; fullName: string | null; personalPhone: string | null }>
> {
  const registered = await resolveRegisteredClawManagers();
  const byEmail = new Map(registered.map((m) => [m.email, m] as const));

  const extraEmails = clawMappedManagerEmails().filter((e) => !isPortalSandboxEmail(e) && !byEmail.has(e));
  if (extraEmails.length > 0) {
    const db = createSupabaseServiceRoleClient();
    const { data } = await db
      .from("profiles")
      .select("id, email, full_name, phone, phone_verified_at, role")
      .in("email", extraEmails)
      .in("role", ["manager", "pro", "admin", "owner"]);
    for (const row of data ?? []) {
      const email = String((row as { email?: unknown }).email ?? "").trim().toLowerCase();
      if (!email || isPortalSandboxEmail(email)) continue;
      const userId = String((row as { id?: unknown }).id ?? "").trim();
      if (!userId) continue;
      const verified = Boolean((row as { phone_verified_at?: string | null }).phone_verified_at);
      byEmail.set(email, {
        userId,
        email,
        fullName: String((row as { full_name?: unknown }).full_name ?? "").trim() || null,
        personalPhone: verified
          ? normalizeE164Us(String((row as { phone?: unknown }).phone ?? "")) || null
          : null,
      });
    }
  }

  return [...byEmail.values()];
}

export async function isMappedManagerPhone(fromE164: string): Promise<boolean> {
  const envPhones = new Set(clawManagerForwardPhonesFromEnv());
  if (envPhones.has(fromE164)) return true;
  if (fromE164 === (await resolveAdminForwardPhone())) return true;
  const managers = await resolveMappedManagerContacts();
  return managers.some((m) => m.personalPhone === fromE164);
}

async function resolveManagerPersonalPhone(managerUserId: string): Promise<string | null> {
  const db = createSupabaseServiceRoleClient();
  const { data } = await db.from("profiles").select("phone, email").eq("id", managerUserId).maybeSingle();
  const fromProfile = normalizeE164Us(String((data as { phone?: unknown } | null)?.phone ?? ""));
  if (fromProfile) return fromProfile;
  const email = String((data as { email?: unknown } | null)?.email ?? "")
    .trim()
    .toLowerCase();
  const mapped = await resolveMappedManagerContacts();
  const match = mapped.find((m) => m.userId === managerUserId || m.email === email);
  if (match?.personalPhone) return match.personalPhone;
  // The env / hardcoded pairing is the trial default ONLY for managers
  // explicitly listed in CLAW_MESSENGER_MANAGER_EMAILS — DB-registered
  // managers are not in the trial. A manager outside that explicit list with
  // no phone on file gets no SMS — never route another landlord's resident
  // traffic to the default cell.
  if (!match || !clawMappedManagerEmails().includes(match.email)) return null;
  return resolveAdminForwardPhone();
}

export async function resolveManagerUserIdForPhone(managerPhone: string): Promise<string | null> {
  const phone = normalizeE164Us(managerPhone);
  if (!phone) return null;
  const managers = await resolveMappedManagerContacts();
  const byPhone = managers.filter((m) => m.personalPhone === phone && m.userId);
  if (byPhone.length > 1) return null;
  if (byPhone.length === 1) return byPhone[0].userId;
  // Env-forwarded manager cell with no profile phone match → first manager
  // explicitly listed in CLAW_MESSENGER_MANAGER_EMAILS (trial scope only) —
  // never a DB-registered manager, whose residents the trial cell holder must
  // not be able to text as "(Your property manager)".
  if (clawManagerForwardPhonesFromEnv().includes(phone) || phone === (await resolveAdminForwardPhone())) {
    const explicit = clawMappedManagerEmails();
    return managers.find((m) => m.userId && explicit.includes(m.email))?.userId ?? null;
  }
  return null;
}

function rowToThread(row: Record<string, unknown>): ClawMessagingThread {
  return {
    id: String(row.id ?? ""),
    managerUserId: String(row.manager_user_id ?? ""),
    managerPhone: String(row.manager_phone ?? ""),
    residentPhone: String(row.resident_phone ?? ""),
    residentUserId: row.resident_user_id ? String(row.resident_user_id) : null,
    residentEmail: row.resident_email ? String(row.resident_email) : null,
    topic: (String(row.topic ?? "general") as ClawThreadTopic) || "general",
    lastMessageAt: String(row.last_message_at ?? new Date().toISOString()),
  };
}

/**
 * Open / refresh a manager↔resident thread after Axis sends an SMS
 * (payment reminder, lease reminder, move-in, etc.).
 */
export async function openClawResidentThread(args: {
  managerUserId: string;
  residentPhone: string;
  residentUserId?: string | null;
  residentEmail?: string | null;
  topic: ClawThreadTopic;
  /**
   * false → an existing thread keeps its last_message_at (automated/cron sends
   * must not steal manager-reply routing from the resident who last actually
   * talked). New threads always stamp now.
   */
  bumpLastMessage?: boolean;
}): Promise<ClawMessagingThread | null> {
  const managerUserId = args.managerUserId.trim();
  const residentPhone = normalizeE164Us(args.residentPhone);
  if (!managerUserId || !residentPhone) return null;
  if (residentPhone === clawLeasingAgentPhoneE164()) return null;
  if (await isMappedManagerPhone(residentPhone)) return null;

  const managerPhone = await resolveManagerPersonalPhone(managerUserId);
  if (!managerPhone) return null;

  const db = createSupabaseServiceRoleClient();
  const id = threadId(managerUserId, residentPhone);
  const now = new Date().toISOString();

  if (args.bumpLastMessage === false) {
    const { data: existing } = await db
      .from("claw_messaging_threads")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (existing) {
      const updates: Record<string, unknown> = { topic: args.topic };
      if (args.residentUserId?.trim()) updates.resident_user_id = args.residentUserId.trim();
      if (args.residentEmail?.trim()) updates.resident_email = args.residentEmail.trim().toLowerCase();
      await db.from("claw_messaging_threads").update(updates).eq("id", id);
      return rowToThread({ ...(existing as Record<string, unknown>), ...updates });
    }
  }
  const payload = {
    id,
    manager_user_id: managerUserId,
    manager_phone: managerPhone,
    resident_phone: residentPhone,
    resident_user_id: args.residentUserId?.trim() || null,
    resident_email: args.residentEmail?.trim().toLowerCase() || null,
    topic: args.topic,
    last_message_at: now,
  };

  const { data, error } = await db
    .from("claw_messaging_threads")
    .upsert(payload, { onConflict: "id" })
    .select("*")
    .maybeSingle();

  if (error || !data) {
    return {
      id,
      managerUserId,
      managerPhone,
      residentPhone,
      residentUserId: args.residentUserId?.trim() || null,
      residentEmail: args.residentEmail?.trim().toLowerCase() || null,
      topic: args.topic,
      lastMessageAt: now,
    };
  }

  return rowToThread(data as Record<string, unknown>);
}

export async function findThreadByResidentPhone(
  residentPhone: string,
  managerUserId?: string | null,
): Promise<ClawMessagingThread | null> {
  const phone = normalizeE164Us(residentPhone);
  if (!phone) return null;
  const db = createSupabaseServiceRoleClient();
  const cutoff = new Date(Date.now() - TTL_MS).toISOString();
  let q = db
    .from("claw_messaging_threads")
    .select("*")
    .eq("resident_phone", phone)
    .gte("last_message_at", cutoff);
  if (managerUserId?.trim()) {
    q = q.eq("manager_user_id", managerUserId.trim());
  }
  const { data } = await q.order("last_message_at", { ascending: false }).limit(1).maybeSingle();
  return data ? rowToThread(data as Record<string, unknown>) : null;
}

export async function findLatestThreadForManagerPhone(
  managerPhone: string,
  managerUserId?: string | null,
): Promise<ClawMessagingThread | null> {
  const phone = normalizeE164Us(managerPhone);
  if (!phone) return null;
  const db = createSupabaseServiceRoleClient();
  const cutoff = new Date(Date.now() - TTL_MS).toISOString();
  let q = db
    .from("claw_messaging_threads")
    .select("*")
    .eq("manager_phone", phone)
    .gte("last_message_at", cutoff);
  if (managerUserId?.trim()) {
    q = q.eq("manager_user_id", managerUserId.trim());
  }
  const { data } = await q.order("last_message_at", { ascending: false }).limit(1).maybeSingle();
  return data ? rowToThread(data as Record<string, unknown>) : null;
}

/**
 * Prefer an existing thread for this manager phone; otherwise open one to the
 * configured default resident so the manager can always text without waiting
 * for a payment/lease outbound first.
 */
export async function resolveOrCreateThreadForManagerPhone(
  managerPhone: string,
): Promise<ClawMessagingThread | null> {
  const phone = normalizeE164Us(managerPhone);
  if (!phone) return null;

  const managerUserId = await resolveManagerUserIdForPhone(phone);
  if (!managerUserId) return null;

  const existing = await findLatestThreadForManagerPhone(phone, managerUserId);
  if (existing) return existing;

  const defaultResident = clawDefaultResidentPhoneFromEnv();
  if (!defaultResident || defaultResident === phone) return null;

  return openClawResidentThread({
    managerUserId,
    residentPhone: defaultResident,
    topic: "general",
  });
}

async function touchThread(thread: ClawMessagingThread, topic?: ClawThreadTopic): Promise<void> {
  const db = createSupabaseServiceRoleClient();
  await db
    .from("claw_messaging_threads")
    .update({
      last_message_at: new Date().toISOString(),
      ...(topic ? { topic } : {}),
    })
    .eq("id", thread.id);
}

/**
 * Known resident phone (has a profile) — used to route inbound away from leasing bot
 * even before the first Axis outbound opened a thread.
 */
export async function findResidentProfileByPhone(phone: string): Promise<{
  userId: string;
  email: string;
  managerUserId: string | null;
} | null> {
  const e164 = normalizeE164Us(phone);
  if (!e164) return null;
  const db = createSupabaseServiceRoleClient();
  const { data: profile } = await db
    .from("profiles")
    .select("id, email, role")
    .eq("phone", e164)
    .maybeSingle();
  if (!profile) return null;
  const userId = String((profile as { id?: unknown }).id ?? "").trim();
  const email = String((profile as { email?: unknown }).email ?? "")
    .trim()
    .toLowerCase();
  if (!userId || !email) return null;

  // Prefer an active lease's manager for this resident email.
  const { data: lease } = await db
    .from("portal_lease_pipeline_records")
    .select("manager_user_id")
    .eq("resident_email", email)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  let managerUserId = String((lease as { manager_user_id?: unknown } | null)?.manager_user_id ?? "").trim() || null;

  if (!managerUserId) {
    const { data: app } = await db
      .from("manager_application_records")
      .select("manager_user_id")
      .eq("resident_email", email)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    managerUserId = String((app as { manager_user_id?: unknown } | null)?.manager_user_id ?? "").trim() || null;
  }

  return { userId, email, managerUserId };
}

export async function forwardResidentMessageToManagers(args: {
  fromResident: string;
  text: string;
  thread: ClawMessagingThread;
  /** When set, sent instead of the default "From resident:" wrapper. */
  briefText?: string | null;
  workNumber?: string | null;
}): Promise<{ forwardedTo: string[] }> {
  const targets = new Set<string>();
  if (args.thread.managerPhone) targets.add(args.thread.managerPhone);
  const managers = await resolveMappedManagerContacts();
  for (const m of managers) {
    if (m.userId === args.thread.managerUserId && m.personalPhone) targets.add(m.personalPhone);
  }
  // The env forward phones and the admin ops cell only ever receive traffic
  // for managers inside the shared-line trial scope — explicitly listed in
  // CLAW_MESSENGER_MANAGER_EMAILS, NOT merely DB-registered (which is every
  // real manager platform-wide).
  const explicitTrialEmails = clawMappedManagerEmails();
  const threadManagerInTrial = managers.some(
    (m) => m.userId === args.thread.managerUserId && explicitTrialEmails.includes(m.email),
  );
  if (threadManagerInTrial) {
    for (const p of clawManagerForwardPhonesFromEnv()) targets.add(p);
    targets.add(await resolveAdminForwardPhone());
  }
  targets.delete(args.fromResident);
  targets.delete(clawLeasingAgentPhoneE164());

  const body = args.briefText?.trim() || labelClawSmsFromResident(args.text, args.fromResident);

  const [sent] = await Promise.all([
    Promise.all(
      [...targets].map(async (to) => {
        const send = await sendFromManagerWorkNumber({
          managerUserId: args.thread.managerUserId,
          to,
          text: body,
          fromNumber: args.workNumber,
          // Brief to the manager's personal phone — not a resident SMS thread.
          skipLog: true,
        });
        return send.ok ? to : null;
      }),
    ),
    touchThread(args.thread),
  ]);
  return { forwardedTo: sent.filter((t): t is string => Boolean(t)) };
}

export async function tryRelayManagerReplyViaClaw(args: {
  from: string;
  text: string;
  managerUserId?: string | null;
  workNumber?: string | null;
}): Promise<{ relayed: boolean; to?: string; error?: string }> {
  const from = normalizeE164Us(args.from);
  if (!from) return { relayed: false, error: "invalid_from" };
  if (!(await isMappedManagerPhone(from)) && !args.managerUserId) {
    return { relayed: false };
  }

  const thread = args.managerUserId
    ? await findLatestThreadForManagerPhone(from, args.managerUserId)
    : await resolveOrCreateThreadForManagerPhone(from);
  if (!thread) {
    await sendPropLaneSms({
      to: from,
      text: "(Not delivered)\nNo resident thread is open on this line yet. Message a resident from the portal inbox first, or wait for a resident to text in.",
      fromNumber: args.workNumber,
      log: null,
    });
    return { relayed: false, error: "no_open_thread" };
  }

  const text = (args.text ?? "").trim();
  if (!text) return { relayed: false, error: "empty" };

  const outbound = labelClawSmsFromManager(text);
  const send = await sendFromManagerWorkNumber({
    managerUserId: thread.managerUserId,
    to: thread.residentPhone,
    text: outbound,
    fromNumber: args.workNumber,
    residentUserId: thread.residentUserId,
  });
  if (!send.ok) {
    // Silent failures read as being ignored — tell the manager it didn't land.
    await sendPropLaneSms({
      to: from,
      text: "(Not delivered)\nCouldn't reach the resident by text right now. Try again in a minute or use the portal inbox.",
      fromNumber: args.workNumber,
      log: null,
    }).catch(() => undefined);
    return { relayed: false, error: send.error || "send_failed" };
  }

  await touchThread(thread);
  return { relayed: true, to: thread.residentPhone };
}

/**
 * After PropLane texts a resident, also send a labeled copy to their manager
 * so both sides share the same automated trail.
 */
export async function mirrorAutomatedResidentSmsToManager(args: {
  managerUserId: string;
  residentPhone: string;
  text: string;
  residentUserId?: string | null;
  residentEmail?: string | null;
  topic?: ClawThreadTopic;
  propertyLabel?: string | null;
  residentName?: string | null;
}): Promise<{ mirrored: boolean; to?: string }> {
  const managerUserId = args.managerUserId.trim();
  const residentPhone = normalizeE164Us(args.residentPhone);
  const plain = args.text.trim();
  if (!managerUserId || !residentPhone || !plain) return { mirrored: false };

  const thread = await openClawResidentThread({
    managerUserId,
    residentPhone,
    residentUserId: args.residentUserId,
    residentEmail: args.residentEmail,
    topic: args.topic ?? "general",
    bumpLastMessage: false,
  });
  const managerPhone = thread?.managerPhone || (await resolveManagerPersonalPhone(managerUserId));
  if (!managerPhone || managerPhone === residentPhone) return { mirrored: false };

  let propertyLabel = args.propertyLabel?.trim() || null;
  let residentName = args.residentName?.trim() || null;
  if (!propertyLabel || !residentName) {
    try {
      const db = createSupabaseServiceRoleClient();
      const email = (args.residentEmail || thread?.residentEmail || "").trim().toLowerCase();
      if (!residentName && args.residentUserId) {
        const { data } = await db.from("profiles").select("full_name").eq("id", args.residentUserId).maybeSingle();
        residentName = String((data as { full_name?: unknown } | null)?.full_name ?? "").trim() || null;
      }
      if ((!propertyLabel || !residentName) && email) {
        const { data: app } = await db
          .from("manager_application_records")
          .select("row_data, property_id, assigned_property_id")
          .eq("resident_email", email)
          .eq("manager_user_id", managerUserId)
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        const rowData = (app as { row_data?: Record<string, unknown> } | null)?.row_data ?? {};
        if (!residentName) {
          residentName = String(rowData.name ?? "").trim() || null;
        }
        if (!propertyLabel) {
          propertyLabel =
            String(rowData.propertyTitle ?? "").trim() ||
            String(rowData.property ?? "").trim() ||
            null;
        }
        if (!propertyLabel) {
          const propertyId =
            String((app as { assigned_property_id?: unknown } | null)?.assigned_property_id ?? "").trim() ||
            String((app as { property_id?: unknown } | null)?.property_id ?? "").trim() ||
            String(rowData.propertyId ?? "").trim();
          if (propertyId) {
            const { data: prop } = await db
              .from("manager_property_records")
              .select("property_data, row_data")
              .eq("id", propertyId)
              .maybeSingle();
            const propertyData = (prop as { property_data?: Record<string, unknown> } | null)?.property_data ?? {};
            const propRow = (prop as { row_data?: Record<string, unknown> } | null)?.row_data ?? {};
            propertyLabel =
              String(propertyData.title ?? "").trim() ||
              String(propertyData.buildingName ?? "").trim() ||
              String(propRow.buildingName ?? "").trim() ||
              null;
          }
        }
      }
    } catch {
      /* keep Unknown property / Resident */
    }
  }

  const body = labelClawSmsFromPropLaneForManager(plain, {
    propertyLabel,
    residentName,
    residentPhone,
  });
  const send = await sendFromManagerWorkNumber({
    managerUserId,
    to: managerPhone,
    text: body,
    // Mirror is a manager CC — do not create a fake "resident" SMS thread.
    skipLog: true,
  });
  if (!send.ok) return { mirrored: false };

  return { mirrored: true, to: managerPhone };
}

export function residentInboundAck(topic: ClawThreadTopic): string {
  switch (topic) {
    case "payment":
      return `Got it — I'll make sure they see this about your payment.\n${residentPortalUrl("payments")}`;
    case "lease":
      return `Got it on the lease stuff — they'll reply here.\n${residentPortalUrl("lease")}`;
    case "move_in":
      return `Got it — move-in notes are here if you need them:\n${residentPortalUrl("move_in")}`;
    case "applications":
      return `Got it — they'll follow up on your application.\n${residentPortalUrl("applications")}`;
    case "maintenance":
      return `Got it — they'll get back to you about that.`;
    default:
      return "Got it — I'll make sure your manager sees this.";
  }
}

export async function mirrorResidentTextToManagerInbox(args: {
  thread: ClawMessagingThread;
  from: string;
  text: string;
  service?: string | null;
  subject?: string | null;
  body?: string | null;
}): Promise<void> {
  const db = createSupabaseServiceRoleClient();
  const body =
    args.body?.trim() ||
    [
      `(Text — ${args.thread.topic}) ${args.thread.residentEmail || args.from}`,
      "",
      args.text || "(empty message)",
    ].join("\n");
  await upsertManagerInboxNotice(db, {
    managerUserId: args.thread.managerUserId,
    idPrefix: "claw_resident",
    threadType: "claw_resident_sms",
    from: args.from,
    subject: args.subject?.trim() || `Resident text from ${args.from}`,
    preview: (args.text || body).slice(0, 140) || "(empty)",
    body,
    unread: true,
  });
  // Email leg of the inbound fan-out (inbox notice already written above):
  // reply-tokened so answering the email texts the resident back.
  await notifyManagerOfInboundSms(db, {
    managerUserId: args.thread.managerUserId,
    fromPhone: args.from,
    text: args.text,
    subjectLabel: "Resident text",
    senderLabel: args.thread.residentEmail || null,
    skipInboxNotice: true,
  }).catch(() => ({ inboxNoticeWritten: false, emailSent: false }));
}
