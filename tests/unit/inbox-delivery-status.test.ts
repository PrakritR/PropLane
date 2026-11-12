import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deliveryBlocksResend,
  latestOutboundDeliveryFailed,
  mapResendEvent,
  mapTwilioStatus,
  mergeDelivery,
  isPlaceholderMailbox,
  twilioErrorMessage,
  type InboxMessageDelivery,
} from "@/lib/inbox-delivery-status";

type Row = Record<string, unknown>;

/** Just enough PostgREST to drive the delivery writers: select/eq/maybeSingle, update/eq/select, upsert. */
function fakeDb(tables: Record<string, Row[]>) {
  const from = (table: string) => {
    const rows = tables[table] ?? (tables[table] = []);
    const filters: [string, unknown][] = [];
    let patch: Row | null = null;
    const match = () => rows.filter((row) => filters.every(([k, v]) => row[k] === v));
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: (k: string, v: unknown) => (filters.push([k, v]), builder),
      is: (k: string, v: unknown) => (filters.push([k, v]), builder),
      update: (p: Row) => ((patch = p), builder),
      upsert: (p: Row) => {
        const key = Object.keys(p)[0]!;
        const at = rows.findIndex((row) => row[key] === p[key]);
        if (at >= 0) rows[at] = { ...rows[at], ...p };
        else rows.push({ ...p });
        return Promise.resolve({ error: null });
      },
      maybeSingle: () => Promise.resolve({ data: match()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown) => {
        const hit = match();
        if (patch) for (const row of hit) Object.assign(row, patch);
        return Promise.resolve({ data: hit.map((row) => ({ id: row.id })), error: null }).then(resolve);
      },
    };
    return builder;
  };
  return { from, tables } as unknown as { from: typeof from; tables: typeof tables } & import("@supabase/supabase-js").SupabaseClient;
}

const THREAD = "thread-1";
function seed() {
  return fakeDb({
    portal_inbox_thread_records: [
      {
        id: THREAD,
        updated_at: "2026-11-10T10:00:00.000Z",
        row_data: {
          folder: "sent",
          rootMessageId: "root-msg",
          messages: [
            { id: "m1", outbound: true, body: "hi", from: "Me", at: "Nov 10, 9:00 AM" },
            { id: "m2", outbound: true, body: "again", from: "Me", at: "Nov 10, 9:05 AM" },
          ],
        },
      },
    ],
    inbox_message_provider_refs: [],
  });
}

describe("status mapping", () => {
  it("maps Twilio statuses onto the four inbox states", () => {
    expect(mapTwilioStatus("queued")).toEqual({ status: "sending" });
    expect(mapTwilioStatus("accepted")).toEqual({ status: "sending" });
    expect(mapTwilioStatus("sending")).toEqual({ status: "sending" });
    expect(mapTwilioStatus("sent")).toEqual({ status: "sent" });
    expect(mapTwilioStatus("delivered")).toEqual({ status: "delivered" });
    expect(mapTwilioStatus("undelivered", "30007")).toEqual({ status: "failed", error: "Carrier filtered it as spam" });
    expect(mapTwilioStatus("failed", "21610")?.error).toMatch(/opted out/i);
    expect(mapTwilioStatus("failed")?.error).toBe("Carrier couldn't deliver it");
    expect(mapTwilioStatus("")).toBeNull();
  });

  it("turns known Twilio codes into plain sentences and falls back for the rest", () => {
    for (const code of ["30003", "30004", "30005", "30006", "30007", "30008", "21610"]) {
      expect(twilioErrorMessage(code)).not.toBe("Carrier couldn't deliver it");
    }
    expect(twilioErrorMessage("99999")).toBe("Carrier couldn't deliver it");
    expect(twilioErrorMessage(null)).toBe("Carrier couldn't deliver it");
  });

  it("maps Resend events; a delayed email stays Sent", () => {
    expect(mapResendEvent("email.delivered")).toEqual({ status: "delivered" });
    expect(mapResendEvent("email.bounced")).toEqual({ status: "failed", error: "Email bounced" });
    expect(mapResendEvent("email.complained")).toEqual({ status: "failed", error: "Marked as spam" });
    expect(mapResendEvent("email.delivery_delayed")).toBeNull();
    expect(mapResendEvent("email.sent")).toBeNull();
  });

  it("only advances: terminal outcomes stick and a replay changes nothing", () => {
    const sent: InboxMessageDelivery = { channel: "sms", providerId: "SM1", status: "sent", at: "t1" };
    const delivered = mergeDelivery([sent], { channel: "sms", providerId: "SM1", status: "delivered", at: "t2" });
    expect(delivered[0]!.status).toBe("delivered");
    expect(mergeDelivery(delivered, { channel: "sms", providerId: "SM1", status: "sent", at: "t3" })).toBe(delivered);
    expect(mergeDelivery(delivered, { channel: "sms", providerId: "SM1", status: "failed", error: "x", at: "t3" })).toBe(delivered);
    expect(mergeDelivery(delivered, { channel: "sms", providerId: "SM1", status: "delivered", at: "t4" })).toBe(delivered);
  });

  it("lets a retry replace a failure the provider never took, and never one it did", () => {
    const unsent: InboxMessageDelivery = { channel: "email", status: "failed", error: "Email couldn't be sent", at: "t1" };
    const retried = mergeDelivery([unsent], { channel: "email", providerId: "re_2", status: "sent", at: "t2" });
    expect(retried[0]).toEqual({ channel: "email", providerId: "re_2", status: "sent", at: "t2" });
    expect(retried).toHaveLength(1);

    const bounced: InboxMessageDelivery = { channel: "email", providerId: "re_1", status: "failed", error: "Email bounced", at: "t1" };
    expect(mergeDelivery([bounced], { channel: "email", providerId: "re_1", status: "sent", at: "t2" })[0]).toEqual(bounced);
  });
});

describe("a retry of the same send", () => {
  it("skips a channel the provider took and re-attempts one that failed", () => {
    expect(deliveryBlocksResend({ status: "sent" })).toBe(true);
    expect(deliveryBlocksResend({ status: "sending" })).toBe(true);
    expect(deliveryBlocksResend({ status: "delivered" })).toBe(true);
    expect(deliveryBlocksResend({ status: "failed" })).toBe(false);
  });
});

describe("placeholder email", () => {
  it("recognises import placeholders and junk, not real mailboxes or sandbox accounts as real", () => {
    expect(isPlaceholderMailbox("prakrit-5257-room9@import.proplane.local")).toBe(true);
    expect(isPlaceholderMailbox("unkown-email(input)@gmail.com")).toBe(true);
    expect(isPlaceholderMailbox("")).toBe(true);
    expect(isPlaceholderMailbox("person@gmail.com")).toBe(false);
  });

  it("is recorded failed 'Not a real mailbox' on the message and nothing is sent", async () => {
    const { recordPlaceholderEmailFailures } = await import("@/lib/inbox-delivery-status.server");
    const db = seed();
    await recordPlaceholderEmailFailures(
      db,
      new Map([["room9@import.proplane.local", { threadId: THREAD, messageId: "m1" }]]),
      ["room9@import.proplane.local", "real@gmail.com"],
    );
    const row = db.tables.portal_inbox_thread_records![0]!;
    const messages = (row.row_data as { messages: { id: string; deliveries?: InboxMessageDelivery[] }[] }).messages;
    expect(messages[0]!.deliveries).toEqual([
      expect.objectContaining({ channel: "email", status: "failed", error: "Not a real mailbox" }),
    ]);
    expect(messages[1]!.deliveries).toBeUndefined();
    expect(db.tables.inbox_message_provider_refs).toHaveLength(0);
  });
});

describe("provider status reaches the thread message", () => {
  it("records a Twilio SID at send and updates that exact message when the status arrives", async () => {
    const { recordSmsAttempt, applyProviderDeliveryStatus } = await import("@/lib/inbox-delivery-status.server");
    const db = seed();
    await recordSmsAttempt(db, { threadId: THREAD, messageId: "m2" }, { sent: true, sid: "SM123" });
    expect(db.tables.inbox_message_provider_refs).toEqual([
      expect.objectContaining({ provider_id: "SM123", thread_record_id: THREAD, message_id: "m2", channel: "sms" }),
    ]);

    const result = await applyProviderDeliveryStatus(db, { providerId: "SM123", channel: "sms", status: "delivered" });
    expect(result.updated).toBe(true);
    const messages = (db.tables.portal_inbox_thread_records![0]!.row_data as { messages: { id: string; deliveries?: InboxMessageDelivery[] }[] }).messages;
    expect(messages[1]!.deliveries).toEqual([expect.objectContaining({ providerId: "SM123", status: "delivered" })]);
    expect(messages[0]!.deliveries).toBeUndefined();

    // Replays and a late "sent" change nothing.
    await applyProviderDeliveryStatus(db, { providerId: "SM123", channel: "sms", status: "delivered" });
    await applyProviderDeliveryStatus(db, { providerId: "SM123", channel: "sms", status: "sent" });
    expect(messages[1]!.deliveries).toHaveLength(1);
    expect(messages[1]!.deliveries![0]!.status).toBe("delivered");
  });

  it("stamps the root turn (which lives in `body`) under rootDeliveries", async () => {
    const { recordEmailAttempt, applyProviderDeliveryStatus } = await import("@/lib/inbox-delivery-status.server");
    const db = seed();
    await recordEmailAttempt(db, { threadId: THREAD, messageId: "root-msg" }, "real@gmail.com", { sent: true, resendId: "re_1" });
    await applyProviderDeliveryStatus(db, { providerId: "re_1", channel: "email", status: "failed", error: "Email bounced" });
    const rowData = db.tables.portal_inbox_thread_records![0]!.row_data as { rootDeliveries?: InboxMessageDelivery[] };
    expect(rowData.rootDeliveries).toEqual([
      expect.objectContaining({ channel: "email", providerId: "re_1", status: "failed", error: "Email bounced" }),
    ]);
  });

  it("ignores a provider id nobody recorded", async () => {
    const { applyProviderDeliveryStatus } = await import("@/lib/inbox-delivery-status.server");
    const db = seed();
    expect(await applyProviderDeliveryStatus(db, { providerId: "SM-unknown", channel: "sms", status: "delivered" })).toEqual({ updated: false });
  });

  it("records a failed send with its reason when the provider refuses", async () => {
    const { recordSmsAttempt } = await import("@/lib/inbox-delivery-status.server");
    const db = seed();
    await recordSmsAttempt(db, { threadId: THREAD, messageId: "m1" }, { sent: false, error: "recipient_opted_out" });
    const messages = (db.tables.portal_inbox_thread_records![0]!.row_data as { messages: { deliveries?: InboxMessageDelivery[] }[] }).messages;
    expect(messages[0]!.deliveries).toEqual([expect.objectContaining({ channel: "sms", status: "failed", error: expect.stringMatching(/opted out/i) })]);
  });
});

describe("latestOutboundDeliveryFailed", () => {
  const failed: InboxMessageDelivery[] = [{ channel: "email", status: "failed", error: "Email bounced", at: "t" }];
  const delivered: InboxMessageDelivery[] = [{ channel: "sms", status: "delivered", at: "t" }];
  it("is true only when the latest outbound message failed on every channel", () => {
    expect(latestOutboundDeliveryFailed({ folder: "sent", messages: [{ outbound: true, deliveries: failed }] })).toBe(true);
    expect(latestOutboundDeliveryFailed({ folder: "sent", messages: [{ outbound: true, deliveries: [...failed, ...delivered] }] })).toBe(false);
    expect(latestOutboundDeliveryFailed({ folder: "sent", messages: [{ outbound: true, deliveries: failed }, { outbound: true, deliveries: delivered }] })).toBe(false);
    expect(latestOutboundDeliveryFailed({ folder: "sent", messages: [{ outbound: true, deliveries: failed }, { outbound: false }] })).toBe(true);
    expect(latestOutboundDeliveryFailed({ folder: "inbox", messages: [{ outbound: false, deliveries: failed }] })).toBe(false);
    expect(latestOutboundDeliveryFailed({ folder: "sent", rootOutbound: true, rootDeliveries: failed })).toBe(true);
    expect(latestOutboundDeliveryFailed({ folder: "sent", messages: [{ outbound: true }] })).toBe(false);
  });
});

describe("POST /api/webhooks/email/resend-events", () => {
  const SECRET = `whsec_${Buffer.from("resend-events-test-secret").toString("base64")}`;
  const applyProviderDeliveryStatus = vi.fn(async () => ({ updated: true }));

  beforeEach(() => {
    vi.resetModules();
    applyProviderDeliveryStatus.mockClear();
    vi.doMock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({}) }));
    vi.doMock("@/lib/inbox-delivery-status.server", () => ({ applyProviderDeliveryStatus }));
  });

  function signed(body: string, secret = SECRET, id = "msg_1", ts = String(Math.floor(Date.now() / 1000))) {
    const key = Buffer.from(secret.slice("whsec_".length), "base64");
    const sig = createHmac("sha256", key).update(`${id}.${ts}.${body}`, "utf8").digest("base64");
    return { "svix-id": id, "svix-timestamp": ts, "svix-signature": `v1,${sig}` };
  }
  const post = async (body: string, headers: Record<string, string>) => {
    const { POST } = await import("@/app/api/webhooks/email/resend-events/route");
    return POST(new Request("https://example.com/api/webhooks/email/resend-events", { method: "POST", body, headers }));
  };
  const event = (type: string) => JSON.stringify({ type, data: { email_id: "re_abc" } });

  it("fails closed with 503 when the secret is not configured, even for a well-formed request", async () => {
    vi.stubEnv("RESEND_WEBHOOK_SECRET", "");
    const body = event("email.delivered");
    expect((await post(body, signed(body))).status).toBe(503);
    expect(applyProviderDeliveryStatus).not.toHaveBeenCalled();
  });

  it("answers 401 for a missing or wrong signature and touches nothing", async () => {
    vi.stubEnv("RESEND_WEBHOOK_SECRET", SECRET);
    const body = event("email.bounced");
    expect((await post(body, {})).status).toBe(401);
    const other = `whsec_${Buffer.from("another-secret").toString("base64")}`;
    expect((await post(body, signed(body, other))).status).toBe(401);
    expect(applyProviderDeliveryStatus).not.toHaveBeenCalled();
  });

  it("applies a signed delivered / bounced event and ignores a delayed one", async () => {
    vi.stubEnv("RESEND_WEBHOOK_SECRET", SECRET);
    const delivered = event("email.delivered");
    expect((await post(delivered, signed(delivered))).status).toBe(200);
    expect(applyProviderDeliveryStatus).toHaveBeenLastCalledWith({}, { providerId: "re_abc", channel: "email", status: "delivered", error: undefined });
    const bounced = event("email.bounced");
    await post(bounced, signed(bounced));
    expect(applyProviderDeliveryStatus).toHaveBeenLastCalledWith({}, { providerId: "re_abc", channel: "email", status: "failed", error: "Email bounced" });
    const delayed = event("email.delivery_delayed");
    applyProviderDeliveryStatus.mockClear();
    expect((await post(delayed, signed(delayed))).status).toBe(200);
    expect(applyProviderDeliveryStatus).not.toHaveBeenCalled();
  });
});
