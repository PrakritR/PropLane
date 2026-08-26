import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { notifyProspectPropertyMessageHandoff } from "@/lib/property-lead-prospect-handoff.server";
import { notifyManagerPropertyLeadMessage } from "@/lib/property-lead-notification.server";
import { recordResidentProspectInboxMessage } from "@/lib/tour-notification-delivery.server";
import { reconcileProspectInboxThreadsForResident } from "@/lib/tour-resident-link.server";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";
import { recordOptIn } from "@/lib/sms-consent";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

function textField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

async function resolveManagerForProperty(propertyId: string): Promise<{
  managerUserId: string | null;
  propertyTitle: string;
}> {
  const db = createSupabaseServiceRoleClient();
  const { data } = await db
    .from("manager_property_records")
    .select("id, manager_user_id, property_data, row_data, status")
    .eq("id", propertyId)
    .maybeSingle();

  if (!data) {
    return { managerUserId: null, propertyTitle: propertyId };
  }

  const pd = data.property_data as { title?: string } | null;
  const rd = data.row_data as { title?: string } | null;
  const title = textField(pd?.title) || textField(rd?.title) || propertyId;
  return { managerUserId: (data.manager_user_id as string | null) ?? null, propertyTitle: title };
}

export async function POST(req: Request) {
  try {
    // Public, unauthenticated endpoint that emails a manager — rate-limit per IP
    // to prevent spam / inbox flooding via the full-table property lookup.
    if (!rateLimit(`property-lead:${clientIpFrom(req)}`, 5, 60_000).ok) {
      return NextResponse.json({ error: "Too many messages. Please wait a minute and try again." }, { status: 429 });
    }

    const body = (await req.json()) as {
      propertyId?: string;
      name?: string;
      email?: string;
      phone?: string;
      smsConsent?: unknown;
      topic?: string;
      body?: string;
    };

    // Cap every field so a caller can't ship megabytes into the email/inbox.
    const propertyId = textField(body.propertyId).slice(0, 200);
    const name = textField(body.name).slice(0, 200);
    const email = textField(body.email).toLowerCase().slice(0, 320);
    const phone = textField(body.phone).slice(0, 40);
    const smsConsent = body.smsConsent === true;
    const topic = textField(body.topic).slice(0, 200);
    const message = textField(body.body).slice(0, 4000);

    if (!propertyId) return NextResponse.json({ error: "propertyId is required." }, { status: 400 });
    if (!name || !email.includes("@")) return NextResponse.json({ error: "Name and valid email are required." }, { status: 400 });
    if (!topic) return NextResponse.json({ error: "Topic is required." }, { status: 400 });
    if (!message) return NextResponse.json({ error: "Message is required." }, { status: 400 });

    const { managerUserId, propertyTitle } = await resolveManagerForProperty(propertyId);
    if (!managerUserId) {
      return NextResponse.json({ error: "Property not found or manager unavailable." }, { status: 404 });
    }

    const db = createSupabaseServiceRoleClient();
    const { data: managerProfile } = await db
      .from("profiles")
      .select("email")
      .eq("id", managerUserId)
      .maybeSingle();
    const managerEmail = textField(managerProfile?.email).toLowerCase();
    const { data: residentProfile } = await db.from("profiles").select("id").eq("email", email).maybeSingle();
    const hasResidentAccount = Boolean(residentProfile?.id);

    // Record the explicit opt-in when the prospect checked the box and gave a
    // phone. This lead flow only emails the manager today (no automated SMS to
    // the prospect), but capturing consent keeps a manager reply-by-text lawful
    // and provable. An unchecked box records nothing. A later STOP supersedes.
    if (smsConsent && phone) {
      await recordOptIn(db, phone, null, "tours-contact-message").catch(() => undefined);
    }

    await notifyManagerPropertyLeadMessage({
      managerUserId,
      propertyId,
      propertyTitle,
      name,
      email,
      phone: phone || undefined,
      topic,
      body: message,
    });

    const ackBody = [
      `Thanks for reaching out about ${propertyTitle}.`,
      "",
      hasResidentAccount
        ? "Your message was sent to the property manager. Replies will appear here in Communication."
        : "Your message was sent to the property manager. Create a free resident account to read replies in PropLane Communication.",
    ].join("\n");

    await recordResidentProspectInboxMessage(db, {
      participantEmail: email,
      subject: `We received your message — ${topic}`,
      body: ackBody,
      residentMessage: message,
      residentName: name,
      counterpartyEmail: managerEmail || undefined,
      managerUserId,
      propertyId,
      propertyTitle,
    });

    const authClient = await createSupabaseServerClient();
    const {
      data: { user: signedInUser },
    } = await authClient.auth.getUser();
    if (signedInUser?.id) {
      const { data: signedInProfile } = await db
        .from("profiles")
        .select("email")
        .eq("id", signedInUser.id)
        .maybeSingle();
      const authEmail = (signedInProfile?.email as string | undefined)?.trim().toLowerCase() || signedInUser.email?.trim().toLowerCase() || "";
      if (authEmail && authEmail === email) {
        await reconcileProspectInboxThreadsForResident(db, {
          userId: signedInUser.id,
          contactEmail: email,
          phone: phone || undefined,
        }).catch(() => undefined);
      }
    }

    void notifyProspectPropertyMessageHandoff({
      managerUserId,
      propertyId,
      messageFingerprint: createHash("sha256")
        .update([managerUserId, propertyId, email, topic, message].join("\u0000"))
        .digest("hex")
        .slice(0, 32),
      name,
      email,
      phone: phone || undefined,
      smsConsent,
      propertyTitle,
      topic,
    }).catch(() => undefined);

    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Could not send message.";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
