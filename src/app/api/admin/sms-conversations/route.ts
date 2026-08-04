import { NextResponse } from "next/server";
import { isAdminUser } from "@/lib/auth/admin-preview";
import {
  resolveAdminForwardPhone,
  resolveManagerUserIdForPhone,
} from "@/lib/claw-resident-messaging.server";
import { unloggedSmsWarning } from "@/lib/manager-sms-messages";
import { fetchAdminSmsConversations } from "@/lib/manager-sms-messages.server";
import { sendFromManagerWorkNumber } from "@/lib/proplane-sms-transport.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { normalizeE164 } from "@/lib/twilio";

export const runtime = "nodejs";

async function requireAdmin() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized." }, { status: 401 }) };
  if (!(await isAdminUser(user.id))) {
    return { error: NextResponse.json({ error: "Admin access required." }, { status: 403 }) };
  }
  return { user, db: createSupabaseServiceRoleClient() };
}

/**
 * Admin Communication → SMS: grouped per-counterparty threads on the shared
 * agent line across the mapped-manager cohort — so admin can choose a specific
 * conversation rather than reading one flat stream.
 */
export async function GET() {
  const auth = await requireAdmin();
  if ("error" in auth) return auth.error;

  try {
    const payload = await fetchAdminSmsConversations(auth.db);
    return NextResponse.json(payload, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to load SMS conversations.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * Admin sends an SMS to a resident or a manager on the shared line. The message
 * is logged into the owning manager's thread (so it shows for both admin and
 * that manager), and a COPY is sent to the admin oversight phone so admin stays
 * in the loop. The recipient phone is the ONLY model-free routing input.
 */
export async function POST(req: Request) {
  const auth = await requireAdmin();
  if ("error" in auth) return auth.error;

  const body = (await req.json().catch(() => ({}))) as {
    toPhone?: string;
    text?: string;
    residentUserId?: string | null;
    conversationKey?: string | null;
  };
  const text = String(body.text ?? "").trim();
  if (!text) return NextResponse.json({ error: "Enter a message." }, { status: 400 });
  if (text.length > 1600) {
    return NextResponse.json({ error: "Message is too long (max 1600 characters)." }, { status: 400 });
  }

  const toPhone = normalizeE164(String(body.toPhone ?? "").trim());
  if (!toPhone) return NextResponse.json({ error: "Enter a valid US phone number." }, { status: 400 });

  // Resolve the conversation this belongs to: match an existing thread, else
  // treat the recipient as a manager (by phone). Owner is who the SMS logs to.
  const conversations = await fetchAdminSmsConversations(auth.db);
  const toDigits = toPhone.replace(/\D/g, "");
  // The recipient phone is the ONLY routing input. `residentUserId` used to be
  // accepted here too, which let the caller pick the conversation — and with it
  // the `ownerManagerUserId` this message is sent *as* — independently of the
  // number being texted. Routing must follow the number, not the body.
  const phoneMatches = conversations.residents.filter((r) => {
    const phoneDigits = String(r.phone ?? "").replace(/\D/g, "");
    return Boolean(phoneDigits) && (phoneDigits === toDigits || phoneDigits.endsWith(toDigits.slice(-10)));
  });
  // One phone on the shared line can be both a prospect and a resident
  // conversation, so the admin may name the thread they are looking at — but
  // only to disambiguate *within* the threads that already match this number.
  const replyKey = String(body.conversationKey ?? "").trim();
  const match =
    (replyKey ? phoneMatches.find((r) => r.conversationKey === replyKey) : null) ?? phoneMatches[0];

  let ownerManagerUserId = String(match?.ownerManagerUserId ?? "").trim();
  let counterpartyRole = match?.counterpartyRole;
  if (!ownerManagerUserId) {
    const managerId = await resolveManagerUserIdForPhone(toPhone);
    if (managerId) {
      ownerManagerUserId = managerId;
      counterpartyRole = "manager";
    }
  }
  // Fall back to the shared-line anchor manager so a brand-new number still
  // logs somewhere consistent rather than being dropped.
  if (!ownerManagerUserId) {
    ownerManagerUserId = String(conversations.residents[0]?.ownerManagerUserId ?? "").trim();
  }
  if (!ownerManagerUserId) {
    return NextResponse.json(
      { error: "No manager is registered on the shared line yet to route this message." },
      { status: 400 },
    );
  }

  // Log attribution must never come straight from the request body: an
  // unvalidated `residentUserId` threads this message under an unrelated
  // resident's conversation_key, corrupting the audit trail. Accept the
  // client's value only when it names a resident in the conversation cohort
  // that actually belongs to the resolved owning manager; otherwise drop it.
  const attributedResidentUserId =
    match?.residentUserId ??
    (body.residentUserId &&
    conversations.residents.some(
      (r) => r.residentUserId === body.residentUserId && r.ownerManagerUserId === ownerManagerUserId,
    )
      ? body.residentUserId
      : null);

  const result = await sendFromManagerWorkNumber({
    managerUserId: ownerManagerUserId,
    to: toPhone,
    text,
    residentUserId: attributedResidentUserId,
    source: "work_number",
    counterpartyRole,
  });
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error === "recipient_opted_out" ? "That number has opted out of texts." : "Could not send SMS." },
      { status: 502 },
    );
  }

  // Copy to the admin oversight phone (admin profile's own number). skipLog so
  // the CC never becomes its own thread. Best-effort — never fail the send.
  try {
    const adminPhone = await resolveAdminForwardPhone();
    if (adminPhone && adminPhone.replace(/\D/g, "") !== toDigits) {
      const label = match?.name || toPhone;
      await sendFromManagerWorkNumber({
        managerUserId: ownerManagerUserId,
        to: adminPhone,
        text: `[Admin → ${label}] ${text}`.slice(0, 1600),
        source: "work_number",
        skipLog: true,
      });
    }
  } catch (e) {
    console.error("admin sms CC failed", e instanceof Error ? e.message : e);
  }

  if (result.logged === false) {
    // Same rule as the manager composer: never report a clean success for a
    // human-composed text whose row is missing — that row is the takeover
    // signal, and failing the request would only produce a duplicate send.
    console.error("admin sms reply sent but manager_sms_messages row did not land", {
      managerUserId: ownerManagerUserId,
      source: "work_number",
    });
    return NextResponse.json({
      ok: true,
      channel: result.channel,
      sid: result.sid,
      ccAdmin: true,
      smsLogged: false,
      warning: unloggedSmsWarning("work_number"),
    });
  }

  return NextResponse.json({ ok: true, channel: result.channel, sid: result.sid, ccAdmin: true });
}
