import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLinkedFormFakeDb, type LinkedFormFakeDb } from "../helpers/linked-form-fake-db";
import { hashLinkedFormToken } from "@/lib/application-linked-form-requests.server";
import { STANDARD_APPLICATION_FIELD_CATALOG } from "@/lib/rental-application/application-field-catalog";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import {
  applicationTemplateQuestionConfigFromSlice,
  createPropertyApplicationTemplate,
  publishApplicationTemplateQuestionDraft,
} from "@/lib/property-application-templates";

/**
 * A co-signer template may drop Full legal name, Email and Phone like any other question. A SIGNED-IN filler (the
 * linked-form path) is then recorded from their ACCOUNT, never from the body; a signed-out co-signer has no
 * account to read, so their name and email stay required.
 */
const state = vi.hoisted(() => ({
  user: null as null | { id: string; email: string; user_metadata?: Record<string, unknown> },
  db: null as unknown,
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: state.user } }) } }),
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => state.db }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: async () => ({ ok: true }), clientIpFrom: () => "127.0.0.1" }));
vi.mock("@/lib/application-fee-checkout.server", () => ({
  resolveApplicationFeeProperty: async () => ({ ok: true, value: { applicationFeeCents: 0 } }),
  resolveApplicationFeeItemization: async () => ({ managerTier: "free", feePayer: "proplane" }),
}));
vi.mock("@/lib/cosigner-notification.server", () => ({ notifyManagerCosignerSubmitted: async () => undefined }));

import { POST as submitCosigner } from "@/app/api/public/cosigner-submissions/route";

const REQUEST_ID = "22222222-2222-4222-8222-222222222222";
const personalKey = (label: string) =>
  STANDARD_APPLICATION_FIELD_CATALOG.find((f) => f.section === "personal" && f.label === label)!.standardKey;
const IDENTITY_KEYS = [personalKey("Full legal name"), personalKey("Email"), personalKey("Phone")];

function seed(disabled: string[]): { db: LinkedFormFakeDb; cosignerId: string } {
  const cosigner = { ...createPropertyApplicationTemplate({ kind: "long-term", label: "Co-signer form" }), formVariant: "cosigner" as const };
  const published = publishApplicationTemplateQuestionDraft({
    ...cosigner,
    feeCentsOverride: 0,
    draftQuestionConfig: applicationTemplateQuestionConfigFromSlice({
      applicationConfigMode: "custom",
      disabledStandardApplicationKeys: disabled,
      customApplicationFields: [],
    }),
  });
  const listing = { ...createDefaultListingSubmission(), propertyApplicationTemplates: [published] };
  const db = createLinkedFormFakeDb({
    manager_property_records: [{ id: "property-1", manager_user_id: "manager-1", property_data: { listingSubmission: listing } }],
    manager_application_records: [
      {
        id: "PROPLANE-APP00001",
        manager_user_id: "manager-1",
        property_id: "property-1",
        assigned_property_id: null,
        resident_email: "ava@example.com",
        row_data: {
          id: "PROPLANE-APP00001",
          name: "Ava Lee",
          email: "ava@example.com",
          residentUserId: "applicant-1",
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
        manager_user_id: "manager-1",
        application_id: "PROPLANE-APP00001",
        applicant_user_id: "applicant-1",
        helper_user_id: "helper-1",
        rule_id: "r",
        form_kind: "application",
        form_id: published.id,
        source_question_label: "Co-signer planned",
        source_answer_label: "Yes",
        needed_before_review: true,
        token_hash: hashLinkedFormToken("K".repeat(43)),
        status: "shared",
        filled_by_user_id: null,
        fee_cents: 0,
        fee_paid_at: null,
        fee_paid_by_user_id: null,
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      },
    ],
    profiles: [
      { id: "helper-1", role: "resident", email: "mom@example.com", full_name: "Maria Lee" },
      { id: "manager-1", role: "manager", email: "m@example.com" },
    ],
    profile_roles: [],
    cosigner_submission_records: [],
  });
  return { db, cosignerId: published.id };
}

const post = (body: unknown) =>
  new Request("http://localhost/api/public/cosigner-submissions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

function body(extra: Record<string, unknown> = {}) {
  return { dob: "1970-01-01", ssn: "123-45-6789", consentCredit: true, signature: "Maria Lee", dateSigned: "2026-10-04", customFieldAnswers: [], ...extra };
}

describe("a co-signer template without name, email or phone questions", () => {
  beforeEach(() => {
    state.user = { id: "helper-1", email: "mom@example.com" };
  });

  it("records a signed-in filler from their account and ignores identity in the body", async () => {
    const { db } = seed(IDENTITY_KEYS);
    state.db = db;
    const res = await submitCosigner(
      post(body({ formRequestId: REQUEST_ID, fullName: "Mallory Evil", email: "mallory@evil.test", phone: "" })),
    );
    expect(res.status).toBe(200);
    const saved = db.tables.cosigner_submission_records![0]!.row_data as { fullName?: string; email?: string };
    expect(saved.email).toBe("mom@example.com");
    expect(saved.fullName).toBe("Maria Lee");
  });

  it("falls back to the auth metadata name, then the email's local part, when the profile has no name", async () => {
    const { db } = seed(IDENTITY_KEYS);
    (db.tables.profiles![0] as Record<string, unknown>).full_name = null;
    state.db = db;
    state.user = { id: "helper-1", email: "mom@example.com", user_metadata: { full_name: "Maria Q Lee" } };
    expect((await submitCosigner(post(body({ formRequestId: REQUEST_ID })))).status).toBe(200);
    expect((db.tables.cosigner_submission_records![0]!.row_data as { fullName?: string }).fullName).toBe("Maria Q Lee");
  });

  it("keeps validating what the template DOES ask (byte-identical when the questions are present)", async () => {
    const { db } = seed([]);
    state.db = db;
    const bad = await submitCosigner(post(body({ formRequestId: REQUEST_ID, fullName: "Maria", email: "mom@example.com", phone: "2065550123" })));
    expect(bad.status).toBe(400);
    const good = await submitCosigner(
      post(body({ formRequestId: REQUEST_ID, fullName: "Maria Lee", email: "Mom@Example.com", phone: "2065550123" })),
    );
    expect(good.status).toBe(200);
    const saved = db.tables.cosigner_submission_records![0]!.row_data as { fullName?: string; email?: string };
    expect(saved).toMatchObject({ fullName: "Maria Lee", email: "mom@example.com" });
  });

  it("a signed-out co-signer has no account to read, so name and email stay required", async () => {
    const { db, cosignerId } = seed(IDENTITY_KEYS);
    state.db = db;
    state.user = null;
    const send = (extra: Record<string, unknown>) =>
      submitCosigner(post(body({ signerAppId: "PROPLANE-APP00001", applicationTemplateId: cosignerId, ...extra })));
    expect((await send({})).status).toBe(400);
    expect((await send({ fullName: "Maria Lee", email: "mom@example.com" })).status).toBe(200);
  });
});
