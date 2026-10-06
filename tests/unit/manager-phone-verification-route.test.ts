import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb, type MemoryDb } from "./support/memory-supabase";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  serviceClient: vi.fn(),
  sendSms: vi.fn(),
  createTwilioRestClient: vi.fn(),
  scheduleManagerMessagingReady: vi.fn(),
  linkVerifiedPhoneHistory: vi.fn(),
  linkVerifiedVendorPhoneHistory: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: mocks.getUser },
  }),
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => mocks.serviceClient(),
}));
vi.mock("@/lib/twilio", () => ({ sendSms: mocks.sendSms }));
vi.mock("@/lib/twilio-client.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/twilio-client.server")>()),
  createTwilioRestClient: mocks.createTwilioRestClient,
}));
vi.mock("@/lib/proplane-sms-transport.server", () => ({
  scheduleManagerMessagingReady: mocks.scheduleManagerMessagingReady,
}));

vi.mock("@/lib/communication/resident-conversations.server", () => ({
  linkVerifiedPhoneHistory: mocks.linkVerifiedPhoneHistory,
}));
vi.mock("@/lib/communication/vendor-conversations.server", () => ({
  linkVerifiedVendorPhoneHistory: mocks.linkVerifiedVendorPhoneHistory,
}));
vi.mock("@/lib/claw-onboarding-sms.server", () => ({
  maybeSendManagerPropLaneAssistantIntro: vi.fn(async () => undefined),
}));
vi.mock("@/lib/auth/portal-access", () => ({
  getPortalAccessContext: vi.fn(),
  hasRole: vi.fn(),
}));

import { createHash } from "node:crypto";
import { GET, POST, PUT } from "@/app/api/manager/phone/route";

const USER = "00000000-0000-4000-8000-0000000000aa";
const PHONE = "+15103098345";

const envKeys = [
  "TWILIO_VERIFY_SERVICE_SID",
  "SMS_RUNTIME_ENABLED",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_DEFAULT_FROM",
] as const;
const originalEnv: Record<string, string | undefined> = {};

let db: MemoryDb;

function sendRequest(phone = "5103098345") {
  return new Request("https://prop-lane.test/api/manager/phone", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ phone }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of envKeys) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
  db = createMemoryDb({
    profiles: [{ id: USER, phone: null, phone_verified_at: null }],
    phone_verifications: [],
  });
  mocks.getUser.mockResolvedValue({ data: { user: { id: USER } } });
  mocks.serviceClient.mockImplementation(() => db);
});

afterEach(() => {
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

describe("phone verification send failures", () => {
  it("clears the resend throttle when Twilio Verify is unavailable", async () => {
    process.env.TWILIO_VERIFY_SERVICE_SID = "VA-test";
    mocks.createTwilioRestClient.mockReturnValue(null);

    const first = await POST(sendRequest());
    expect(first.status).toBe(502);
    // No code went out, so nothing may be left behind to throttle a retry.
    expect(db.__tables.phone_verifications).toHaveLength(0);

    const retry = await POST(sendRequest());
    expect(retry.status).toBe(502);
    expect(await retry.json()).not.toMatchObject({
      error: "Code already sent — wait a minute before retrying.",
    });
  });

  it("clears the throttle when the Verify API call throws", async () => {
    process.env.TWILIO_VERIFY_SERVICE_SID = "VA-test";
    mocks.createTwilioRestClient.mockReturnValue({
      verify: {
        v2: {
          services: () => ({
            verifications: {
              create: vi.fn(async () => {
                throw new Error("twilio down");
              }),
            },
          }),
        },
      },
    });

    const response = await POST(sendRequest());

    expect(response.status).toBe(502);
    expect(db.__tables.phone_verifications).toHaveLength(0);
  });

  it("names a credential fault instead of telling the person to retry", async () => {
    // Twilio reports a restricted API key with no Verify scope as a 401/8021.
    // No retry can fix that, so it must not read as a transient failure.
    process.env.TWILIO_VERIFY_SERVICE_SID = "VA-test";
    const denied = Object.assign(new Error("required permission twilio/verify/service/read is missing"), {
      status: 401,
      code: 8021,
    });
    mocks.createTwilioRestClient.mockReturnValue({
      verify: {
        v2: {
          services: () => ({
            verifications: {
              create: vi.fn(async () => {
                throw denied;
              }),
            },
          }),
        },
      },
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(sendRequest());

    expect(response.status).toBe(503);
    expect((await response.json()).error).not.toContain("Try again shortly");
    // Twilio's own sentence must reach the log, or this is undiagnosable.
    expect(logged).toHaveBeenCalledWith(
      "Twilio Verify send failed",
      expect.objectContaining({
        code: "8021",
        status: 401,
        message: "required permission twilio/verify/service/read is missing",
        misconfigured: true,
      }),
    );
    expect(db.__tables.phone_verifications).toHaveLength(0);
  });

  it("clears the throttle when the managed runtime has no verification path", async () => {
    process.env.SMS_RUNTIME_ENABLED = "1";

    const response = await POST(sendRequest());

    expect(response.status).toBe(503);
    expect(db.__tables.phone_verifications).toHaveLength(0);
  });

  it("clears the throttle when the legacy SMS send fails", async () => {
    mocks.sendSms.mockResolvedValue({ sent: false, error: "unregistered" });

    const response = await POST(sendRequest());

    expect(response.status).toBe(502);
    expect(db.__tables.phone_verifications).toHaveLength(0);
  });

  it("restores the earlier code rather than deleting it after a failed resend", async () => {
    const earlier = {
      user_id: USER,
      phone: PHONE,
      code_hash: "earlier-hash",
      expires_at: new Date(Date.now() + 9 * 60_000).toISOString(),
      attempts: 1,
      send_count: 1,
      first_sent_at: new Date(Date.now() - 5 * 60_000).toISOString(),
      created_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    };
    db.__tables.phone_verifications.push({ ...earlier });
    mocks.sendSms.mockResolvedValue({ sent: false, error: "unregistered" });

    const response = await POST(sendRequest());

    expect(response.status).toBe(502);
    // The code already in the person's texts must stay verifiable, and the
    // dead attempt must not count toward the per-hour send cap.
    expect(db.__tables.phone_verifications[0]).toMatchObject({
      code_hash: "earlier-hash",
      attempts: 1,
      send_count: 1,
      created_at: earlier.created_at,
    });
  });

  it("keeps the throttle row when the code really was sent", async () => {
    mocks.sendSms.mockResolvedValue({ sent: true });

    const response = await POST(sendRequest());

    expect(response.status).toBe(200);
    expect(db.__tables.phone_verifications).toHaveLength(1);
    expect(db.__tables.phone_verifications[0]).toMatchObject({
      user_id: USER,
      phone: PHONE,
      send_count: 1,
    });
  });
});

describe("phone settings read", () => {
  it("reports an unexpired code so a reload can still enter it", async () => {
    db.__tables.phone_verifications.push({
      user_id: USER,
      phone: PHONE,
      expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    });

    const body = await (await GET()).json();

    expect(body.pendingVerification).toMatchObject({ phone: PHONE });
  });

  it("reports no pending code once the last one expired", async () => {
    db.__tables.phone_verifications.push({
      user_id: USER,
      phone: PHONE,
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    });

    const body = await (await GET()).json();

    expect(body.pendingVerification).toBeNull();
  });
});

describe("confirming a phone links resident text history only for a resident", () => {
  async function confirm(profileRoles: { user_id: string; role: string }[]) {
    db = createMemoryDb({
      profiles: [{ id: USER, phone: null, phone_verified_at: null, role: "resident" }],
      profile_roles: profileRoles,
      phone_verifications: [
        {
          user_id: USER,
          phone: PHONE,
          code_hash: createHash("sha256").update("123456").digest("hex"),
          expires_at: new Date(Date.now() + 600_000).toISOString(),
          attempts: 0,
        },
      ],
    });
    return PUT(
      new Request("https://prop-lane.test/api/manager/phone", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "123456" }),
      }),
    );
  }

  it("links when profile_roles says resident", async () => {
    const response = await confirm([{ user_id: USER, role: "resident" }]);
    expect(response.status).toBe(200);
    expect(mocks.linkVerifiedPhoneHistory).toHaveBeenCalledTimes(1);
  });

  it("does not link a manager account, even when the legacy profiles.role says resident", async () => {
    const response = await confirm([{ user_id: USER, role: "manager" }]);
    expect(response.status).toBe(200);
    expect(mocks.linkVerifiedPhoneHistory).not.toHaveBeenCalled();
  });
});

describe("confirming a phone links vendor text history only for a vendor", () => {
  async function confirm(profileRoles: { user_id: string; role: string }[]) {
    db = createMemoryDb({
      profiles: [{ id: USER, phone: null, phone_verified_at: null, role: "manager" }],
      profile_roles: profileRoles,
      phone_verifications: [
        {
          user_id: USER,
          phone: PHONE,
          code_hash: createHash("sha256").update("123456").digest("hex"),
          expires_at: new Date(Date.now() + 600_000).toISOString(),
          attempts: 0,
        },
      ],
    });
    return PUT(
      new Request("https://prop-lane.test/api/manager/phone", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "123456" }),
      }),
    );
  }

  it("links when profile_roles says vendor, even for an account created as a manager", async () => {
    const response = await confirm([{ user_id: USER, role: "vendor" }]);
    expect(response.status).toBe(200);
    expect(mocks.linkVerifiedVendorPhoneHistory).toHaveBeenCalledWith(db, USER);
  });

  it("does not link a manager-only account", async () => {
    const response = await confirm([{ user_id: USER, role: "manager" }]);
    expect(response.status).toBe(200);
    expect(mocks.linkVerifiedVendorPhoneHistory).not.toHaveBeenCalled();
  });

  it("never links when the code is wrong", async () => {
    db = createMemoryDb({
      profiles: [{ id: USER, phone: null, phone_verified_at: null }],
      profile_roles: [{ user_id: USER, role: "vendor" }],
      phone_verifications: [
        { user_id: USER, phone: PHONE, code_hash: createHash("sha256").update("123456").digest("hex"), expires_at: new Date(Date.now() + 600_000).toISOString(), attempts: 0 },
      ],
    });
    const response = await PUT(
      new Request("https://prop-lane.test/api/manager/phone", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "000000" }),
      }),
    );
    expect(response.status).toBe(400);
    expect(mocks.linkVerifiedVendorPhoneHistory).not.toHaveBeenCalled();
  });
});
