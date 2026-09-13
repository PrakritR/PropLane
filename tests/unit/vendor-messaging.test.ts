import { describe, expect, it } from "vitest";
import {
  estimateSmsSegments,
  normalizeVendorMessaging,
  renderVendorMessage,
  resolveVendorChannel,
  unknownVendorMessageTokens,
  VENDOR_MESSAGE_DEFAULTS,
  VENDOR_MESSAGE_EVENTS,
  VENDOR_MESSAGE_VARIABLES,
  vendorTemplateFor,
} from "@/lib/vendor-messaging";

/**
 * A vendor's messages are rendered from an allow-list. The one invariant that
 * must never move: an access code is not a variable, so a template cannot leak
 * one — codes come only from the vendor agent once assigned + scheduled.
 */

describe("rendering", () => {
  it("fills allowed variables and drops the unit suffix when there is no unit", () => {
    const out = renderVendorMessage("Hi {vendor} — {service} at {property}{unit_suffix}. Visit {visit_time}.", {
      vendor: "Jorge",
      service: "Kitchen faucet drip",
      property: "The Pioneer",
      unit: "Room 8B",
      visit_time: "Mon Sep 14, 10:00 AM",
    });
    expect(out).toBe("Hi Jorge — Kitchen faucet drip at The Pioneer, Room 8B. Visit Mon Sep 14, 10:00 AM.");
    expect(renderVendorMessage("{service} at {property}{unit_suffix}.", { service: "Drain", property: "Ballard" })).toBe(
      "Drain at Ballard.",
    );
  });

  it("never expands an access code — unknown tokens stay literal", () => {
    expect((VENDOR_MESSAGE_VARIABLES as readonly string[]).includes("access_code")).toBe(false);
    expect((VENDOR_MESSAGE_VARIABLES as readonly string[]).includes("lockbox")).toBe(false);
    const out = renderVendorMessage("Code {access_code}, door {lockbox}", {
      // Even if a caller passes it, it is not in the allow-list.
      ...({ access_code: "1234" } as Record<string, string>),
    });
    expect(out).toBe("Code {access_code}, door {lockbox}");
    expect(unknownVendorMessageTokens("Code {access_code} for {vendor}")).toEqual(["access_code"]);
  });

  it("falls back to the built-in copy when the vendor's template is blank", () => {
    for (const event of VENDOR_MESSAGE_EVENTS) {
      const t = vendorTemplateFor({ instructions: "", templates: { [event]: { enabled: true, body: "  " } } }, event);
      expect(t.body).toBe(VENDOR_MESSAGE_DEFAULTS[event]);
      expect(t.custom).toBe(false);
    }
    const own = vendorTemplateFor(
      { instructions: "", templates: { done: { enabled: false, body: "Gracias {vendor}" } } },
      "done",
    );
    expect(own).toEqual({ enabled: false, body: "Gracias {vendor}", custom: true });
  });

  it("estimates SMS segments, UCS-2 when accented", () => {
    expect(estimateSmsSegments("")).toBe(0);
    expect(estimateSmsSegments("a".repeat(160))).toBe(1);
    expect(estimateSmsSegments("a".repeat(161))).toBe(2);
    expect(estimateSmsSegments("¿Limpiaste hoy? " + "a".repeat(60))).toBe(2);
  });
});

describe("channel fallback", () => {
  it("uses the preferred channel when it can, otherwise the next that exists, and says why", () => {
    expect(resolveVendorChannel({ preferred: "sms", phone: "+12065550142", smsAvailable: true })).toEqual({
      channel: "sms",
      note: null,
    });
    expect(resolveVendorChannel({ preferred: "sms", phone: "", email: "j@apex.com" })).toEqual({
      channel: "email",
      note: "No phone on file — email instead.",
    });
    expect(resolveVendorChannel({ preferred: "sms", phone: "+1206", email: "j@apex.com", smsAvailable: false }).channel).toBe(
      "email",
    );
    expect(resolveVendorChannel({ preferred: "email", email: "", vendorUserId: "u1" })).toEqual({
      channel: "inapp",
      note: "No email on file — PropLane inbox instead.",
    });
    expect(resolveVendorChannel({ preferred: "sms" })).toEqual({
      channel: null,
      note: "No phone, email or PropLane account on file — task only.",
    });
  });
});

describe("normalize", () => {
  it("keeps only known events and coerces shapes", () => {
    const m = normalizeVendorMessaging({
      instructions: 5,
      templates: { assigned: { enabled: "no", body: 3 }, bogus: { body: "x" }, done: { body: "Thanks" } },
    });
    expect(m.instructions).toBe("");
    expect(Object.keys(m.templates)).toEqual(["assigned", "done"]);
    expect(m.templates.assigned).toEqual({ enabled: true, body: "" });
    expect(m.templates.done).toEqual({ enabled: true, body: "Thanks" });
  });
});
