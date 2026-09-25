import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.fn();
const limit = vi.fn();
const maybeSingle = vi.fn();
const updateResult = vi.fn();
const parseSource = vi.hoisted(() => vi.fn());
const sourceIssues = [
  { pageNumber: 1, code: "source_block_unmapped", message: "Review source text at page 1, characters 0-10." },
  { pageNumber: 1, code: "choice_options_uncertain", message: "Review the source choices." },
];
const update = vi.fn(() => ({ eq: () => ({ eq: () => ({ eq: () => ({ select: updateResult }) }) }) }));

vi.mock("@/lib/reports/auth", () => ({ getReportsAuthContext: auth }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: limit }));
vi.mock("@/lib/pdf-import/pdf-source.server", () => ({ parsePdfForImport: parseSource }));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    storage: { from: () => ({ download: async () => ({ data: new Blob(["stored original PDF"]), error: null }) }) },
    from: () => ({
      update,
      select: () => ({
        eq: () => ({ eq: () => ({ maybeSingle }) }),
      }),
    }),
  }),
}));

describe("application template import route authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    limit.mockResolvedValue({ ok: true });
    parseSource.mockResolvedValue({ sourceSha256: "a".repeat(64), fileName: "application.pdf", pages: [{ pageNumber: 1, text: "", blocks: [], formFields: [], issues: [] }], issues: sourceIssues, coverage: { extractedCharacters: 0, representedCharacters: 0, complete: true } });
  });

  it("rejects an unauthenticated upload before reading a file", async () => {
    auth.mockResolvedValue(null);
    const { POST } = await import("@/app/api/portal/application-template-import/route");
    const response = await POST(new Request("http://localhost/api/portal/application-template-import", { method: "POST" }));
    expect(response.status).toBe(401);
  });

  it("does not parse or store a PDF for a property the manager does not own", async () => {
    auth.mockResolvedValue({ userId: "11111111-1111-1111-1111-111111111111" });
    maybeSingle.mockResolvedValue({ data: null, error: null });
    const body = new FormData();
    body.set("propertyId", "property-other-manager");
    body.set("templateId", "app-tpl-private");
    body.set("file", new File(["%PDF-1.4"], "application.pdf", { type: "application/pdf" }));
    const { POST } = await import("@/app/api/portal/application-template-import/route");
    const response = await POST(new Request("http://localhost/api/portal/application-template-import", { method: "POST", body }));
    expect(response.status).toBe(404);
  });

  it("refuses a stale publish before writing", async () => {
    const { createDefaultListingSubmission } = await import("@/lib/manager-listing-submission");
    const { createPropertyApplicationTemplate, applicationTemplateQuestionConfigFromSlice, publishApplicationTemplateQuestionDraft } = await import("@/lib/property-application-templates");
    const template = publishApplicationTemplateQuestionDraft({ ...createPropertyApplicationTemplate({ kind: "long-term" }), draftQuestionConfig: applicationTemplateQuestionConfigFromSlice({ disabledStandardApplicationKeys: [], customApplicationFields: [], applicationConfigMode: "custom" }) });
    auth.mockResolvedValue({ userId: "11111111-1111-1111-1111-111111111111" });
    maybeSingle.mockResolvedValue({ data: { property_data: { listingSubmission: { ...createDefaultListingSubmission(), propertyApplicationTemplates: [template] } }, updated_at: "2026-09-24T00:00:00Z" }, error: null });
    const { PATCH } = await import("@/app/api/portal/application-template-import/route");
    const response = await PATCH(new Request("http://localhost/api/portal/application-template-import", { method: "PATCH", body: JSON.stringify({ propertyId: "prop-1", templateId: template.id, expectedPublishedVersion: 0 }) }));
    expect(response.status).toBe(409);
    expect(update).not.toHaveBeenCalled();
  });

  it("issues the next version only from a manager-owned draft with CAS", async () => {
    const { createDefaultListingSubmission } = await import("@/lib/manager-listing-submission");
    const { createPropertyApplicationTemplate, applicationTemplateQuestionConfigFromSlice } = await import("@/lib/property-application-templates");
    const template = { ...createPropertyApplicationTemplate({ kind: "long-term" }), draftQuestionConfig: applicationTemplateQuestionConfigFromSlice({ disabledStandardApplicationKeys: [], customApplicationFields: [], applicationConfigMode: "custom" }) };
    auth.mockResolvedValue({ userId: "11111111-1111-1111-1111-111111111111" });
    maybeSingle.mockResolvedValue({ data: { property_data: { listingSubmission: { ...createDefaultListingSubmission(), propertyApplicationTemplates: [template] } }, updated_at: "2026-09-24T00:00:00Z" }, error: null });
    updateResult.mockResolvedValue({ data: [{ id: "prop-1" }], error: null });
    const { PATCH } = await import("@/app/api/portal/application-template-import/route");
    const response = await PATCH(new Request("http://localhost/api/portal/application-template-import", { method: "PATCH", body: JSON.stringify({ propertyId: "prop-1", templateId: template.id, expectedPublishedVersion: 0 }) }));
    expect(response.status).toBe(200);
    expect((await response.json()).version).toBe(1);
    expect(update).toHaveBeenCalledOnce();
  });

  it("rejects an imported co-signer upload draft at publish without discarding its source question", async () => {
    const { createDefaultListingSubmission } = await import("@/lib/manager-listing-submission");
    const { createPropertyApplicationTemplate, applicationTemplateQuestionConfigFromSlice } = await import("@/lib/property-application-templates");
    const template = { ...createPropertyApplicationTemplate({ kind: "long-term", formVariant: "cosigner", listingSeedKey: "cosigner" }), draftQuestionConfig: applicationTemplateQuestionConfigFromSlice({ disabledStandardApplicationKeys: [], applicationConfigMode: "custom", customApplicationFields: [{ id: "source-upload", key: "source_upload", label: "Upload proof of income", type: "file", required: true, options: [], section: "additional" }] }) };
    auth.mockResolvedValue({ userId: "11111111-1111-1111-1111-111111111111" });
    maybeSingle.mockResolvedValue({ data: { property_data: { listingSubmission: { ...createDefaultListingSubmission(), propertyApplicationTemplates: [template] } }, updated_at: "2026-09-24T00:00:00Z" }, error: null });
    const { PATCH } = await import("@/app/api/portal/application-template-import/route");
    const response = await PATCH(new Request("http://localhost/api/portal/application-template-import", { method: "PATCH", body: JSON.stringify({ propertyId: "prop-1", templateId: template.id, expectedPublishedVersion: 0 }) }));
    expect(response.status).toBe(422);
    expect((await response.json()).error).toMatch(/file and photo uploads are unavailable/);
    expect(template.draftQuestionConfig.customApplicationFields[0]?.label).toBe("Upload proof of income");
    expect(update).not.toHaveBeenCalled();
  });

  it("does not report a publish when the conditional write loses the race", async () => {
    const { createDefaultListingSubmission } = await import("@/lib/manager-listing-submission");
    const { createPropertyApplicationTemplate, applicationTemplateQuestionConfigFromSlice } = await import("@/lib/property-application-templates");
    const template = { ...createPropertyApplicationTemplate({ kind: "long-term" }), draftQuestionConfig: applicationTemplateQuestionConfigFromSlice({ disabledStandardApplicationKeys: [], customApplicationFields: [], applicationConfigMode: "custom" }) };
    auth.mockResolvedValue({ userId: "11111111-1111-1111-1111-111111111111" });
    maybeSingle.mockResolvedValue({ data: { property_data: { listingSubmission: { ...createDefaultListingSubmission(), propertyApplicationTemplates: [template] } }, updated_at: "2026-09-24T00:00:00Z" }, error: null });
    updateResult.mockResolvedValue({ data: [], error: null });
    const { PATCH } = await import("@/app/api/portal/application-template-import/route");
    const response = await PATCH(new Request("http://localhost/api/portal/application-template-import", { method: "PATCH", body: JSON.stringify({ propertyId: "prop-1", templateId: template.id, expectedPublishedVersion: 0 }) }));
    expect(response.status).toBe(409);
  });

  it("binds explicit source review to the viewed draft, stored source, and property revision", async () => {
    const { createDefaultListingSubmission } = await import("@/lib/manager-listing-submission");
    const { createPropertyApplicationTemplate, applicationTemplateQuestionConfigFromSlice, applicationDraftReviewFingerprint } = await import("@/lib/property-application-templates");
    const storedIssues = sourceIssues.map((issue) => ({ code: issue.code, message: issue.message, pageNumber: issue.pageNumber }));
    const template = { ...createPropertyApplicationTemplate({ kind: "long-term" }), draftQuestionConfig: { ...applicationTemplateQuestionConfigFromSlice({ disabledStandardApplicationKeys: [], customApplicationFields: [], applicationConfigMode: "custom" }), importProvenance: { sourcePath: "", sourceSha256: "a".repeat(64), unresolvedCount: 2, issues: storedIssues } } };
    template.draftQuestionConfig.importProvenance.sourcePath = `11111111-1111-1111-1111-111111111111/application-import/${template.id}/source.pdf`;
    auth.mockResolvedValue({ userId: "11111111-1111-1111-1111-111111111111" });
    maybeSingle.mockResolvedValue({ data: { property_data: { listingSubmission: { ...createDefaultListingSubmission(), propertyApplicationTemplates: [template] } }, updated_at: "2026-09-24T00:00:00Z" }, error: null });
    const { GET, PUT } = await import("@/app/api/portal/application-template-import/route");
    const meta = await GET(new Request(`http://localhost/api/portal/application-template-import?propertyId=prop-1&templateId=${template.id}&meta=1`));
    expect(meta.status).toBe(200);
    expect(await meta.json()).toEqual({ draftFingerprint: applicationDraftReviewFingerprint(template.draftQuestionConfig), revision: "2026-09-24T00:00:00Z" });
    const stale = await PUT(new Request("http://localhost/api/portal/application-template-import", { method: "PUT", body: JSON.stringify({ propertyId: "prop-1", templateId: template.id, sourceSha256: "b".repeat(64) }) }));
    expect(stale.status).toBe(409);
    expect(update).not.toHaveBeenCalled();
    const changedDraft = await PUT(new Request("http://localhost/api/portal/application-template-import", { method: "PUT", body: JSON.stringify({ propertyId: "prop-1", templateId: template.id, sourceSha256: "a".repeat(64), draftFingerprint: "old draft", expectedRevision: "2026-09-24T00:00:00Z" }) }));
    expect(changedDraft.status).toBe(409);
    const changedRevision = await PUT(new Request("http://localhost/api/portal/application-template-import", { method: "PUT", body: JSON.stringify({ propertyId: "prop-1", templateId: template.id, sourceSha256: "a".repeat(64), draftFingerprint: applicationDraftReviewFingerprint(template.draftQuestionConfig), expectedRevision: "2026-09-23T00:00:00Z" }) }));
    expect(changedRevision.status).toBe(409);
    expect(update).not.toHaveBeenCalled();
    const unacknowledged = await PUT(new Request("http://localhost/api/portal/application-template-import", { method: "PUT", body: JSON.stringify({ propertyId: "prop-1", templateId: template.id, sourceSha256: "a".repeat(64), draftFingerprint: applicationDraftReviewFingerprint(template.draftQuestionConfig), expectedRevision: "2026-09-24T00:00:00Z", resolvedIssueIndexes: [] }) }));
    expect(unacknowledged.status).toBe(409);
    expect(update).not.toHaveBeenCalled();
    updateResult.mockResolvedValue({ data: [{ id: "prop-1" }], error: null });
    const good = await PUT(new Request("http://localhost/api/portal/application-template-import", { method: "PUT", body: JSON.stringify({ propertyId: "prop-1", templateId: template.id, sourceSha256: "a".repeat(64), draftFingerprint: applicationDraftReviewFingerprint(template.draftQuestionConfig), expectedRevision: "2026-09-24T00:00:00Z", resolvedIssueIndexes: [0, 1] }) }));
    expect(good.status).toBe(200);
    expect((await good.json()).draft.importProvenance.reviewedByUserId).toBe("11111111-1111-1111-1111-111111111111");
    expect(update.mock.calls.at(-1)?.[0]?.property_data?.listingSubmission?.propertyApplicationTemplates?.[0]?.draftQuestionConfig?.importProvenance?.resolvedIssueIndexes).toEqual([0, 1]);
    updateResult.mockResolvedValue({ data: [], error: null });
    const lostRace = await PUT(new Request("http://localhost/api/portal/application-template-import", { method: "PUT", body: JSON.stringify({ propertyId: "prop-1", templateId: template.id, sourceSha256: "a".repeat(64), draftFingerprint: applicationDraftReviewFingerprint(template.draftQuestionConfig), expectedRevision: "2026-09-24T00:00:00Z", resolvedIssueIndexes: [0, 1] }) }));
    expect(lostRace.status).toBe(409);
  });

  it("cannot publish an unreadable PDF by acknowledging its issue", async () => {
    const { createDefaultListingSubmission } = await import("@/lib/manager-listing-submission");
    const { createPropertyApplicationTemplate, applicationTemplateQuestionConfigFromSlice, applicationDraftReviewFingerprint } = await import("@/lib/property-application-templates");
    const unreadable = { pageNumber: 1, code: "unreadable_page", message: "Page 1 could not be read." };
    parseSource.mockResolvedValue({ sourceSha256: "a".repeat(64), fileName: "application.pdf", pages: [{ pageNumber: 1, text: "", blocks: [], formFields: [], issues: [] }], issues: [unreadable], coverage: { extractedCharacters: 0, representedCharacters: 0, complete: true } });
    const template = { ...createPropertyApplicationTemplate({ kind: "long-term" }), draftQuestionConfig: { ...applicationTemplateQuestionConfigFromSlice({ disabledStandardApplicationKeys: [], customApplicationFields: [], applicationConfigMode: "custom" }), importProvenance: { sourcePath: "", sourceSha256: "a".repeat(64), unresolvedCount: 1, issues: [unreadable] } } };
    template.draftQuestionConfig.importProvenance.sourcePath = `11111111-1111-1111-1111-111111111111/application-import/${template.id}/source.pdf`;
    auth.mockResolvedValue({ userId: "11111111-1111-1111-1111-111111111111" });
    maybeSingle.mockResolvedValue({ data: { property_data: { listingSubmission: { ...createDefaultListingSubmission(), propertyApplicationTemplates: [template] } }, updated_at: "2026-09-24T00:00:00Z" }, error: null });
    const { PUT } = await import("@/app/api/portal/application-template-import/route");
    const response = await PUT(new Request("http://localhost/api/portal/application-template-import", { method: "PUT", body: JSON.stringify({ propertyId: "prop-1", templateId: template.id, sourceSha256: "a".repeat(64), draftFingerprint: applicationDraftReviewFingerprint(template.draftQuestionConfig), expectedRevision: "2026-09-24T00:00:00Z", resolvedIssueIndexes: [0] }) }));
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/clearer PDF/);
    expect(update).not.toHaveBeenCalled();
  });

  it("does not disclose a review revision across managers", async () => {
    auth.mockResolvedValue({ userId: "11111111-1111-1111-1111-111111111111" });
    maybeSingle.mockResolvedValue({ data: null, error: null });
    const { GET } = await import("@/app/api/portal/application-template-import/route");
    const response = await GET(new Request("http://localhost/api/portal/application-template-import?propertyId=other&templateId=private&meta=1"));
    expect(response.status).toBe(404);
  });
});
