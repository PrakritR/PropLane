/**
 * Public "Text" CTA routing.
 *
 * Every environment sends prospects to the property's OWN manager's Twilio
 * work number (`sms_from_number`). The retired shared Claw number and the
 * manager's personal cell are never used.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSmsDeepLink, isClawMessagingPubliclyEnabled, usableCtaSmsPhone } from "@/lib/claw-leasing-links";
import { withListingContactSmsPhone } from "@/lib/listing-contact-sms";
import {
  listingCtaSendsToManagerOwnPhone,
  resolveListingCtaSmsPhone,
} from "@/lib/listing-cta-phone.server";
import type { MockProperty } from "@/data/types";

const CLAW_LINE = "+12053690702";
const ALICE_WORK = "+14258909100";
const BOB_WORK = "+12064710200";
const ALICE_CELL = "+14258909021";
const BOB_CELL = "+12064710000";

/** Two managers in one fleet, each with their own work number. */
const ALICE = {
  phone: ALICE_CELL,
  phone_verified_at: "2026-01-04T00:00:00.000Z",
  sms_from_number: ALICE_WORK,
};
const BOB = {
  phone: "(206) 471-0000", // stored unformatted; irrelevant to CTA resolution
  phone_verified_at: "2026-02-11T00:00:00.000Z",
  sms_from_number: BOB_WORK,
};

let priorVercelEnv: string | undefined;
let priorNodeEnv: string | undefined;
let priorClawFlag: string | undefined;

function setRuntime(vercelEnv: string) {
  process.env.VERCEL_ENV = vercelEnv;
}

beforeEach(() => {
  priorVercelEnv = process.env.VERCEL_ENV;
  priorNodeEnv = process.env.NODE_ENV;
  priorClawFlag = process.env.NEXT_PUBLIC_CLAW_MESSENGER_ENABLED;
  process.env.NEXT_PUBLIC_CLAW_MESSENGER_ENABLED = "1";
});

afterEach(() => {
  if (priorVercelEnv === undefined) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = priorVercelEnv;
  if (priorNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = priorNodeEnv;
  if (priorClawFlag === undefined) delete process.env.NEXT_PUBLIC_CLAW_MESSENGER_ENABLED;
  else process.env.NEXT_PUBLIC_CLAW_MESSENGER_ENABLED = priorClawFlag;
});

describe("listing CTA phone — manager work number in every environment", () => {
  it("routes production CTAs to each property's OWN manager work number", () => {
    setRuntime("production");
    expect(listingCtaSendsToManagerOwnPhone()).toBe(true);
    expect(resolveListingCtaSmsPhone(ALICE)).toBe(ALICE_WORK);
    expect(resolveListingCtaSmsPhone(BOB)).toBe(BOB_WORK);
    // A multi-manager fleet must never collapse onto one number.
    expect(resolveListingCtaSmsPhone(ALICE)).not.toBe(resolveListingCtaSmsPhone(BOB));
  });

  it("uses each manager's work number on localhost, preview and test", () => {
    for (const env of ["development", "preview"]) {
      setRuntime(env);
      expect(listingCtaSendsToManagerOwnPhone(), env).toBe(true);
      expect(resolveListingCtaSmsPhone(ALICE), env).toBe(ALICE_WORK);
      expect(resolveListingCtaSmsPhone(BOB), env).toBe(BOB_WORK);
      expect(resolveListingCtaSmsPhone(null), env).toBeNull();
    }

    delete process.env.VERCEL_ENV;
    process.env.NODE_ENV = "development";
    expect(listingCtaSendsToManagerOwnPhone()).toBe(true);
    expect(resolveListingCtaSmsPhone(ALICE)).toBe(ALICE_WORK);
  });

  it("never falls back to the manager's personal cell", () => {
    setRuntime("production");
    expect(
      resolveListingCtaSmsPhone({
        phone: ALICE_CELL,
        phone_verified_at: "2026-01-01",
        sms_from_number: null,
      }),
    ).toBeNull();
    // Shared Claw stamp on sms_from_number is not a personal-number fallback.
    expect(
      resolveListingCtaSmsPhone({
        phone: ALICE_CELL,
        phone_verified_at: "2026-01-01",
        sms_from_number: CLAW_LINE,
      }),
    ).toBeNull();
  });

  it("falls back to the web links when a manager has no usable work number", () => {
    setRuntime("production");
    expect(resolveListingCtaSmsPhone(null)).toBeNull();
    expect(resolveListingCtaSmsPhone({})).toBeNull();
    expect(resolveListingCtaSmsPhone({ sms_from_number: "" })).toBeNull();
    // Unparseable, seed placeholder, and the shared line.
    expect(resolveListingCtaSmsPhone({ sms_from_number: "call me" })).toBeNull();
    expect(resolveListingCtaSmsPhone({ sms_from_number: "+12065550199" })).toBeNull();
    expect(resolveListingCtaSmsPhone({ sms_from_number: CLAW_LINE })).toBeNull();
  });
});

describe("listing CTA rendering", () => {
  it("shows a well-formed sms: link only when a work number resolved", () => {
    setRuntime("production");
    const managerPhone = resolveListingCtaSmsPhone(ALICE);
    expect(isClawMessagingPubliclyEnabled(managerPhone)).toBe(true);
    for (const intent of ["tour", "apply"] as const) {
      const href = buildSmsDeepLink({ intent, propertyLabel: "The Pioneer", toPhone: managerPhone });
      expect(href).toMatch(/^sms:\+1\d{10}\?&body=\S+$/);
      expect(href).toContain(`sms:${ALICE_WORK}`);
      expect(href).not.toContain(ALICE_CELL);
      expect(href).not.toContain(CLAW_LINE);
    }

    const noPhone = resolveListingCtaSmsPhone({ ...ALICE, sms_from_number: null });
    expect(noPhone).toBeNull();
    expect(isClawMessagingPubliclyEnabled(noPhone)).toBe(false);
    expect(buildSmsDeepLink({ intent: "tour", propertyLabel: "The Pioneer", toPhone: noPhone })).toBe("#");
  });

  it("never leaves a stale stored number on a preview when none resolved", () => {
    setRuntime("production");
    const stored = { id: "mgr-1", contactSmsPhone: "+19995551234" } as unknown as MockProperty;
    expect(withListingContactSmsPhone(stored, resolveListingCtaSmsPhone(ALICE)).contactSmsPhone).toBe(
      ALICE_WORK,
    );
    expect(withListingContactSmsPhone(stored, null).contactSmsPhone).toBeUndefined();
  });

  it("rejects the shared Claw line and fictional 555 numbers from client CTA guard", () => {
    expect(usableCtaSmsPhone(CLAW_LINE)).toBeNull();
    expect(usableCtaSmsPhone("+12065550199")).toBeNull();
    expect(usableCtaSmsPhone(ALICE_WORK)).toBe(ALICE_WORK);
  });
});
