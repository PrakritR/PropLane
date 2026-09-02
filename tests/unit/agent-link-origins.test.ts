import { afterEach, describe, expect, it } from "vitest";
import { publicAppOrigin } from "@/lib/claw-leasing-bot.server";
import { residentPortalUrl, residentSmsLinkOrigin } from "@/lib/claw-resident-links";
import { publicOrigin } from "@/lib/tools/domains/leasing-sms";

const LEGACY_ORIGIN = "https://www.axis-seattle-housing.com";
const CANONICAL_ORIGIN = "https://prop-lane.space";
const ORIGIN_KEYS = [
  "CLAW_MESSENGER_LINK_ORIGIN",
  "PROPLANE_SMS_LINK_ORIGIN",
  "NEXT_PUBLIC_APP_URL",
  "VERCEL_PROJECT_PRODUCTION_URL",
] as const;

afterEach(() => {
  for (const key of ORIGIN_KEYS) delete process.env[key];
});

describe("agent-generated link origins", () => {
  it("never emits the legacy Axis host, even when legacy overrides remain configured", () => {
    process.env.CLAW_MESSENGER_LINK_ORIGIN = LEGACY_ORIGIN;
    process.env.PROPLANE_SMS_LINK_ORIGIN = LEGACY_ORIGIN;
    process.env.NEXT_PUBLIC_APP_URL = LEGACY_ORIGIN;

    expect(publicOrigin()).toBe(CANONICAL_ORIGIN);
    expect(publicAppOrigin()).toBe(CANONICAL_ORIGIN);
    expect(residentSmsLinkOrigin()).toBe(CANONICAL_ORIGIN);
    expect(residentPortalUrl("payments")).toBe(`${CANONICAL_ORIGIN}/resident/payments/pending`);
  });
});
