import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";
import { resolveOwnedWorkNumber } from "@/lib/voice/manager-voice-inbound.server";
import {
  resolveVoiceCallRoute,
  voiceGreetingForRoute,
} from "@/lib/voice/voice-call-routing.server";

const SERVICE_SID = "MGtestservice00000000000000000001";
const OWNER = "owner-1";
const RESIDENT = "resident-1";
const WORK = "+12065559000";
const OWNER_PHONE = "+12065550100";
const RESIDENT_PHONE = "+12065550200";
const STRANGER_PHONE = "+13105550999";

function seed(extra: Record<string, Record<string, unknown>[]> = {}) {
  return createMemoryDb({
    profiles: [
      {
        id: OWNER,
        email: "owner@axis.test",
        phone: OWNER_PHONE,
        phone_verified_at: "2026-01-01T00:00:00Z",
        sms_from_number: WORK,
        role: "manager",
        manager_id: OWNER,
      },
      {
        id: RESIDENT,
        email: "resident@axis.test",
        phone: RESIDENT_PHONE,
        phone_verified_at: "2026-01-01T00:00:00Z",
        role: "resident",
        manager_id: OWNER,
      },
      {
        id: "stranger-1",
        email: "stranger@axis.test",
        phone: STRANGER_PHONE,
        phone_verified_at: "2026-01-01T00:00:00Z",
      },
    ],
    profile_roles: [
      { user_id: OWNER, role: "manager" },
      { user_id: RESIDENT, role: "resident" },
    ],
    manager_sms_numbers: [
      {
        manager_user_id: OWNER,
        phone_number: WORK,
        messaging_service_sid: SERVICE_SID,
        provision_state: "active",
        grace_expires_at: null,
        updated_at: "2026-08-25T00:00:00.000Z",
      },
    ],
    manager_application_records: [
      {
        id: "app-1",
        manager_user_id: OWNER,
        resident_email: "resident@axis.test",
        row_data: { status: "approved" },
      },
    ],
    ...extra,
  }) as never;
}

describe("resolveOwnedWorkNumber", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the manager when the dialed number is an active work number", async () => {
    vi.stubEnv("TWILIO_MESSAGING_SERVICE_SID", SERVICE_SID);
    const owned = await resolveOwnedWorkNumber(seed(), WORK);
    expect(owned).toEqual({ managerId: OWNER, messagingServiceSid: SERVICE_SID });
  });

  it("rejects numbers that are not in manager_sms_numbers", async () => {
    vi.stubEnv("TWILIO_MESSAGING_SERVICE_SID", SERVICE_SID);
    expect(await resolveOwnedWorkNumber(seed(), "+19998887777")).toBeNull();
  });
});

describe("resolveVoiceCallRoute", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("routes the work-number owner to the manager agent", async () => {
    vi.stubEnv("TWILIO_MESSAGING_SERVICE_SID", SERVICE_SID);
    const resolved = await resolveVoiceCallRoute(seed(), {
      fromPhone: OWNER_PHONE,
      toPhone: WORK,
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.route.kind).toBe("manager");
  });

  it("routes unknown callers to the prospect leasing agent", async () => {
    vi.stubEnv("TWILIO_MESSAGING_SERVICE_SID", SERVICE_SID);
    const resolved = await resolveVoiceCallRoute(seed(), {
      fromPhone: STRANGER_PHONE,
      toPhone: WORK,
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.route.kind).toBe("prospect");
  });

  it("rejects unregistered work numbers", async () => {
    vi.stubEnv("TWILIO_MESSAGING_SERVICE_SID", SERVICE_SID);
    const resolved = await resolveVoiceCallRoute(seed(), {
      fromPhone: STRANGER_PHONE,
      toPhone: "+19998887777",
    });
    expect(resolved).toEqual({ ok: false, reason: "unconfigured" });
  });

  it("uses role-specific greetings", () => {
    expect(voiceGreetingForRoute({ kind: "prospect" })).toMatch(/tour/i);
    expect(voiceGreetingForRoute({ kind: "resident", ctx: {} as never, residentUserId: RESIDENT })).toMatch(
      /resident/i,
    );
  });
});
