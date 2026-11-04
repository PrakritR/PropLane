import { after, NextResponse } from "next/server";
import { requireVendorApiAccess } from "@/lib/auth/vendor-api-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveAuthenticatedBusinessAccess } from "@/lib/test-workspaces/index.server";
import { normalizeE164 } from "@/lib/phone-e164";
import { buildConversationKey } from "@/lib/sms-conversation-identity";
import { readScopedSmsConsentState, readSmsSuppressionState, recordScopedSmsConsent } from "@/lib/sms-consent";
import { coordinationWorkOrderAccess, type CoordinationActor } from "@/lib/vendor-coordination.server";
import { sweepVendorSourcing, VENDOR_QUOTE_SMS_PURPOSE } from "@/lib/vendor-sourcing.server";

export const runtime = "nodejs";

type PermissionScope = {
  managerUserId: string;
  directoryId: string;
  vendorUserId: string;
  phone: string;
  conversationKey: string;
  messagingServiceSid: string;
};

class PermissionRouteError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function vendorActor(): Promise<
  | { ok: true; actor: CoordinationActor; db: ReturnType<typeof createSupabaseServiceRoleClient> }
  | { ok: false; response: NextResponse }
> {
  const access = await requireVendorApiAccess();
  if (!access.ok) {
    return {
      ok: false,
      response: NextResponse.json({ error: access.status === 401 ? "Unauthorized." : "Forbidden." }, { status: access.status }),
    };
  }
  const db = createSupabaseServiceRoleClient();
  if ((await resolveAuthenticatedBusinessAccess(access.actor.userId, db)).kind === "denied") {
    return { ok: false, response: NextResponse.json({ error: "Forbidden." }, { status: 403 }) };
  }
  return {
    ok: true,
    actor: { role: "vendor", userId: access.actor.userId, email: access.actor.email },
    db,
  };
}

async function permissionScope(
  db: ReturnType<typeof createSupabaseServiceRoleClient>,
  actor: CoordinationActor,
  workOrderId: string,
): Promise<PermissionScope> {
  const work = await coordinationWorkOrderAccess(db, actor, workOrderId);
  const managerUserId = String(work.manager_user_id ?? "").trim();
  if (!managerUserId) throw new PermissionRouteError("Service unavailable.", 409);

  const [{ data: directories, error: directoryError }, { data: profile, error: profileError }] = await Promise.all([
    db.from("manager_vendor_records")
      .select("id,vendor_user_id,row_data")
      .eq("manager_user_id", managerUserId)
      .eq("vendor_user_id", actor.userId),
    db.from("profiles")
      .select("id,phone,phone_verified_at")
      .eq("id", actor.userId)
      .maybeSingle(),
  ]);
  if (directoryError || profileError) throw new PermissionRouteError("Quote text permission is unavailable.", 503);

  const linkedDirectories = (directories ?? []).filter((row) =>
    row.vendor_user_id === actor.userId && row.row_data?.active !== false,
  );
  if (!linkedDirectories.length) throw new PermissionRouteError("No linked vendor directory entry.", 403);

  const directoryIds = linkedDirectories.map((row) => String(row.id));
  const { data: offers, error: offerError } = await db.from("work_order_vendor_offers")
    .select("vendor_directory_id,vendor_user_id,expires_at,status")
    .eq("manager_user_id", managerUserId)
    .eq("work_order_id", workOrderId)
    .eq("vendor_user_id", actor.userId)
    .eq("status", "sent")
    .in("vendor_directory_id", directoryIds);
  if (offerError) throw new PermissionRouteError("Quote offer is unavailable.", 503);

  const now = Date.now();
  const activeDirectoryIds = new Set((offers ?? []).flatMap((offer) => {
    const expiry = typeof offer.expires_at === "string" ? Date.parse(offer.expires_at) : Number.NaN;
    return Number.isFinite(expiry) && expiry > now && offer.status === "sent" && offer.vendor_user_id === actor.userId
      ? [String(offer.vendor_directory_id)]
      : [];
  }));
  const directory = linkedDirectories.find((row) => activeDirectoryIds.has(String(row.id)));
  if (!directory) throw new PermissionRouteError("No active quote request is available.", 409);

  // Recheck the same vendor/work-order pairing through the coordination guard.
  await coordinationWorkOrderAccess(db, actor, workOrderId, String(directory.id));

  const phone = normalizeE164(profile?.phone);
  if (!profile?.phone_verified_at || !phone) {
    throw new PermissionRouteError("Verify your phone number before allowing quote request texts.", 409);
  }
  if (normalizeE164(directory.row_data?.phone) !== phone) {
    throw new PermissionRouteError("Your verified phone must match the number on this vendor offer.", 409);
  }

  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID?.trim();
  if (!messagingServiceSid) throw new PermissionRouteError("Vendor text messaging is unavailable.", 503);

  return {
    managerUserId,
    directoryId: String(directory.id),
    vendorUserId: actor.userId,
    phone,
    conversationKey: buildConversationKey({
      ownerManagerUserId: managerUserId,
      role: "vendor",
      counterpartyUserId: actor.userId,
      counterpartyPhone: phone,
    }),
    messagingServiceSid,
  };
}

async function currentPermission(
  db: ReturnType<typeof createSupabaseServiceRoleClient>,
  scope: PermissionScope,
) {
  const consentScope = {
    managerUserId: scope.managerUserId,
    purpose: VENDOR_QUOTE_SMS_PURPOSE,
    sendClass: "automated" as const,
    conversationKey: scope.conversationKey,
    messagingServiceSid: scope.messagingServiceSid,
  };
  const [consent, suppression] = await Promise.all([
    readScopedSmsConsentState(db, scope.phone, consentScope),
    readSmsSuppressionState(db, scope.phone, { userId: scope.vendorUserId }),
  ]);
  if (!consent.ok || !suppression.ok) throw new PermissionRouteError("Quote text permission could not be checked.", 503);
  return { consentScope, consent, suppressed: suppression.optedOut };
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : "Quote text permission is unavailable.";
  const status = error instanceof PermissionRouteError
    ? error.status
    : message === "Unauthorized." ? 401
      : message === "Forbidden." ? 403
        : 409;
  return NextResponse.json({ error: message }, { status });
}

function validWorkOrderId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return id.length > 0 && id.length <= 160 ? id : null;
}

export async function GET(req: Request) {
  try {
    const gate = await vendorActor();
    if (!gate.ok) return gate.response;
    const workOrderId = validWorkOrderId(new URL(req.url).searchParams.get("workOrderId"));
    if (!workOrderId) return NextResponse.json({ error: "Service required." }, { status: 400 });
    const scope = await permissionScope(gate.db, gate.actor, workOrderId);
    const current = await currentPermission(gate.db, scope);
    return NextResponse.json({
      permissionGranted: current.consent.state === "granted" && !current.suppressed,
      suppressed: current.suppressed,
    });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(req: Request) {
  try {
    const gate = await vendorActor();
    if (!gate.ok) return gate.response;
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    }
    if (!body || typeof body !== "object" || Array.isArray(body) || (body as Record<string, unknown>).enabled !== true) {
      return NextResponse.json({ error: "Explicit quote text permission is required." }, { status: 400 });
    }
    const workOrderId = validWorkOrderId((body as Record<string, unknown>).workOrderId);
    if (!workOrderId) return NextResponse.json({ error: "Service required." }, { status: 400 });

    const scope = await permissionScope(gate.db, gate.actor, workOrderId);
    const current = await currentPermission(gate.db, scope);
    if (current.suppressed) throw new PermissionRouteError("Text messaging is paused for this phone. Reply START to the work number first.", 409);

    if (current.consent.state !== "granted") {
      const recorded = await recordScopedSmsConsent(gate.db, scope.phone, {
        ...current.consentScope,
        eventType: "granted",
        source: "vendor_portal_explicit_quote_opt_in",
        wordingVersion: "vendor-quote-texts-v1",
        evidence: { workOrderId, vendorDirectoryId: scope.directoryId, control: "Allow quote request texts" },
      });
      if (!recorded.ok) throw new PermissionRouteError("Quote text permission could not be saved.", 503);
    }

    // The sms_consent_events trigger wakes blocked sourcing jobs. This is a
    // latency optimization; the durable sourcing sweep remains the recovery path.
    after(() => sweepVendorSourcing(gate.db, workOrderId).catch(() => undefined));
    return NextResponse.json({ permissionGranted: true });
  } catch (error) {
    return failure(error);
  }
}
