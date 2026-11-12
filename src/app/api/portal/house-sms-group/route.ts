import { NextResponse } from "next/server";
import { grantCoversHouse, resolveCommunicationGrant } from "@/lib/one-number/communication-grant.server";
import { propertyInWorkspace, resolveListingChannelContext } from "@/lib/listing-channels/route-context.server";
import { loadHouseSmsGroupView } from "@/lib/house-sms-group/view.server";
import { syncHouseSmsGroup, type SmsGroupSyncResult } from "@/lib/house-sms-group/sync.server";
import { normalizeE164 } from "@/lib/phone-e164";
import { rateLimit } from "@/lib/rate-limit";
import { normalizeConsentPhone } from "@/lib/sms-consent";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * The SMS group text of one house, behind the "Text group" icon in the house chat's header. The workspace
 * comes from the signed-in manager and the house is re-checked against it; Communication must be granted on
 * that house (`edit` to change anything). Phones leave the server as their last four digits.
 */
async function resolve(request: Request, level: "read" | "edit", bodyWorkspaceId?: string | null, bodyPropertyId?: string | null) {
  const ctx = await resolveListingChannelContext(request, bodyWorkspaceId ?? null).catch(() => null);
  if (!ctx) return { error: NextResponse.json({ error: "Unauthorized." }, { status: 401 }) } as const;
  const access = await resolveCommunicationGrant(ctx.db, ctx.userId, ctx.workspace, level);
  if (!access.ok) return { error: NextResponse.json({ error: access.error }, { status: access.status }) } as const;
  const propertyId = (bodyPropertyId ?? new URL(request.url).searchParams.get("propertyId") ?? "").trim();
  if (!propertyId || !grantCoversHouse(access.grant, propertyId) || !(await propertyInWorkspace(ctx.db, ctx.workspace, propertyId))) {
    return { error: NextResponse.json({ error: "Property not found." }, { status: 404 }) } as const;
  }
  if (level === "edit") {
    const { isManagedReadOnly } = await import("@/lib/auth/managed-read-only.server");
    if (await isManagedReadOnly(ctx.db, ctx.userId, ctx.workspace.id)) {
      return { error: NextResponse.json({ error: "This workspace is view-only for you." }, { status: 403 }) } as const;
    }
  }
  return { ctx, propertyId } as const;
}

export async function GET(request: Request) {
  const r = await resolve(request, "read");
  if ("error" in r) return r.error;
  const view = await loadHouseSmsGroupView(r.ctx.db, { ownerUserId: r.ctx.workspace.ownerUserId, workspaceId: r.ctx.workspace.id, propertyId: r.propertyId });
  return NextResponse.json({ ...view, canManage: true });
}

type PostBody = {
  action?: unknown;
  propertyId?: unknown;
  workspaceId?: unknown;
  phone?: unknown;
  firstName?: unknown;
  /** The person being added has agreed to be texted in this group (required for any number but your own). */
  agreed?: unknown;
  phoneKey?: unknown;
};

const outcomeLine = (r: SmsGroupSyncResult): string | null => {
  switch (r.outcome) {
    case "pending":
      return "Saved. The group text starts as soon as a second phone joins.";
    case "created":
    case "updated":
    case "unchanged":
    case "closed":
      return null;
    case "no_line":
      return "This workspace has no number to text from yet.";
    case "duplicate_member_set":
      return "Another house already has a group with exactly these phones.";
    case "w10_group_active":
      return "This house already has a PropLane house thread on the shared line.";
    case "shielded":
      return "A protected account is in this group, so it cannot start outside production.";
    case "error":
      return r.detail && /twilio|group|account/i.test(r.detail) ? r.detail : "Could not update the group text. Try again.";
    default:
      return "Could not update the group text.";
  }
};

/** POST `{ action: "enable" | "add" | "remove" | "sync", propertyId, ... }`. */
export async function POST(request: Request) {
  let body: PostBody;
  try {
    body = (await request.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const r = await resolve(request, "edit", typeof body.workspaceId === "string" ? body.workspaceId : null, typeof body.propertyId === "string" ? body.propertyId : "");
  if ("error" in r) return r.error;
  const { ctx, propertyId } = r;
  const limited = await rateLimit(`house-sms-group:${ctx.userId}`, 40, 60 * 60 * 1000);
  if (!limited.ok) return NextResponse.json({ error: "Too many changes. Try again later." }, { status: 429 });

  const action = typeof body.action === "string" ? body.action : "";
  const input = { workspaceId: ctx.workspace.id, propertyId };

  let sync: SmsGroupSyncResult;
  if (action === "enable" || action === "add") {
    let phoneE164: string | null = null;
    let firstName = typeof body.firstName === "string" ? body.firstName.trim() : "";
    let userId: string | null = null;
    const typed = typeof body.phone === "string" ? body.phone.trim() : "";
    // The caller's own verified profile phone: "add me". Server-owned, never taken from the body.
    const { data: profile } = await ctx.db.from("profiles").select("phone, phone_verified_at, full_name").eq("id", ctx.userId).maybeSingle();
    const own = normalizeE164(String((profile as { phone?: unknown } | null)?.phone ?? ""));
    const ownVerified = Boolean((profile as { phone_verified_at?: unknown } | null)?.phone_verified_at);
    if (!typed) {
      if (!own || !ownVerified) return NextResponse.json({ error: "Verify your own phone in Settings first, or type the number to add." }, { status: 400 });
      phoneE164 = own;
      userId = ctx.userId;
      firstName = firstName || String((profile as { full_name?: unknown } | null)?.full_name ?? "").trim().split(/\s+/)[0] || "";
    } else {
      phoneE164 = normalizeE164(typed);
      if (!phoneE164) return NextResponse.json({ error: "Enter a valid US phone number." }, { status: 400 });
      const isOwn = own !== null && ownVerified && normalizeConsentPhone(own) === normalizeConsentPhone(phoneE164);
      if (isOwn) userId = ctx.userId;
      else if (body.agreed !== true) return NextResponse.json({ error: "Confirm that this person agreed to join the group text." }, { status: 400 });
    }
    sync = await syncHouseSmsGroup(ctx.db, { ...input, enable: true, addStaff: [{ phoneE164, firstName, userId }] });
  } else if (action === "remove") {
    const phoneKey = typeof body.phoneKey === "string" ? normalizeConsentPhone(body.phoneKey) : "";
    if (!/^\d{10}$/.test(phoneKey)) return NextResponse.json({ error: "Choose who to remove." }, { status: 400 });
    sync = await syncHouseSmsGroup(ctx.db, { ...input, removePhoneKeys: [phoneKey] });
  } else if (action === "sync") {
    sync = await syncHouseSmsGroup(ctx.db, input);
  } else {
    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }

  const view = await loadHouseSmsGroupView(ctx.db, { ownerUserId: ctx.workspace.ownerUserId, workspaceId: ctx.workspace.id, propertyId });
  const message = outcomeLine(sync);
  const failed = ["no_line", "duplicate_member_set", "w10_group_active", "shielded", "error", "not_found"].includes(sync.outcome);
  return NextResponse.json({ ok: !failed, outcome: sync.outcome, message, ...view, canManage: true }, { status: failed ? 409 : 200 });
}
