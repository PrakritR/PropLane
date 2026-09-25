import { randomBytes } from "node:crypto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { openCosignerIdentity } from "@/lib/security/cosigner-identity";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";

const mocks = vi.hoisted(() => ({ insert: vi.fn(), notify: vi.fn(), manager: "manager-a", property: null as unknown }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: async () => ({ ok: true }), clientIpFrom: () => "synthetic" }));
vi.mock("@/lib/cosigner-notification.server", () => ({ notifyManagerCosignerSubmitted: mocks.notify }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({ from: (table: string) => ({
  insert: mocks.insert,
  select: () => table === "manager_property_records"
    ? { eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { property_data: { listingSubmission: mocks.property ?? { v: 1 } } }, error: null }) }) }) }
    : { in: () => ({ maybeSingle: async () => ({ data: { id: "APP-a", manager_user_id: mocks.manager, property_id: "property-a", row_data: { stage: "Submitted", bucket: "pending" } } }) }) },
}) }) }));
import { POST } from "@/app/api/public/cosigner-submissions/route";

beforeEach(() => {
  vi.stubEnv("DATA_ENCRYPTION_ACTIVE_KEY_ID", "test");
  vi.stubEnv("DATA_ENCRYPTION_KEYS_JSON", JSON.stringify({ test: randomBytes(32).toString("base64") }));
  vi.stubEnv("COSIGNER_IDENTITY_REQUIRE_ENCRYPTED_READS", "true");
  mocks.manager = "manager-a";
  mocks.property = null;
  mocks.insert.mockReset().mockResolvedValue({ error: null });
  mocks.notify.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());

function request(overrides: Record<string, unknown> = {}) {
  return new Request("https://example.test/api/public/cosigner-submissions", { method: "POST", body: JSON.stringify({
    signerAppId: "AXIS-123456", fullName: "Synthetic Cosigner", email: "synthetic@example.test", phone: "2065550123", consentCredit: true,
    ssn: "123-45-6789", dob: "1980-01-01", dlNumber: "ID-123", _identityProtection: { version: 1, originOwnerId: "attacker" },
    ...overrides,
  }) });
}

it.each([
  ["missing legal name", { fullName: "" }],
  ["single-word legal name", { fullName: "Synthetic" }],
  ["missing phone", { phone: "" }],
  ["invalid phone", { phone: "123" }],
  ["invalid email", { email: "not-an-email" }],
])("rejects %s before storage for a legacy co-signer form", async (_label, overrides) => {
  const response = await POST(request(overrides));
  expect(response.status).toBe(400);
  expect(mocks.insert).not.toHaveBeenCalled();
});

it("public submission stores only protected identity and never trusts supplied crypto ownership", async () => {
  const res = await POST(request());
  expect(res.status).toBe(200);
  const row = mocks.insert.mock.calls[0][0];
  expect(row.signer_app_id).toBe("APP-a");
  expect(row.row_data.signerAppId).toBe("APP-a");
  expect(row.row_data._identityProtection.originOwnerId).toBe("manager-a");
  expect(row.row_data.dob).toMatch(/^proplane:/);
  expect(openCosignerIdentity(row.row_data, row.id)).toMatchObject({ ssn: "***-**-6789", dob: "1980-01-01", dlNumber: "ID-123" });
  expect(await res.json()).not.toHaveProperty("row_data");
  expect(JSON.stringify(mocks.notify.mock.calls)).not.toMatch(/1980|ID-123|6789/);
});

it("missing encryption configuration refuses the write without a plaintext fallback", async () => {
  vi.stubEnv("DATA_ENCRYPTION_KEYS_JSON", "");
  expect((await POST(request())).status).toBe(500);
  expect(mocks.insert).not.toHaveBeenCalled();
});

it("unassigned applications cannot invent an encryption owner from public input", async () => {
  mocks.manager = "";
  expect((await POST(request())).status).toBe(400);
  expect(mocks.insert).not.toHaveBeenCalled();
});

it("rejects a missing required published co-signer answer before storage", async () => {
  const { createPropertyApplicationTemplate, applicationTemplateQuestionConfigFromSlice, publishApplicationTemplateQuestionDraft } = await import("@/lib/property-application-templates");
  const template = publishApplicationTemplateQuestionDraft({
    ...createPropertyApplicationTemplate({ kind: "long-term" }), formVariant: "cosigner",
    draftQuestionConfig: applicationTemplateQuestionConfigFromSlice({ applicationConfigMode: "custom", disabledStandardApplicationKeys: [], customApplicationFields: [{ id: "required-q", key: "required_q", label: "Co-signer explanation", type: "text", required: true, options: [], section: "additional" }] }),
  });
  mocks.property = { v: 1, propertyApplicationTemplates: [template] };
  const response = await POST(request());
  expect(response.status).toBe(422);
  expect((await response.json()).fields).toHaveProperty("custom:required_q");
  expect(mocks.insert).not.toHaveBeenCalled();
});

it("rejects a legacy co-signer upload question before a filename can be stored", async () => {
  mocks.property = {
    ...createDefaultListingSubmission(),
    cosignerApplicationConfigMode: "custom",
    cosignerCustomApplicationFields: [{ id: "upload", key: "upload", label: "Upload proof", type: "file", required: true, options: [], section: "additional" }],
  };
  const response = await POST(request({ customFieldAnswers: [{ key: "upload", value: "proof.pdf" }] }));
  expect(response.status).toBe(409);
  expect((await response.json()).error).toMatch(/unavailable upload question/i);
  expect(mocks.insert).not.toHaveBeenCalled();
});

it("stores listed multi-select answers and rejects a forged choice", async () => {
  const { createPropertyApplicationTemplate, applicationTemplateQuestionConfigFromSlice, publishApplicationTemplateQuestionDraft } = await import("@/lib/property-application-templates");
  const template = publishApplicationTemplateQuestionDraft({
    ...createPropertyApplicationTemplate({ kind: "long-term", formVariant: "cosigner", listingSeedKey: "cosigner" }),
    draftQuestionConfig: applicationTemplateQuestionConfigFromSlice({ disabledStandardApplicationKeys: [], applicationConfigMode: "custom", customApplicationFields: [{ id: "preferences", key: "preferences", label: "Preferences", type: "multi_select", required: true, options: ["Email", "Phone"], section: "additional" }] }),
  });
  mocks.property = { ...createDefaultListingSubmission(), propertyApplicationTemplates: [template] };
  const forged = await POST(request({ customFieldAnswers: [{ key: "preferences", value: JSON.stringify(["Other"]) }] }));
  expect(forged.status).toBe(422);
  expect(mocks.insert).not.toHaveBeenCalled();
  const valid = await POST(request({ customFieldAnswers: [{ key: "preferences", value: JSON.stringify(["Email", "Phone"]) }] }));
  expect(valid.status).toBe(200);
  expect(mocks.insert.mock.calls[0]?.[0]?.row_data?.customFieldAnswers).toMatchObject([{ key: "preferences", value: '["Email","Phone"]' }]);
});

it("enforces identity on a published co-signer form before storage", async () => {
  const { createPropertyApplicationTemplate, applicationTemplateQuestionConfigFromSlice, publishApplicationTemplateQuestionDraft } = await import("@/lib/property-application-templates");
  const template = publishApplicationTemplateQuestionDraft({
    ...createPropertyApplicationTemplate({ kind: "long-term" }), formVariant: "cosigner",
    draftQuestionConfig: applicationTemplateQuestionConfigFromSlice({ applicationConfigMode: "custom", disabledStandardApplicationKeys: [], customApplicationFields: [] }),
  });
  mocks.property = { v: 1, propertyApplicationTemplates: [template] };
  const response = await POST(request({ phone: "" }));
  expect(response.status).toBe(400);
  expect(mocks.insert).not.toHaveBeenCalled();
});

it.each([
  ["date of birth", { dob: "" }],
  ["Social Security number", { ssn: "123" }],
])("rejects a forged published co-signer submission with invalid %s", async (_label, overrides) => {
  const { createPropertyApplicationTemplate, applicationTemplateQuestionConfigFromSlice, publishApplicationTemplateQuestionDraft } = await import("@/lib/property-application-templates");
  const template = publishApplicationTemplateQuestionDraft({
    ...createPropertyApplicationTemplate({ kind: "long-term" }), formVariant: "cosigner",
    draftQuestionConfig: applicationTemplateQuestionConfigFromSlice({ applicationConfigMode: "custom", disabledStandardApplicationKeys: [], customApplicationFields: [] }),
  });
  mocks.property = { v: 1, propertyApplicationTemplates: [template] };
  const response = await POST(request(overrides));
  expect(response.status).toBe(400);
  expect(mocks.insert).not.toHaveBeenCalled();
});
