// Canned texts must be plain GSM-7: a curly apostrophe turns a one-segment text into a UCS-2 text at a third of the
// capacity. Found by reading every outbound template for the end-to-end pass.
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: vi.fn() }));

import { PROSPECT_TOUR_REMINDER_BODY } from "@/lib/sms/prospect-tour-reminder.server";
import { EMERGENCY_SAFETY_REPLY } from "@/lib/one-number/contracts";
import { HUMAN_ACK_REPLY } from "@/lib/one-number/inbound-seam.server";
import { NEUTRAL_REPLY, WELCOME } from "@/lib/one-number/lead-qualifying";
import { NO_MATCH_TEXT } from "@/lib/one-number/lead-match";
import { smsSegmentCount } from "@/lib/one-number/segments";

describe("canned SMS copy", () => {
  const texts: Record<string, string> = { PROSPECT_TOUR_REMINDER_BODY, EMERGENCY_SAFETY_REPLY, HUMAN_ACK_REPLY, NEUTRAL_REPLY, WELCOME, NO_MATCH_TEXT };
  it.each(Object.entries(texts))("%s is printable ASCII", (_name, text) => {
    expect(text).toMatch(/^[\x20-\x7E]+$/);
  });
  it.each(Object.entries(texts))("%s is one GSM-7 segment (a long safety notice may take two)", (name, text) => {
    expect(smsSegmentCount(text)).toBeLessThanOrEqual(name === "EMERGENCY_SAFETY_REPLY" ? 2 : 1);
  });
  it("never says work order", () => {
    for (const text of Object.values(texts)) expect(text).not.toMatch(/work ?order/i);
  });
});
