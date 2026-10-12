/**
 * `/api/portal/send-application-completion-reminder` emails an applicant on a manager's behalf. A
 * live signup trial has no Communication until it pays, judged on the application's owning manager
 * (a teammate is not asked about their own plan). Refused before anything is rendered or sent;
 * a platform admin is staff and is not judged by a customer plan.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Access =
  | { allowed: true }
  | { allowed: false; reason: "trial" | "plan_unreadable"; status: 402 | 503; message: string };

const m = vi.hoisted(() => ({
  access: { allowed: true } as Access,
  forOwner: vi.fn(),
  forActive: vi.fn(),
  email: vi.fn(),
  admin: false,
  ownerId: "owner-1" as string | undefined,
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "mate-1", email: "mate@example.com" } } }) },
  }),
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from(table: string) {
      const chain: Record<string, unknown> = {};
      const result = () =>
        table === "profiles"
          ? { data: { role: "manager" }, error: null }
          : {
              data: [
                {
                  id: "PROPLANE-APP00001",
                  resident_email: "ava@example.com",
                  row_data: { id: "PROPLANE-APP00001", name: "Ava", email: "ava@example.com", managerUserId: m.ownerId },
                },
              ],
              error: null,
            };
      for (const k of ["select", "eq", "in"]) chain[k] = () => chain;
      chain.maybeSingle = async () => result();
      chain.then = (resolve: (v: unknown) => unknown) => resolve(result());
      return chain;
    },
  }),
}));
vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveAuthenticatedBusinessAccess: async () => ({ kind: "normal" }),
}));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: async () => m.admin }));
vi.mock("@/lib/manager-portfolio-access", () => ({ applicationVisibleToPortalUser: () => true }));
vi.mock("@/lib/rental-application/in-progress-application", () => ({
  shouldOfferApplicationCompletionReminder: () => true,
  inProgressApplicationResumeUrl: () => "https://proplane.test/resume",
}));
vi.mock("@/lib/manager-communication-access.server", () => ({
  assertManagerCommunicationAllowed: async (...args: unknown[]) => {
    m.forOwner(...args);
    return m.access;
  },
  assertManagerCommunicationAllowedForActiveWorkspace: async (...args: unknown[]) => {
    m.forActive(...args);
    return m.access;
  },
  communicationRefusalBody: (a: { message: string; reason: string }) => ({
    ok: false,
    error: a.message,
    code: `communication_${a.reason}`,
  }),
}));
vi.mock("@/lib/resend-delivery.server", () => ({ postResendEmail: m.email }));
vi.mock("@/lib/manager-outbound-identity.server", () => ({
  managerOutboundFromHeader: async () => "PropLane <x@proplane.test>",
}));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));

const { POST } = await import("@/app/api/portal/send-application-completion-reminder/route");

const send = () =>
  POST(
    new Request("https://prop-lane.space/api/portal/send-application-completion-reminder", {
      method: "POST",
      body: JSON.stringify({ applicationId: "PROPLANE-APP00001" }),
    }),
  );

beforeEach(() => {
  vi.stubEnv("RESEND_API_KEY", "re_test_key");
  m.access = { allowed: true };
  m.admin = false;
  m.ownerId = "owner-1";
  for (const fn of [m.forOwner, m.forActive, m.email]) fn.mockReset();
  m.email.mockResolvedValue(new Response(JSON.stringify({ id: "e1" }), { status: 200 }));
});

describe("POST /api/portal/send-application-completion-reminder - trial gate", () => {
  it.each([
    ["a live trial", { allowed: false, reason: "trial", status: 402, message: "Communication is available on a paid plan." }],
    ["an unreadable plan", { allowed: false, reason: "plan_unreadable", status: 503, message: "We could not verify your plan." }],
  ] as Array<[string, Access]>)("refuses %s with no email posted", async (_label, access) => {
    m.access = access;
    const res = await send();
    expect(res.status).toBe(access.allowed === false ? access.status : 0);
    expect(await res.json()).toMatchObject({ code: access.allowed === false ? `communication_${access.reason}` : "" });
    expect(m.forOwner).toHaveBeenCalledWith("owner-1");
    expect(m.email).not.toHaveBeenCalled();
  });

  it("falls back to the active workspace when the record names no owner", async () => {
    m.ownerId = undefined;
    m.access = { allowed: false, reason: "trial", status: 402, message: "Communication is available on a paid plan." };
    expect((await send()).status).toBe(402);
    expect(m.forActive).toHaveBeenCalledWith(expect.anything(), "mate-1");
    expect(m.email).not.toHaveBeenCalled();
  });

  it("sends for a paid owner", async () => {
    const res = await send();
    expect(res.status).toBe(200);
    expect(m.email).toHaveBeenCalledTimes(1);
  });

  it("does not judge a platform admin by a customer plan", async () => {
    m.admin = true;
    m.access = { allowed: false, reason: "trial", status: 402, message: "Communication is available on a paid plan." };
    const res = await send();
    expect(res.status).toBe(200);
    expect(m.forOwner).not.toHaveBeenCalled();
    expect(m.email).toHaveBeenCalledTimes(1);
  });
});
