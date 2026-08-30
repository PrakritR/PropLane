import { createHash, randomInt } from "node:crypto";
import { NextResponse } from "next/server";
import { managerContactSmsPhoneForPublicCta } from "@/lib/claw-leasing-links";
import { scheduleManagerMessagingReady } from "@/lib/proplane-sms-transport.server";
import { sendSms } from "@/lib/twilio";
import { createTwilioRestClient, twilioErrorFields } from "@/lib/twilio-client.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

/**
 * When TWILIO_VERIFY_SERVICE_SID is set, OTPs go through Twilio Verify instead
 * of our hand-rolled sendSms code path. Verify traffic needs NO A2P 10DLC
 * campaign and no owned phone number, so phone verification works even while
 * the messaging campaign is still in carrier review. The custom path remains
 * as the fallback when the env var is absent.
 */
function verifyServiceSid(): string | null {
  return process.env.TWILIO_VERIFY_SERVICE_SID?.trim() || null;
}

function twilioRestClient() {
  return createTwilioRestClient();
}

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const MAX_SENDS_PER_WINDOW = 5;
const SEND_WINDOW_MS = 60 * 60 * 1000;
const RESEND_THROTTLE_MS = 60 * 1000;

function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

function normalizeUsPhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

type VerificationRow = {
  created_at?: unknown;
  send_count?: unknown;
  first_sent_at?: unknown;
  phone?: unknown;
  code_hash?: unknown;
  expires_at?: unknown;
  attempts?: unknown;
};

/**
 * Undo the throttle row written just before a send attempt that then failed.
 *
 * The row is upserted BEFORE the provider call so a delivered code can never
 * race ahead of its own rate limit. The cost was that a send which never left
 * the building - unconfigured Twilio, a Verify API error - still left a fresh
 * `created_at` behind, so every retry answered "Code already sent - wait a
 * minute before retrying" for a code the person never received, and each dead
 * attempt burned one of the five sends allowed per hour. Restoring the prior
 * row (or deleting it when there was none) keeps the throttle counting only
 * codes that actually went out, and leaves an earlier still-valid code usable.
 */
async function rollBackFailedSend(
  db: ReturnType<typeof createSupabaseServiceRoleClient>,
  userId: string,
  prior: VerificationRow | null,
): Promise<void> {
  try {
    if (!prior) {
      await db.from("phone_verifications").delete().eq("user_id", userId);
      return;
    }
    await db.from("phone_verifications").upsert(
      {
        user_id: userId,
        phone: prior.phone,
        code_hash: prior.code_hash,
        expires_at: prior.expires_at,
        attempts: prior.attempts ?? 0,
        send_count: prior.send_count ?? 0,
        first_sent_at: prior.first_sent_at ?? null,
        created_at: prior.created_at,
      },
      { onConflict: "user_id" },
    );
  } catch {
    /* best effort - the caller is already reporting the send failure */
  }
}

/**
 * Pull the operator-actionable part of a Twilio REST failure.
 *
 * The SDK surfaces `code` most readily, so a dead credential logged as bare
 * `code: 8021` and nothing else - unreadable without looking the number up.
 * That number means "required permission twilio/verify/service/read is
 * missing": a restricted API key with no Verify scope, which NO retry can fix.
 * Telling the person "try again shortly" for that is a lie that loops forever,
 * so a 401/403 is reported as a setup fault instead, and the log carries
 * Twilio's own sentence. Never returned to the client - it names account ids.
 */
function twilioFailureDetail(e: unknown): {
  code?: string;
  status?: number;
  message?: string;
  misconfigured: boolean;
} {
  const err = (typeof e === "object" && e ? e : {}) as Record<string, unknown>;
  const status = typeof err.status === "number" ? err.status : undefined;
  return {
    code: err.code === undefined ? undefined : String(err.code),
    status,
    message: typeof err.message === "string" ? err.message : undefined,
    // 401/403 is a credential or permission fault an operator must fix, never
    // a transient condition the caller can retry past.
    misconfigured: status === 401 || status === 403,
  };
}

async function requireUser() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

/** GET — current phone settings for the signed-in user. */
export async function GET() {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const db = createSupabaseServiceRoleClient();
  const { data } = await db
    .from("profiles")
    .select("phone, phone_verified_at, sms_forward_inbound, sms_from_number")
    .eq("id", user.id)
    .maybeSingle();
  const rawWorkNumber = data?.sms_from_number ?? null;
  const { clawLeasingAgentPhoneE164, isClawSharedLineBridgeEnabled } = await import(
    "@/lib/claw-leasing-links"
  );
  const { isClawMessengerConfigured } = await import("@/lib/claw-messenger.server");
  const workNumber = isClawSharedLineBridgeEnabled()
    ? clawLeasingAgentPhoneE164()
    : managerContactSmsPhoneForPublicCta(rawWorkNumber);
  if (!workNumber && rawWorkNumber) {
    scheduleManagerMessagingReady(user.id);
  } else if (isClawSharedLineBridgeEnabled() && rawWorkNumber !== clawLeasingAgentPhoneE164()) {
    scheduleManagerMessagingReady(user.id);
  }
  const { resolveListingCtaSmsPhone } = await import("@/lib/listing-cta-phone.server");
  // An unexpired code this user already has in their texts. Without it, a
  // reload (or any remount) loses the client-only "code sent" flag and hides
  // the code box, while the resend throttle refuses to issue another one - a
  // dead end with a perfectly good code sitting on their phone.
  const { data: pending } = await db
    .from("phone_verifications")
    .select("phone, expires_at")
    .eq("user_id", user.id)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  return NextResponse.json({
    phone: data?.phone ?? null,
    phoneVerifiedAt: data?.phone_verified_at ?? null,
    pendingVerification: pending
      ? {
          phone: String(pending.phone ?? ""),
          expiresAt: String(pending.expires_at ?? ""),
        }
      : null,
    forwardInbound: data?.sms_forward_inbound !== false,
    workNumber,
    // Number this manager's OWN listing CTAs text — production routes to their
    // verified personal phone, dev/preview to the shared Claw line. `null` when
    // they have none, so preview CTAs fall back to the web links exactly like a
    // published listing would.
    listingCtaPhone: resolveListingCtaSmsPhone({
      phone: data?.phone ?? null,
      phone_verified_at: data?.phone_verified_at ?? null,
      sms_from_number: rawWorkNumber,
    }),
    smsConfigured:
      isClawMessengerConfigured() ||
      Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN),
    messagingChannel: isClawMessengerConfigured()
      ? "claw"
      : process.env.TWILIO_ACCOUNT_SID
        ? "twilio"
        : null,
  });
}

/** POST — start verification: send a 6-digit code to the given phone. */
export async function POST(req: Request) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { phone?: string };
  const phone = normalizeUsPhone(String(body.phone ?? ""));
  if (!phone) return NextResponse.json({ error: "Enter a valid US phone number." }, { status: 400 });

  const db = createSupabaseServiceRoleClient();

  const { data: existing } = await db
    .from("phone_verifications")
    .select(
      "created_at, send_count, first_sent_at, phone, code_hash, expires_at, attempts",
    )
    .eq("user_id", user.id)
    .maybeSingle();
  // Snapshot taken before the upsert below overwrites the row — this is what a
  // failed send is rolled back to.
  const priorVerification: VerificationRow | null = existing ? { ...existing } : null;

  // Per-user resend throttle (>=60s between sends).
  if (existing && Date.now() - Date.parse(String(existing.created_at)) < RESEND_THROTTLE_MS) {
    return NextResponse.json({ error: "Code already sent — wait a minute before retrying." }, { status: 429 });
  }

  // Absolute send cap within a rolling window (does NOT reset on resend) —
  // bounds brute-force to MAX_SENDS × MAX_ATTEMPTS guesses per window and
  // prevents SMS-bombing a number by repeatedly re-sending.
  const windowStart = existing?.first_sent_at ? Date.parse(String(existing.first_sent_at)) : Date.now();
  const withinWindow = Date.now() - windowStart < SEND_WINDOW_MS;
  const priorSends = withinWindow ? Number(existing?.send_count ?? 0) : 0;
  if (priorSends >= MAX_SENDS_PER_WINDOW) {
    return NextResponse.json(
      { error: "Too many verification attempts — try again later." },
      { status: 429 },
    );
  }

  // Per-TARGET throttle: block bombing an arbitrary victim number by ensuring
  // no OTHER user has an active (recent) code out to the same phone.
  const { data: targetActive } = await db
    .from("phone_verifications")
    .select("user_id, created_at")
    .eq("phone", phone)
    .neq("user_id", user.id)
    .gt("created_at", new Date(Date.now() - RESEND_THROTTLE_MS).toISOString())
    .limit(1);
  if ((targetActive ?? []).length > 0) {
    return NextResponse.json({ error: "That number was just sent a code — try again shortly." }, { status: 429 });
  }

  const usingVerify = Boolean(verifyServiceSid());
  const code = String(randomInt(100000, 999999));
  const nowIso = new Date().toISOString();
  const { error } = await db.from("phone_verifications").upsert(
    {
      user_id: user.id,
      phone,
      // With Verify, Twilio holds the code — this hash is an unmatched
      // placeholder that keeps the row shape (throttles/attempts) identical.
      code_hash: usingVerify ? hashCode(`verify:${phone}:${nowIso}`) : hashCode(code),
      expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString(),
      attempts: 0,
      send_count: priorSends + 1,
      first_sent_at: withinWindow && existing?.first_sent_at ? existing.first_sent_at : nowIso,
      created_at: nowIso,
    },
    { onConflict: "user_id" },
  );
  if (error) {
    console.error("phone verification state write failed", { userId: user.id, code: error.code });
    return NextResponse.json({ error: "Could not start phone verification." }, { status: 500 });
  }

  if (usingVerify) {
    const client = twilioRestClient();
    if (!client) {
      await rollBackFailedSend(db, user.id, priorVerification);
      return NextResponse.json({ error: "SMS is not configured yet — add Twilio credentials." }, { status: 502 });
    }
    try {
      await client.verify.v2.services(verifyServiceSid()!).verifications.create({ to: phone, channel: "sms" });
      return NextResponse.json({ ok: true });
    } catch (e) {
      const detail = twilioFailureDetail(e);
      // Log the FULL Twilio error (message + more_info URL + HTTP status), not
      // just the code — an undocumented code like 8021 is meaningless alone, and
      // the message names the real cause (e.g. a Verify Service SID that belongs
      // to a different Twilio account than the API key). `serviceSid` is a
      // resource id, not a secret, and pins which service was called.
      console.error("Twilio Verify send failed", {
        userId: user.id,
        serviceSid: verifyServiceSid(),
        ...detail,
        ...twilioErrorFields(e),
      });
      await rollBackFailedSend(db, user.id, priorVerification);
      return NextResponse.json(
        {
          error: detail.misconfigured
            ? "Text verification is not set up on this deployment yet. The details are in the server log for an operator."
            : "Could not send verification code. Try again shortly.",
        },
        { status: detail.misconfigured ? 503 : 502 },
      );
    }
  }

  // The managed launch reserves the Auth Token for webhook signatures and
  // requires Twilio Verify for OTP traffic. Never fall back to a manager work
  // number or the ordinary A2P outbox for a verification code.
  if (process.env.SMS_RUNTIME_ENABLED?.trim() === "1") {
    await rollBackFailedSend(db, user.id, priorVerification);
    return NextResponse.json(
      { error: "Phone verification is not configured yet." },
      { status: 503 },
    );
  }

  const fromNumber =
    (await db.from("profiles").select("sms_from_number").eq("id", user.id).maybeSingle()).data?.sms_from_number ??
    process.env.TWILIO_DEFAULT_FROM ??
    "";
  // Verification OTP is a compliance/re-opt-in message — it must send even if a
  // prior STOP recorded an opt-out (the user is actively opting back in here).
  const sent = await sendSms(
    phone,
    `Your PropLane verification code is ${code}. It expires in 10 minutes.`,
    String(fromNumber),
    { skipOptOutCheck: true },
  );
  if (!sent.sent) {
    console.error("legacy phone verification SMS failed", { userId: user.id, reason: sent.error });
    await rollBackFailedSend(db, user.id, priorVerification);
    return NextResponse.json(
      { error: "Could not send verification code. Try again shortly." },
      { status: 502 },
    );
  }
  return NextResponse.json({ ok: true });
}

/** PUT — confirm the code; stores the verified phone on the profile. */
export async function PUT(req: Request) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { code?: string };
  const code = String(body.code ?? "").trim();
  if (!/^\d{6}$/.test(code)) return NextResponse.json({ error: "Enter the 6-digit code." }, { status: 400 });

  const db = createSupabaseServiceRoleClient();
  const { data: row } = await db.from("phone_verifications").select("*").eq("user_id", user.id).maybeSingle();
  if (!row) return NextResponse.json({ error: "No verification in progress." }, { status: 400 });
  if (Date.parse(String(row.expires_at)) < Date.now()) {
    return NextResponse.json({ error: "Code expired — request a new one." }, { status: 400 });
  }
  if (Number(row.attempts ?? 0) >= MAX_ATTEMPTS) {
    return NextResponse.json({ error: "Too many attempts — request a new code." }, { status: 429 });
  }

  if (verifyServiceSid()) {
    const client = twilioRestClient();
    if (!client) return NextResponse.json({ error: "SMS is not configured." }, { status: 502 });
    let approved = false;
    try {
      const check = await client.verify.v2
        .services(verifyServiceSid()!)
        .verificationChecks.create({ to: String(row.phone), code });
      approved = check.status === "approved";
    } catch {
      approved = false;
    }
    if (!approved) {
      await db
        .from("phone_verifications")
        .update({ attempts: Number(row.attempts ?? 0) + 1 })
        .eq("user_id", user.id);
      return NextResponse.json({ error: "Incorrect code." }, { status: 400 });
    }
  } else if (hashCode(code) !== String(row.code_hash)) {
    await db
      .from("phone_verifications")
      .update({ attempts: Number(row.attempts ?? 0) + 1 })
      .eq("user_id", user.id);
    return NextResponse.json({ error: "Incorrect code." }, { status: 400 });
  }

  const { error } = await db
    .from("profiles")
    .update({ phone: String(row.phone), phone_verified_at: new Date().toISOString() })
    .eq("id", user.id);
  if (error) {
    console.error("verified phone profile write failed", { userId: user.id, code: error.code });
    return NextResponse.json({ error: "Could not save verified phone." }, { status: 500 });
  }
  await db.from("phone_verifications").delete().eq("user_id", user.id);

  // First verified personal phone → PropLane messaging assistant intro (idempotent).
  try {
    const { maybeSendManagerPropLaneAssistantIntro } = await import("@/lib/claw-onboarding-sms.server");
    await maybeSendManagerPropLaneAssistantIntro(db, user.id);
  } catch {
    /* non-critical */
  }

  return NextResponse.json({ ok: true, phone: row.phone });
}

/** PATCH — update SMS preferences (inbound forwarding toggle). */
export async function PATCH(req: Request) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { forwardInbound?: boolean };
  if (typeof body.forwardInbound !== "boolean") {
    return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
  }
  const db = createSupabaseServiceRoleClient();
  const { error } = await db
    .from("profiles")
    .update({ sms_forward_inbound: body.forwardInbound })
    .eq("id", user.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
