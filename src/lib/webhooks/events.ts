/**
 * The outbound webhook event catalog.
 *
 * Two rules make this file the whole privacy story for outbound webhooks:
 *
 * 1. **The type list is an ALLOWLIST.** A subscription may only name a type in
 *    `WEBHOOK_EVENT_TYPES`, checked at subscribe time and again before a
 *    delivery row is written. A denylist would pass every value it has not
 *    heard of.
 * 2. **A payload carries IDS AND STATUSES ONLY.** No names, emails, phone
 *    numbers, addresses or free text — not a title, not a note, not a subject
 *    line. A webhook endpoint is an address the manager typed into a form; the
 *    body travels to it over the open internet and is stored in
 *    `webhook_deliveries` for the retry window. Anything a receiver needs
 *    beyond an id is fetched back through the authenticated REST/MCP API,
 *    where per-request authorization still applies.
 *
 * `PII_PAYLOAD_KEYS` is the machine-checkable half of rule 2 and
 * `tests/unit/webhooks-event-payloads.test.ts` enforces it against every
 * builder here, so a new event cannot quietly widen the surface.
 */

export const WEBHOOK_EVENT_TYPES = [
  "work_order.created",
  "work_order.updated",
  "work_order.completed",
  "payment.succeeded",
  "payment.failed",
  "message.received",
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

const EVENT_TYPE_SET: ReadonlySet<string> = new Set(WEBHOOK_EVENT_TYPES);

export function isWebhookEventType(value: unknown): value is WebhookEventType {
  return typeof value === "string" && EVENT_TYPE_SET.has(value);
}

/** Drop unknown/duplicate types and keep catalog order, so a stored list is canonical. */
export function normalizeWebhookEvents(raw: unknown): WebhookEventType[] {
  const requested = new Set(
    (Array.isArray(raw) ? raw : []).map((value) => String(value).trim()).filter(Boolean),
  );
  return WEBHOOK_EVENT_TYPES.filter((type) => requested.has(type));
}

/**
 * Payload property names that would carry personal data. A builder must never
 * emit one of these, and the guard test asserts it structurally rather than by
 * reading the builders.
 */
export const PII_PAYLOAD_KEYS = [
  "email",
  "name",
  "firstName",
  "lastName",
  "fullName",
  "phone",
  "phoneNumber",
  "address",
  "street",
  "title",
  "subject",
  "body",
  "text",
  "message",
  "note",
  "notes",
  "description",
  "preview",
  "contact",
  "ssn",
] as const;

/** Every value in a payload is a machine token: an id, an enum, a count or a flag. */
export type WebhookPayload = Record<string, string | number | boolean | null>;

export type WebhookEvent = { type: WebhookEventType; payload: WebhookPayload };

const id = (value: string | null | undefined): string | null => {
  const trimmed = String(value ?? "").trim();
  return trimmed ? trimmed : null;
};

/**
 * The builders. Each one is total: it maps its facts onto the exact payload
 * shape the catalog documents, so a caller cannot pass free text through by
 * spreading its own object into the emit call.
 */
export const webhookEventBuilders = {
  "work_order.created": (facts: { workOrderId: string; propertyId?: string | null; status?: string | null }): WebhookPayload => ({
    workOrderId: id(facts.workOrderId),
    propertyId: id(facts.propertyId),
    status: id(facts.status),
  }),
  "work_order.updated": (facts: {
    workOrderId: string;
    propertyId?: string | null;
    status?: string | null;
    previousStatus?: string | null;
  }): WebhookPayload => ({
    workOrderId: id(facts.workOrderId),
    propertyId: id(facts.propertyId),
    status: id(facts.status),
    previousStatus: id(facts.previousStatus),
  }),
  "work_order.completed": (facts: {
    workOrderId: string;
    propertyId?: string | null;
    completedAt?: string | null;
  }): WebhookPayload => ({
    workOrderId: id(facts.workOrderId),
    propertyId: id(facts.propertyId),
    completedAt: id(facts.completedAt),
  }),
  "payment.succeeded": (facts: {
    chargeId: string;
    propertyId?: string | null;
    amountCents?: number | null;
    kind?: string | null;
  }): WebhookPayload => ({
    chargeId: id(facts.chargeId),
    propertyId: id(facts.propertyId),
    amountCents: Number.isFinite(facts.amountCents) ? Number(facts.amountCents) : null,
    kind: id(facts.kind),
    status: "paid",
  }),
  "payment.failed": (facts: {
    chargeId: string;
    propertyId?: string | null;
    amountCents?: number | null;
    kind?: string | null;
  }): WebhookPayload => ({
    chargeId: id(facts.chargeId),
    propertyId: id(facts.propertyId),
    amountCents: Number.isFinite(facts.amountCents) ? Number(facts.amountCents) : null,
    kind: id(facts.kind),
    status: "failed",
  }),
  // Deliberately no sender, no subject, no preview: the receiver learns that a
  // conversation moved and reads it back through the authorized API.
  "message.received": (facts: { threadId: string; scope?: string | null; unread?: boolean }): WebhookPayload => ({
    threadId: id(facts.threadId),
    scope: id(facts.scope),
    unread: facts.unread === true,
  }),
} as const;

/** The shape a `send test event` delivery carries. Same allowlist, zero real data. */
export function webhookTestPayload(subscriptionId: string): WebhookPayload {
  return { workOrderId: null, propertyId: null, status: "test", test: true, subscriptionId };
}
