import { NextResponse } from "next/server";
import { getPortalAccessContext, hasAdminRole, hasRole } from "@/lib/auth/portal-access";
import {
  fetchManagerSmsConversations,
  resolveSmsScopeManagerIds,
} from "@/lib/manager-sms-messages.server";
import {
  deleteManagerSmsContactName,
  isSavableContactEmail,
  upsertManagerSmsContact,
} from "@/lib/sms/manager-sms-contacts.server";
import {
  buildConversationKey,
  type SmsCounterpartyRole,
} from "@/lib/sms-conversation-identity";
import { normalizeE164 } from "@/lib/phone-e164";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function requireManager() {
  const ctx = await getPortalAccessContext();
  if (!ctx.user) return { error: NextResponse.json({ error: "Unauthorized." }, { status: 401 }) };
  if (!hasRole(ctx, "manager") && !hasAdminRole(ctx)) {
    return { error: NextResponse.json({ error: "Manager access required." }, { status: 403 }) };
  }
  return { user: ctx.user, db: createSupabaseServiceRoleClient() };
}

async function resolveVisibleConversation(
  db: ReturnType<typeof createSupabaseServiceRoleClient>,
  viewerUserId: string,
  conversationKey: string,
) {
  const payload = await fetchManagerSmsConversations(db, viewerUserId);
  return payload.residents.find(
    (row) => row.conversationKey === conversationKey || (row.memberKeys ?? []).includes(conversationKey),
  ) ?? null;
}

function sameNormalizedPhone(a: string | null | undefined, b: string): boolean {
  const left = normalizeE164(String(a ?? ""));
  return Boolean(left && left === b);
}

export async function GET() {
  const auth = await requireManager();
  if ("error" in auth) return auth.error;
  const payload = await fetchManagerSmsConversations(auth.db, auth.user.id);
  return NextResponse.json(
    {
      contacts: payload.residents
        .filter((row) => row.savedContactName)
        .map((row) => ({
          conversationKey: row.conversationKey,
          displayName: row.savedContactName,
        })),
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}

/**
 * Save a phone-only contact before the first message exists.
 *
 * This is deliberately only an address-book write. It does not create SMS
 * consent, mark the number verified, or make the number sendable; the manual
 * send route still re-resolves the conversation and applies the normal consent
 * and suppression policy before enqueueing anything.
 *
 * When the number already appears in Communication (any role), attach the name
 * to that existing thread instead of creating a parallel `unknown` contact.
 */
export async function POST(req: Request) {
  const auth = await requireManager();
  if ("error" in auth) return auth.error;
  const body = (await req.json().catch(() => ({}))) as {
    phone?: string;
    displayName?: string;
    email?: string;
  };
  const displayName = String(body.displayName ?? "").trim();
  const phone = normalizeE164(String(body.phone ?? ""));
  // Optional: adding a number to an email-only conversation records that address
  // here so the thread resolves to this contact and gains its SMS channel.
  const rawEmail = String(body.email ?? "").trim().toLowerCase();
  const email = rawEmail ? rawEmail : undefined;
  if (email !== undefined && !isSavableContactEmail(email)) {
    return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
  }
  if (!displayName || displayName.length > 80) {
    return NextResponse.json({ error: "Enter a contact name up to 80 characters." }, { status: 400 });
  }
  if (!phone) {
    return NextResponse.json({ error: "Enter a valid phone number, including country code." }, { status: 400 });
  }

  // Cold contacts belong to the authenticated manager's own address book.
  // A co-manager may view an owner's shared inbox, but cannot create rows in
  // that owner's namespace by supplying an owner id from the client.
  const existing = await fetchManagerSmsConversations(auth.db, auth.user.id);
  const matches = existing.residents.filter((row) => sameNormalizedPhone(row.phone, phone));

  // Prefer renaming every already-visible thread for this phone so the sidebar
  // row the manager already sees picks up the new label. Fall back to a fresh
  // unknown-role address-book row when the number is brand new.
  const targets: Array<{
    managerUserId: string;
    counterpartyRole: SmsCounterpartyRole;
    conversationKey: string;
  }> = matches.length > 0
    ? matches
        // A stored row can carry no conversation key; renaming one would target nothing, so it
        // is dropped rather than sent through as undefined.
        .filter((row) => Boolean(row.conversationKey))
        .map((row) => ({
          managerUserId: String(row.ownerManagerUserId ?? auth.user.id).trim() || auth.user.id,
          counterpartyRole: (row.counterpartyRole ?? "unknown") as SmsCounterpartyRole,
          conversationKey: row.conversationKey as string,
        }))
    : [{
        managerUserId: auth.user.id,
        counterpartyRole: "unknown",
        conversationKey: buildConversationKey({
          ownerManagerUserId: auth.user.id,
          role: "unknown",
          counterpartyPhone: phone,
        }),
      }];

  // Co-managers may rename only when they have Communication edit on the owner.
  for (const target of targets) {
    if (target.managerUserId === auth.user.id) continue;
    const editScope = await resolveSmsScopeManagerIds(auth.db, auth.user.id, "edit");
    if (!editScope.includes(target.managerUserId)) {
      return NextResponse.json({ error: "You do not have edit access to this conversation." }, { status: 403 });
    }
  }

  const seen = new Set<string>();
  for (const target of targets) {
    const dedupe = `${target.managerUserId}|${phone}|${target.counterpartyRole}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const result = await upsertManagerSmsContact(auth.db, {
      managerUserId: target.managerUserId,
      phone,
      counterpartyRole: target.counterpartyRole,
      displayName,
      ...(email !== undefined ? { email } : {}),
    });
    if (!result.ok) {
      console.error("manager SMS contact create failed", result.error);
      return NextResponse.json({ error: "Could not save contact." }, { status: 500 });
    }
  }

  const primary = targets[0]!;
  return NextResponse.json({
    ok: true,
    contact: {
      conversationKey: primary.conversationKey,
      displayName,
      phone,
      email: email ?? null,
      counterpartyRole: primary.counterpartyRole,
    },
  });
}

export async function PUT(req: Request) {
  const auth = await requireManager();
  if ("error" in auth) return auth.error;
  const body = (await req.json().catch(() => ({}))) as {
    conversationKey?: string;
    displayName?: string;
    /** `""` clears the saved address; omitting the key leaves it untouched. */
    email?: string;
    /** A corrected number for a contact that has not texted yet. */
    phone?: string;
  };
  const conversationKey = String(body.conversationKey ?? "").trim();
  // Both fields are optional so the same editor can save a name, an address, or
  // both — but a request that changes nothing is a client bug, not a no-op save.
  const displayName = body.displayName === undefined ? undefined : String(body.displayName).trim();
  const email =
    body.email === undefined ? undefined : String(body.email).trim().toLowerCase() || null;
  if (!conversationKey) {
    return NextResponse.json({ error: "Conversation is required." }, { status: 400 });
  }
  const rawPhone = body.phone === undefined ? undefined : String(body.phone).trim();
  const nextPhone = rawPhone === undefined ? undefined : normalizeE164(rawPhone);
  if (rawPhone !== undefined && !nextPhone) {
    return NextResponse.json(
      { error: "Enter a valid phone number, including country code." },
      { status: 400 },
    );
  }
  if (displayName === undefined && email === undefined && nextPhone === undefined) {
    return NextResponse.json({ error: "Nothing to save." }, { status: 400 });
  }
  if (displayName !== undefined && (displayName.length < 1 || displayName.length > 80)) {
    return NextResponse.json({ error: "Enter a contact name up to 80 characters." }, { status: 400 });
  }
  if (email != null && !isSavableContactEmail(email)) {
    return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
  }
  const match = await resolveVisibleConversation(auth.db, auth.user.id, conversationKey);
  if (!match?.phone) return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
  const ownerManagerUserId = String(match.ownerManagerUserId ?? auth.user.id).trim() || auth.user.id;
  if (ownerManagerUserId !== auth.user.id) {
    const editScope = await resolveSmsScopeManagerIds(auth.db, auth.user.id, "edit");
    if (!editScope.includes(ownerManagerUserId)) {
      return NextResponse.json({ error: "You do not have edit access to this conversation." }, { status: 403 });
    }
  }
  const counterpartyRole = match.counterpartyRole ?? "unknown";
  // Moving the number moves only the saved contact details. Texts already sent
  // or received stay on the number they actually went to — the transport record
  // is not rewritten by an address-book edit.
  const movingNumber = Boolean(nextPhone) && !sameNormalizedPhone(match.phone, nextPhone!);

  const result = await upsertManagerSmsContact(auth.db, {
    managerUserId: ownerManagerUserId,
    phone: movingNumber ? nextPhone! : match.phone,
    counterpartyRole,
    ...(displayName !== undefined ? { displayName } : {}),
    ...(email !== undefined ? { email } : {}),
  });
  if (!result.ok) {
    console.error("manager SMS contact save failed", result.error);
    return NextResponse.json({ error: "Could not save contact details." }, { status: 500 });
  }

  if (movingNumber) {
    // Clear the label on the old number LAST, so a failed move never leaves the
    // contact nameless at both numbers.
    const cleared = await deleteManagerSmsContactName(auth.db, {
      managerUserId: ownerManagerUserId,
      phone: match.phone,
      counterpartyRole,
    });
    if (!cleared.ok) console.error("manager SMS contact move cleanup failed", cleared.error);
  }

  return NextResponse.json({
    ok: true,
    displayName: displayName ?? null,
    email: email ?? null,
    phone: movingNumber ? nextPhone : match.phone,
    conversationKey: movingNumber
      ? buildConversationKey({
          ownerManagerUserId,
          role: counterpartyRole,
          counterpartyPhone: nextPhone!,
        })
      : conversationKey,
  });
}

export async function DELETE(req: Request) {
  const auth = await requireManager();
  if ("error" in auth) return auth.error;
  const body = (await req.json().catch(() => ({}))) as { conversationKey?: string };
  const conversationKey = String(body.conversationKey ?? "").trim();
  if (!conversationKey) return NextResponse.json({ error: "Conversation is required." }, { status: 400 });
  const match = await resolveVisibleConversation(auth.db, auth.user.id, conversationKey);
  if (!match?.phone) return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
  const ownerManagerUserId = String(match.ownerManagerUserId ?? auth.user.id).trim() || auth.user.id;
  if (ownerManagerUserId !== auth.user.id) {
    const editScope = await resolveSmsScopeManagerIds(auth.db, auth.user.id, "edit");
    if (!editScope.includes(ownerManagerUserId)) {
      return NextResponse.json({ error: "You do not have edit access to this conversation." }, { status: 403 });
    }
  }
  const result = await deleteManagerSmsContactName(auth.db, {
    managerUserId: ownerManagerUserId,
    phone: match.phone,
    counterpartyRole: match.counterpartyRole ?? "unknown",
  });
  if (!result.ok) {
    console.error("manager SMS contact delete failed", result.error);
    return NextResponse.json({ error: "Could not remove contact name." }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
