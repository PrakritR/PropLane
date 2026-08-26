import { NextResponse } from "next/server";
import twilio from "twilio";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { twilioWebhookAuthToken } from "@/lib/twilio-client.server";

export const runtime = "nodejs";

type CloudEvent = {
  id?: unknown;
  type?: unknown;
  time?: unknown;
  data?: unknown;
};

const NUMBER_EVENT_PREFIX = "com.twilio.messaging.compliance.number-";

function dataObject(event: CloudEvent): Record<string, unknown> {
  if (event.data && typeof event.data === "object" && !Array.isArray(event.data)) {
    return event.data as Record<string, unknown>;
  }
  if (typeof event.data === "string") {
    try {
      const parsed = JSON.parse(event.data) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

function stringField(data: Record<string, unknown>, key: string): string | null {
  const value = String(data[key] ?? "").trim();
  return value || null;
}

function providerTimestamp(event: CloudEvent, data: Record<string, unknown>): string | null {
  const millis = Number(data.updateddate ?? data.timestamp);
  if (Number.isFinite(millis) && millis > 0) return new Date(millis).toISOString();
  const parsed = Date.parse(String(event.time ?? ""));
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function registrationState(type: string):
  | "pending"
  | "registered"
  | "failed"
  | "deregistering"
  | "deregistered"
  | null {
  if (type.endsWith("number-registration.pending")) return "pending";
  if (type.endsWith("number-registration.successful")) return "registered";
  if (type.endsWith("number-registration.failed")) return "failed";
  if (type.endsWith("number-deregistration.pending")) return "deregistering";
  if (type.endsWith("number-deregistration.successful")) return "deregistered";
  if (type.endsWith("number-deregistration.failed")) return "failed";
  return null;
}

export async function POST(req: Request) {
  const authToken = twilioWebhookAuthToken();
  const sinkUrl = process.env.TWILIO_EVENT_STREAMS_SINK_URL?.trim();
  if (!authToken || !sinkUrl) {
    return NextResponse.json({ error: "Event sink not configured." }, { status: 503 });
  }

  const raw = await req.text();
  const signature = req.headers.get("x-twilio-signature") ?? "";
  const requested = new URL(req.url);
  const configured = new URL(sinkUrl);
  configured.search = requested.search;
  if (!twilio.validateRequestWithBody(authToken, signature, configured.toString(), raw)) {
    return NextResponse.json({ error: "Invalid signature." }, { status: 403 });
  }

  let events: CloudEvent[];
  try {
    const parsed = JSON.parse(raw) as unknown;
    events = Array.isArray(parsed) ? (parsed as CloudEvent[]) : [];
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const expectedAccountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const expectedServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID?.trim();
  const expectedCampaignSid = process.env.TWILIO_CAMPAIGN_SID?.trim();
  if (!expectedAccountSid || !expectedServiceSid || !expectedCampaignSid) {
    return NextResponse.json({ error: "A2P allowlist is incomplete." }, { status: 503 });
  }

  const db = createSupabaseServiceRoleClient();
  for (const event of events) {
    const eventId = String(event.id ?? "").trim();
    const eventType = String(event.type ?? "").trim();
    if (!eventId || !eventType.startsWith(NUMBER_EVENT_PREFIX)) continue;
    const data = dataObject(event);
    const accountSid = stringField(data, "accountsid");
    const serviceSid = stringField(data, "messagingservicesid");
    const campaignSid = stringField(data, "campaignsid");
    const phoneNumberSid = stringField(data, "phonenumbersid");
    const phoneNumber = stringField(data, "phonenumber");
    const occurredAt = providerTimestamp(event, data);
    const nextRegistrationState = registrationState(eventType);
    if (!occurredAt || !phoneNumberSid || !nextRegistrationState) continue;

    const { data: duplicate, error: duplicateError } = await db
      .from("sms_provider_events")
      .select("event_id, applied")
      .eq("event_id", eventId)
      .maybeSingle();
    if (duplicateError) return NextResponse.json({ error: "Event ledger unavailable." }, { status: 503 });
    if (duplicate?.applied === true) continue;

    const campaignRequired = !eventType.endsWith("number-deregistration.successful");
    const allowed =
      accountSid === expectedAccountSid &&
      serviceSid === expectedServiceSid &&
      (!campaignRequired || campaignSid === expectedCampaignSid);
    if (!duplicate) {
      const { error: insertError } = await db.from("sms_provider_events").insert({
        event_id: eventId,
        event_type: eventType,
        provider_occurred_at: occurredAt,
        account_sid: accountSid,
        messaging_service_sid: serviceSid,
        campaign_sid: campaignSid,
        phone_number_sid: phoneNumberSid,
        phone_number: phoneNumber,
        payload: event,
        applied: false,
        rejection_reason: allowed ? null : "provider_identity_mismatch",
      });
      if (insertError) {
        const { data: racedDuplicate, error: raceReadError } = await db
          .from("sms_provider_events")
          .select("applied")
          .eq("event_id", eventId)
          .maybeSingle();
        if (raceReadError || !racedDuplicate) {
          return NextResponse.json({ error: "Event ledger unavailable." }, { status: 503 });
        }
        if (racedDuplicate.applied === true) continue;
      }
    }
    if (!allowed) continue;

    const { data: appliedManagerId, error: applyError } = await db.rpc(
      "apply_manager_sms_number_event",
      {
        p_phone_number_sid: phoneNumberSid,
        p_messaging_service_sid: expectedServiceSid,
        p_campaign_sid: campaignSid ?? expectedCampaignSid,
        p_registration_state: nextRegistrationState,
        p_provider_occurred_at: occurredAt,
        p_error: stringField(data, "failureReason") ?? stringField(data, "failurereason"),
      },
    );
    if (applyError) return NextResponse.json({ error: "Event apply unavailable." }, { status: 503 });
    if (appliedManagerId) {
      const { error: appliedError } = await db
        .from("sms_provider_events")
        .update({ applied: true, rejection_reason: null })
        .eq("event_id", eventId);
      if (appliedError) return NextResponse.json({ error: "Event ledger unavailable." }, { status: 503 });
    } else {
      const { data: ownedRow } = await db
        .from("manager_sms_numbers")
        .select("last_provider_event_at, attachment_state")
        .eq("phone_number_sid", phoneNumberSid)
        .eq("messaging_service_sid", expectedServiceSid)
        .maybeSingle();
      if (!ownedRow || (nextRegistrationState === "registered" && ownedRow.attachment_state !== "attached")) {
        // The registration event may beat provisioning persistence. A non-2xx
        // asks Event Streams to retry; duplicate event ids remain re-applicable.
        return NextResponse.json({ error: "Number state not ready." }, { status: 503 });
      }
      const { error: rejectionError } = await db
        .from("sms_provider_events")
        .update({ rejection_reason: "event_out_of_order" })
        .eq("event_id", eventId);
      if (rejectionError) return NextResponse.json({ error: "Event ledger unavailable." }, { status: 503 });
    }
  }

  return NextResponse.json({ ok: true });
}
