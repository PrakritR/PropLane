/**
 * `send_email` on a linked-form request is a manager emailing a form link to a named address: a
 * live signup trial has none of that until it pays, judged on the request's owning manager. The
 * refusal comes before the link is rotated (so the old link keeps working) or any mail is posted.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLinkedFormFakeDb, type LinkedFormFakeDb } from "../helpers/linked-form-fake-db";
import { buildLinkedFormListing } from "../helpers/linked-form-fixtures";
import { hashLinkedFormToken } from "@/lib/application-linked-form-requests.server";

type Access =
  | { allowed: true }
  | { allowed: false; reason: "trial" | "plan_unreadable"; status: 402 | 503; message: string };

const state = vi.hoisted(() => ({
  db: null as unknown,
  access: { allowed: true } as Access,
  forOwner: vi.fn(),
  email: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "manager-1", email: "m@example.com" } } }) },
  }),
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => state.db }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: async () => ({ ok: true }), clientIpFrom: () => "127.0.0.1" }));
vi.mock("@/lib/auth/portal-access", () => ({ getPortalAccessContext: async () => ({ roles: ["manager"], effectiveRole: "manager" }) }));
vi.mock("@/lib/auth/manager-application-access", () => ({ managerCanAccessApplicationRecord: async () => true }));
vi.mock("@/lib/manager-communication-access.server", () => ({
  assertManagerCommunicationAllowed: async (...args: unknown[]) => {
    state.forOwner(...args);
    return state.access;
  },
  communicationRefusalBody: (a: { message: string; reason: string }) => ({
    ok: false,
    error: a.message,
    code: `communication_${a.reason}`,
  }),
}));
vi.mock("@/lib/resend-delivery.server", () => ({ postResendEmail: state.email }));
vi.mock("@/lib/manager-outbound-identity.server", () => ({
  managerOutboundFromHeader: async () => "PropLane <x@proplane.test>",
}));

import { POST } from "@/app/api/linked-form-requests/[id]/route";

const REQUEST_ID = "22222222-2222-4222-8222-222222222222";
const TOKEN = "K".repeat(43);

function seed(): LinkedFormFakeDb {
  const { listing, cosignerId } = buildLinkedFormListing();
  return createLinkedFormFakeDb({
    manager_property_records: [{ id: "property-1", manager_user_id: "owner-1", property_data: { listingSubmission: listing } }],
    manager_application_records: [
      {
        id: "PROPLANE-APP00001",
        manager_user_id: "owner-1",
        property_id: "property-1",
        assigned_property_id: null,
        resident_email: "ava@example.com",
        row_data: {
          id: "PROPLANE-APP00001",
          name: "Ava Lee",
          email: "ava@example.com",
          bucket: "approved",
          stage: "Approved",
          propertyId: "property-1",
          application: { propertyId: "property-1", hasCosigner: "yes" },
        },
      },
    ],
    application_form_requests: [
      {
        id: REQUEST_ID,
        manager_user_id: "owner-1",
        application_id: "PROPLANE-APP00001",
        applicant_user_id: "applicant-1",
        helper_user_id: null,
        rule_id: "r",
        form_kind: "application",
        form_id: cosignerId,
        source_question_label: "Co-signer planned",
        source_answer_label: "Yes",
        needed_before_review: true,
        token_hash: hashLinkedFormToken(TOKEN),
        status: "shared",
        filled_by_user_id: null,
        fee_cents: 4500,
        fee_paid_at: null,
        fee_paid_by_user_id: null,
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      },
    ],
    profiles: [{ id: "owner-1", role: "manager", email: "owner@example.com" }],
    profile_roles: [],
  });
}

const send = () =>
  POST(
    new Request(`http://localhost/api/linked-form-requests/${REQUEST_ID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "send_email", to: "mom@example.com" }),
    }),
    { params: Promise.resolve({ id: REQUEST_ID }) },
  );

beforeEach(() => {
  vi.stubEnv("RESEND_API_KEY", "re_test_key");
  state.db = seed();
  state.access = { allowed: true };
  state.forOwner.mockReset();
  state.email.mockReset();
  state.email.mockResolvedValue(new Response(JSON.stringify({ id: "e1" }), { status: 200 }));
});

describe("linked-form send_email - trial gate", () => {
  it.each([
    ["a live trial", { allowed: false, reason: "trial", status: 402, message: "Communication is available on a paid plan." }],
    ["an unreadable plan", { allowed: false, reason: "plan_unreadable", status: 503, message: "We could not verify your plan." }],
  ] as Array<[string, Access]>)("refuses %s before the link is rotated or mail is posted", async (_label, access) => {
    state.access = access;
    const before = { ...(state.db as LinkedFormFakeDb).tables.application_form_requests![0]! };
    const res = await send();
    expect(res.status).toBe(access.allowed === false ? access.status : 0);
    expect(await res.json()).toMatchObject({
      ok: false,
      code: access.allowed === false ? `communication_${access.reason}` : "",
    });
    // The request's owning manager is judged, not the teammate pressing send.
    expect(state.forOwner).toHaveBeenCalledWith("owner-1");
    expect(state.email).not.toHaveBeenCalled();
    expect((state.db as LinkedFormFakeDb).tables.application_form_requests![0]).toEqual(before);
  });

  it("emails the link for a paid owner", async () => {
    const res = await send();
    expect(res.status).toBe(200);
    expect(state.email).toHaveBeenCalledTimes(1);
  });
});
