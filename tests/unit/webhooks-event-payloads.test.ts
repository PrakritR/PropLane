import { describe, expect, it } from "vitest";

import {
  isWebhookEventType,
  normalizeWebhookEvents,
  PII_PAYLOAD_KEYS,
  webhookEventBuilders,
  webhookTestPayload,
  WEBHOOK_EVENT_TYPES,
} from "@/lib/webhooks/events";

/**
 * A webhook body travels to an address the manager typed into a form, over the
 * open internet, and is stored in `webhook_deliveries` for the retry window. So
 * the payload rule is absolute: IDS AND STATUSES ONLY. This test feeds every
 * builder facts that are unmistakably personal and asserts none of it comes out
 * the other side — structurally, so a NEW builder is covered without anyone
 * remembering to extend this file.
 */

/** Every builder, fed a superset of facts that includes real-looking PII. */
const POISONED_FACTS = {
  workOrderId: "wo_1",
  chargeId: "ch_1",
  threadId: "th_1",
  propertyId: "prop_1",
  status: "open",
  previousStatus: "new",
  completedAt: "2026-09-07T00:00:00.000Z",
  amountCents: 125_000,
  kind: "rent",
  scope: "axis_portal_inbox_manager_v1",
  unread: true,
  // None of the following may survive into a payload.
  residentName: "Jamie Rivers",
  email: "jamie.rivers@example.com",
  phone: "+12065550143",
  title: "Leaking sink under the kitchen counter",
  subject: "Re: rent",
  body: "Please call me on 206-555-0143",
  address: "1200 Pine St Apt 4",
} as unknown as Parameters<(typeof webhookEventBuilders)["work_order.updated"]>[0];

const LOOKS_LIKE_EMAIL = /@[a-z0-9.-]+\.[a-z]{2,}/i;
/** A phone number as a value, not a timestamp — timestamps are legitimate payload data. */
const LOOKS_LIKE_PHONE = /\+?\d[\d ().-]{6,}\d/;

describe("webhook event catalog", () => {
  it("has a builder for every allowlisted type, and no extras", () => {
    expect(Object.keys(webhookEventBuilders).sort()).toEqual([...WEBHOOK_EVENT_TYPES].sort());
  });

  it("is an allowlist — an unknown type is dropped, not passed through", () => {
    expect(isWebhookEventType("work_order.created")).toBe(true);
    expect(isWebhookEventType("lease.signed")).toBe(false);
    expect(isWebhookEventType("*")).toBe(false);
    expect(normalizeWebhookEvents(["payment.failed", "lease.signed", "payment.failed"])).toEqual([
      "payment.failed",
    ]);
    expect(normalizeWebhookEvents("payment.failed")).toEqual([]);
    expect(normalizeWebhookEvents(null)).toEqual([]);
  });

  it("keeps the catalog order so a stored list is canonical", () => {
    expect(normalizeWebhookEvents(["message.received", "work_order.created"])).toEqual([
      "work_order.created",
      "message.received",
    ]);
  });
});

describe("webhook payloads carry no personal data", () => {
  const payloads = [
    ...Object.entries(webhookEventBuilders).map(([type, build]) => [
      type,
      (build as (facts: typeof POISONED_FACTS) => Record<string, unknown>)(POISONED_FACTS),
    ] as const),
    ["test", webhookTestPayload("sub_1")] as const,
  ];

  it("emits none of the PII-shaped property names", () => {
    for (const [type, payload] of payloads) {
      for (const key of Object.keys(payload)) {
        expect(PII_PAYLOAD_KEYS as readonly string[], `${type}.${key}`).not.toContain(key);
      }
    }
  });

  it("drops every personal fact the caller passed in", () => {
    for (const [type, payload] of payloads) {
      const serialized = JSON.stringify(payload);
      for (const leaked of ["Jamie", "jamie.rivers@example.com", "2065550143", "Leaking sink", "Pine St", "Re: rent"]) {
        expect(serialized, `${type} leaked ${leaked}`).not.toContain(leaked);
      }
      expect(serialized, `${type} contains an email`).not.toMatch(LOOKS_LIKE_EMAIL);
      // Scan string VALUES only: an ISO timestamp is legitimate payload data and
      // would otherwise read as a phone number to any digit-run heuristic.
      for (const [key, value] of Object.entries(payload)) {
        if (typeof value !== "string" || key.endsWith("At")) continue;
        expect(value, `${type}.${key} looks like a phone number`).not.toMatch(LOOKS_LIKE_PHONE);
      }
    }
  });

  it("emits only machine values — ids, enums, numbers, booleans or null", () => {
    for (const [type, payload] of payloads) {
      for (const [key, value] of Object.entries(payload)) {
        expect(
          value === null || ["string", "number", "boolean"].includes(typeof value),
          `${type}.${key} is ${typeof value}`,
        ).toBe(true);
      }
    }
  });

  it("carries the ids a receiver needs to read the record back", () => {
    expect(webhookEventBuilders["work_order.created"]({ workOrderId: "wo_9" }).workOrderId).toBe("wo_9");
    expect(webhookEventBuilders["payment.succeeded"]({ chargeId: "ch_9" })).toMatchObject({
      chargeId: "ch_9",
      status: "paid",
    });
    expect(webhookEventBuilders["message.received"]({ threadId: "th_9" })).toMatchObject({
      threadId: "th_9",
      unread: false,
    });
  });

  it("normalizes a blank id to null rather than an empty string", () => {
    expect(webhookEventBuilders["work_order.created"]({ workOrderId: "  " }).workOrderId).toBeNull();
  });
});
