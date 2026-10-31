import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLinkedFormFakeDb, type LinkedFormFakeDb } from "../helpers/linked-form-fake-db";

vi.mock("@/lib/application-fee-checkout.server", () => ({
  resolveApplicationFeeProperty: vi.fn(async () => ({ ok: true, value: { applicationFeeCents: 0 } })),
}));
vi.mock("@/lib/auth/manager-application-access", () => ({
  managerCanAccessApplicationRecord: vi.fn(async (_db: unknown, userId: string) => userId === "manager-1"),
}));

import {
  hashLinkedFormToken,
  listLinkedFormRequestsForResident,
  loadLinkedFormRequest,
  redeemLinkedFormToken,
  resolveLinkedFormViewerRole,
  userOwnsApplication,
} from "@/lib/application-linked-form-requests.server";

/**
 * The application's BOUND subject (`row_data.residentUserId`) is the only applicant authority. A request's
 * `applicant_user_id` and a matching email never grant, widen or override it; an unbound (legacy)
 * application is manager-only; the explicit `helper_user_id` share-link capability is unchanged.
 */
const EMAIL = "same@example.com";
const REQ_A = "11111111-1111-4111-8111-111111111111";
const REQ_B = "22222222-2222-4222-8222-222222222222";
const TOKEN = "T".repeat(43);

const appRecord = (id: string, residentUserId: string | null) => ({
  id,
  manager_user_id: "manager-1",
  property_id: "property-1",
  assigned_property_id: null,
  resident_email: EMAIL,
  row_data: { id, name: "Ava Lee", email: EMAIL, ...(residentUserId ? { residentUserId } : {}) },
});

const request = (id: string, applicationId: string, applicantUserId: string | null, extra: Record<string, unknown> = {}) => ({
  id,
  manager_user_id: "manager-1",
  application_id: applicationId,
  applicant_user_id: applicantUserId,
  helper_user_id: null,
  rule_id: "r",
  form_kind: "application",
  form_id: "form-1",
  source_question_label: "Co-signer planned",
  source_answer_label: "Yes",
  needed_before_review: true,
  token_hash: hashLinkedFormToken(TOKEN),
  status: "shared",
  filled_by_user_id: null,
  fee_cents: 0,
  fee_paid_at: null,
  fee_paid_by_user_id: null,
  expires_at: new Date(Date.now() + 5 * 86_400_000).toISOString(),
  created_at: "2026-01-01T00:00:00.000Z",
  ...extra,
});

describe("linked-form applicant access is decided by the application's bound subject", () => {
  let db: LinkedFormFakeDb;

  beforeEach(() => {
    db = createLinkedFormFakeDb({
      manager_application_records: [
        appRecord("APP-A", "user-1"), // bound to user-1
        appRecord("APP-B", "someone-else"), // bound to someone else, same email
        appRecord("APP-LEGACY", null), // unbound, same email
      ],
      application_form_requests: [
        request(REQ_A, "APP-A", "user-1"),
        // A request that NAMES user-1 as applicant but sits on an application bound to someone else.
        request(REQ_B, "APP-B", "user-1", { token_hash: hashLinkedFormToken("U".repeat(43)) }),
        request("33333333-3333-4333-8333-333333333333", "APP-LEGACY", "user-1", { token_hash: hashLinkedFormToken("V".repeat(43)) }),
      ],
      profiles: [{ id: "user-1", email: EMAIL }],
    });
  });

  it("allows only the bound subject; a request naming the user on another subject's application is denied", () => {
    const bound = { id: "APP-A", resident_email: EMAIL, row_data: appRecord("APP-A", "user-1").row_data };
    const other = { id: "APP-B", resident_email: EMAIL, row_data: appRecord("APP-B", "someone-else").row_data };
    expect(userOwnsApplication(bound, { id: "user-1", email: EMAIL })).toBe(true);
    expect(userOwnsApplication(other, { id: "user-1", email: EMAIL }, { applicant_user_id: "user-1" })).toBe(false);
    expect(userOwnsApplication(other, { id: "someone-else", email: "x@example.com" })).toBe(true);
  });

  it("an unbound application gives an account with the same email no applicant access", () => {
    const legacy = { id: "APP-LEGACY", resident_email: EMAIL, row_data: appRecord("APP-LEGACY", null).row_data };
    expect(userOwnsApplication(legacy, { id: "user-1", email: EMAIL })).toBe(false);
    expect(userOwnsApplication(legacy, { id: "user-1", email: EMAIL }, { applicant_user_id: "user-1" })).toBe(false);
  });

  it("resolveLinkedFormViewerRole: bound applicant, denied mismatch, denied unbound, manager kept", async () => {
    const a = (await loadLinkedFormRequest(db, REQ_A))!;
    const b = (await loadLinkedFormRequest(db, REQ_B))!;
    const legacy = (await loadLinkedFormRequest(db, "33333333-3333-4333-8333-333333333333"))!;
    expect(await resolveLinkedFormViewerRole(db, a, { id: "user-1", email: EMAIL })).toMatchObject({ role: "applicant" });
    expect(await resolveLinkedFormViewerRole(db, b, { id: "user-1", email: EMAIL })).toBeNull();
    expect(await resolveLinkedFormViewerRole(db, legacy, { id: "user-1", email: EMAIL })).toBeNull();
    expect(await resolveLinkedFormViewerRole(db, legacy, { id: "manager-1", email: "m@example.com" })).toMatchObject({ role: "manager" });
  });

  it("the explicit helper capability still grants helper access to exactly its request", async () => {
    db.tables.application_form_requests![1]!.helper_user_id = "helper-1";
    const b = (await loadLinkedFormRequest(db, REQ_B))!;
    expect(await resolveLinkedFormViewerRole(db, b, { id: "helper-1", email: "h@example.com" })).toMatchObject({ role: "helper" });
    const a = (await loadLinkedFormRequest(db, REQ_A))!;
    expect(await resolveLinkedFormViewerRole(db, a, { id: "helper-1", email: "h@example.com" })).toBeNull();
    const redeemed = await redeemLinkedFormToken(db, "U".repeat(43), { id: "helper-1", email: "h@example.com" });
    expect(redeemed).toMatchObject({ ok: true, role: "helper" });
  });

  it("redeeming a link as the same-email account on an unbound or mismatched application is a helper, never the applicant", async () => {
    const result = await redeemLinkedFormToken(db, "V".repeat(43), { id: "user-1", email: EMAIL });
    expect(result).toMatchObject({ ok: true, role: "helper" });
    // And the helper link names no applicant (nobody is bound), so no account link is written from the email.
    expect(db.tables.resident_account_links ?? []).toHaveLength(0);
  });

  it("the resident list contains only requests on applications bound to the caller, and never lists by email", async () => {
    const { own, helping } = await listLinkedFormRequestsForResident(db, { id: "user-1", email: EMAIL });
    expect(own.map((v) => v.id)).toEqual([REQ_A]);
    expect(helping).toEqual([]);
    // A same-email application with no request naming the user stays out even though its email matches.
    const stranger = await listLinkedFormRequestsForResident(db, { id: "stranger", email: EMAIL });
    expect(stranger.own).toEqual([]);
  });
});
