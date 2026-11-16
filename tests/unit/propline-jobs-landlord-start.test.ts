// A landlord who answers the PropLane line's role question with "manage" is walked through the free account by text
// (name -> business -> homes -> email -> code), not just handed a link; nothing is created before the code comes back.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "../helpers/fake-table-db";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn(async () => ({ ok: true })) }));

import { startManagerSignupByText } from "@/lib/one-number/signup/flow.server";

const PHONE = "+12065550142";
let db: ReturnType<typeof createFakeDb>;
const NOW = new Date("2026-11-15T20:00:00Z");
const deps = (over: Record<string, unknown> = {}) => ({ now: () => NOW, findOwners: async () => [] as string[], webLink: async () => "https://proplane.ai/start/abc", ...over });

beforeEach(() => { db = createFakeDb({ sms_signup_sessions: [], sms_setup_links: [], sms_vendor_leads: [] }); });

describe("startManagerSignupByText", () => {
  it("opens a manager sign-up at the name question and creates no account", async () => {
    const turn = await startManagerSignupByText(db as never, { phoneE164: PHONE }, deps() as never);
    expect(turn).toMatchObject({ started: true });
    expect((turn as { reply: string }).reply).toContain("property manager account");
    expect((turn as { reply: string }).reply).toContain("What is your full name?");
    expect(db.tables.sms_signup_sessions).toHaveLength(1);
    expect(db.tables.sms_signup_sessions![0]).toMatchObject({ role: "manager", step: "name", user_id: null });
  });

  it("never starts a second sign-up for a phone that has an account or is mid sign-up", async () => {
    expect(await startManagerSignupByText(db as never, { phoneE164: PHONE }, deps({ findOwners: async () => ["u1"] }) as never)).toEqual({ started: false, reason: "has_account" });
    await startManagerSignupByText(db as never, { phoneE164: PHONE }, deps() as never);
    expect(await startManagerSignupByText(db as never, { phoneE164: PHONE }, deps() as never)).toEqual({ started: false, reason: "in_progress" });
  });

  it("fails closed when owners cannot be read, and for a non-US number", async () => {
    expect(await startManagerSignupByText(db as never, { phoneE164: PHONE }, deps({ findOwners: async () => { throw new Error("x"); } }) as never)).toEqual({ started: false, reason: "unavailable" });
    expect(await startManagerSignupByText(db as never, { phoneE164: "+442071838750" }, deps() as never)).toEqual({ started: false, reason: "unavailable" });
    expect(db.tables.sms_signup_sessions).toHaveLength(0);
  });
});
