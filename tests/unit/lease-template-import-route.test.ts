import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.fn();
const limit = vi.fn();
const maybeSingle = vi.fn();
const updateResult = vi.fn();
const parseSource = vi.hoisted(() => vi.fn());
const sourceIssues = [
  { pageNumber: 1, code: "lease_clause_too_short_for_review", message: "Review short source text at page 1, characters 0-10 — likely a header or page mark, not a clause." },
];
const update = vi.fn(() => ({ eq: () => ({ eq: () => ({ eq: () => ({ select: updateResult }) }) }) }));

vi.mock("@/lib/reports/auth", () => ({ getReportsAuthContext: auth }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: limit }));
vi.mock("@/lib/pdf-import/pdf-source.server", () => ({ parsePdfForImport: parseSource }));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    storage: { from: () => ({ download: async () => ({ data: new Blob(["stored original PDF"]), error: null }), upload: async () => ({ error: null }), remove: async () => ({ error: null }) }) },
    from: () => ({
      update,
      select: () => ({
        eq: () => ({ eq: () => ({ maybeSingle }) }),
      }),
    }),
  }),
}));

describe("lease template import route authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    limit.mockResolvedValue({ ok: true });
    parseSource.mockResolvedValue({ sourceSha256: "a".repeat(64), fileName: "lease.pdf", pages: [{ pageNumber: 1, text: "", blocks: [], formFields: [], issues: [] }], issues: sourceIssues, coverage: { extractedCharacters: 0, representedCharacters: 0, complete: true } });
  });

  it("rejects an unauthenticated upload before reading a file", async () => {
    auth.mockResolvedValue(null);
    const { POST } = await import("@/app/api/portal/lease-template-import/route");
    const response = await POST(new Request("http://localhost/api/portal/lease-template-import", { method: "POST" }));
    expect(response.status).toBe(401);
  });

  it("does not parse or store a PDF for a property the manager does not own", async () => {
    auth.mockResolvedValue({ userId: "11111111-1111-1111-1111-111111111111" });
    maybeSingle.mockResolvedValue({ data: null, error: null });
    const body = new FormData();
    body.set("propertyId", "property-other-manager");
    body.set("leaseTemplateId", "lease-tpl-private");
    body.set("file", new File(["%PDF-1.4"], "lease.pdf", { type: "application/pdf" }));
    const { POST } = await import("@/app/api/portal/lease-template-import/route");
    const response = await POST(new Request("http://localhost/api/portal/lease-template-import", { method: "POST", body }));
    expect(response.status).toBe(404);
  });

  it("creates a draft with reported issues from a manager-owned upload", async () => {
    const { createDefaultListingSubmission } = await import("@/lib/manager-listing-submission");
    const { createPropertyLeaseTemplate } = await import("@/lib/property-lease-templates");
    const template = createPropertyLeaseTemplate({ kind: "long-term", source: "axis_default" });
    auth.mockResolvedValue({ userId: "11111111-1111-1111-1111-111111111111" });
    maybeSingle.mockResolvedValue({ data: { property_data: { listingSubmission: { ...createDefaultListingSubmission(), propertyLeaseTemplates: [template] } }, updated_at: "2026-09-24T00:00:00Z" }, error: null });
    updateResult.mockResolvedValue({ data: [{ id: "prop-1" }], error: null });
    const body = new FormData();
    body.set("propertyId", "prop-1");
    body.set("leaseTemplateId", template.id);
    body.set("file", new File(["%PDF-1.4"], "lease.pdf", { type: "application/pdf" }));
    const { POST } = await import("@/app/api/portal/lease-template-import/route");
    const response = await POST(new Request("http://localhost/api/portal/lease-template-import", { method: "POST", body }));
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.issues).toEqual(sourceIssues);
    expect(json.draft.importProvenance.unresolvedCount).toBe(sourceIssues.length);
    expect(update).toHaveBeenCalledOnce();
  });

  it("refuses a stale publish before writing", async () => {
    const { createDefaultListingSubmission } = await import("@/lib/manager-listing-submission");
    const { createPropertyLeaseTemplate, leaseTemplateQuestionConfigFromSlice, publishLeaseTemplateQuestionDraft } = await import("@/lib/property-lease-templates");
    const base = createPropertyLeaseTemplate({ kind: "long-term", source: "axis_default" });
    const template = publishLeaseTemplateQuestionDraft({ ...base, draftQuestionConfig: leaseTemplateQuestionConfigFromSlice({ disabledStandardApplicationKeys: [], customApplicationFields: [], applicationConfigMode: "custom" }) });
    auth.mockResolvedValue({ userId: "11111111-1111-1111-1111-111111111111" });
    maybeSingle.mockResolvedValue({ data: { property_data: { listingSubmission: { ...createDefaultListingSubmission(), propertyLeaseTemplates: [template] } }, updated_at: "2026-09-24T00:00:00Z" }, error: null });
    const { PATCH } = await import("@/app/api/portal/lease-template-import/route");
    const response = await PATCH(new Request("http://localhost/api/portal/lease-template-import", { method: "PATCH", body: JSON.stringify({ propertyId: "prop-1", leaseTemplateId: template.id, expectedPublishedVersion: 0 }) }));
    expect(response.status).toBe(409);
    expect(update).not.toHaveBeenCalled();
  });

  it("issues the next version only from a manager-owned draft with CAS", async () => {
    const { createDefaultListingSubmission } = await import("@/lib/manager-listing-submission");
    const { createPropertyLeaseTemplate, leaseTemplateQuestionConfigFromSlice } = await import("@/lib/property-lease-templates");
    const base = createPropertyLeaseTemplate({ kind: "long-term", source: "axis_default" });
    const template = { ...base, draftQuestionConfig: leaseTemplateQuestionConfigFromSlice({ disabledStandardApplicationKeys: [], customApplicationFields: [], applicationConfigMode: "custom" }) };
    auth.mockResolvedValue({ userId: "11111111-1111-1111-1111-111111111111" });
    maybeSingle.mockResolvedValue({ data: { property_data: { listingSubmission: { ...createDefaultListingSubmission(), propertyLeaseTemplates: [template] } }, updated_at: "2026-09-24T00:00:00Z" }, error: null });
    updateResult.mockResolvedValue({ data: [{ id: "prop-1" }], error: null });
    const { PATCH } = await import("@/app/api/portal/lease-template-import/route");
    const response = await PATCH(new Request("http://localhost/api/portal/lease-template-import", { method: "PATCH", body: JSON.stringify({ propertyId: "prop-1", leaseTemplateId: template.id, expectedPublishedVersion: 0 }) }));
    expect(response.status).toBe(200);
    expect((await response.json()).version).toBe(1);
    expect(update).toHaveBeenCalledOnce();
  });

  it("does not report a publish when the conditional write loses the race", async () => {
    const { createDefaultListingSubmission } = await import("@/lib/manager-listing-submission");
    const { createPropertyLeaseTemplate, leaseTemplateQuestionConfigFromSlice } = await import("@/lib/property-lease-templates");
    const base = createPropertyLeaseTemplate({ kind: "long-term", source: "axis_default" });
    const template = { ...base, draftQuestionConfig: leaseTemplateQuestionConfigFromSlice({ disabledStandardApplicationKeys: [], customApplicationFields: [], applicationConfigMode: "custom" }) };
    auth.mockResolvedValue({ userId: "11111111-1111-1111-1111-111111111111" });
    maybeSingle.mockResolvedValue({ data: { property_data: { listingSubmission: { ...createDefaultListingSubmission(), propertyLeaseTemplates: [template] } }, updated_at: "2026-09-24T00:00:00Z" }, error: null });
    updateResult.mockResolvedValue({ data: [], error: null });
    const { PATCH } = await import("@/app/api/portal/lease-template-import/route");
    const response = await PATCH(new Request("http://localhost/api/portal/lease-template-import", { method: "PATCH", body: JSON.stringify({ propertyId: "prop-1", leaseTemplateId: template.id, expectedPublishedVersion: 0 }) }));
    expect(response.status).toBe(409);
  });

  it("binds explicit source review to the viewed draft, stored source, and property revision, then publishes", async () => {
    const { createDefaultListingSubmission } = await import("@/lib/manager-listing-submission");
    const { createPropertyLeaseTemplate, leaseTemplateQuestionConfigFromSlice, leaseDraftReviewFingerprint } = await import("@/lib/property-lease-templates");
    const storedIssues = sourceIssues.map((issue) => ({ code: issue.code, message: issue.message, pageNumber: issue.pageNumber }));
    const base = createPropertyLeaseTemplate({ kind: "long-term", source: "axis_default" });
    const template = { ...base, draftQuestionConfig: { ...leaseTemplateQuestionConfigFromSlice({ disabledStandardApplicationKeys: [], customApplicationFields: [], applicationConfigMode: "custom" }), importProvenance: { sourcePath: "", sourceSha256: "a".repeat(64), unresolvedCount: 1, issues: storedIssues } } };
    template.draftQuestionConfig.importProvenance.sourcePath = `11111111-1111-1111-1111-111111111111/lease-import/${template.id}/source.pdf`;
    auth.mockResolvedValue({ userId: "11111111-1111-1111-1111-111111111111" });
    maybeSingle.mockResolvedValue({ data: { property_data: { listingSubmission: { ...createDefaultListingSubmission(), propertyLeaseTemplates: [template] } }, updated_at: "2026-09-24T00:00:00Z" }, error: null });
    const { GET, PUT } = await import("@/app/api/portal/lease-template-import/route");
    const meta = await GET(new Request(`http://localhost/api/portal/lease-template-import?propertyId=prop-1&leaseTemplateId=${template.id}&meta=1`));
    expect(meta.status).toBe(200);
    expect(await meta.json()).toEqual({ draftFingerprint: leaseDraftReviewFingerprint(template.draftQuestionConfig), revision: "2026-09-24T00:00:00Z" });

    const unacknowledged = await PUT(new Request("http://localhost/api/portal/lease-template-import", { method: "PUT", body: JSON.stringify({ propertyId: "prop-1", leaseTemplateId: template.id, sourceSha256: "a".repeat(64), draftFingerprint: leaseDraftReviewFingerprint(template.draftQuestionConfig), expectedRevision: "2026-09-24T00:00:00Z", resolvedIssueIndexes: [] }) }));
    expect(unacknowledged.status).toBe(409);
    expect(update).not.toHaveBeenCalled();

    updateResult.mockResolvedValue({ data: [{ id: "prop-1" }], error: null });
    const good = await PUT(new Request("http://localhost/api/portal/lease-template-import", { method: "PUT", body: JSON.stringify({ propertyId: "prop-1", leaseTemplateId: template.id, sourceSha256: "a".repeat(64), draftFingerprint: leaseDraftReviewFingerprint(template.draftQuestionConfig), expectedRevision: "2026-09-24T00:00:00Z", resolvedIssueIndexes: [0] }) }));
    expect(good.status).toBe(200);
    expect((await good.json()).draft.importProvenance.reviewedByUserId).toBe("11111111-1111-1111-1111-111111111111");
    expect(update.mock.calls.at(-1)?.[0]?.property_data?.listingSubmission?.propertyLeaseTemplates?.[0]?.draftQuestionConfig?.importProvenance?.resolvedIssueIndexes).toEqual([0]);
  });

  it("does not disclose a review revision across managers", async () => {
    auth.mockResolvedValue({ userId: "11111111-1111-1111-1111-111111111111" });
    maybeSingle.mockResolvedValue({ data: null, error: null });
    const { GET } = await import("@/app/api/portal/lease-template-import/route");
    const response = await GET(new Request("http://localhost/api/portal/lease-template-import?propertyId=other&leaseTemplateId=private&meta=1"));
    expect(response.status).toBe(404);
  });

  it("streams the original PDF back only for the exact stored source path", async () => {
    const { createDefaultListingSubmission } = await import("@/lib/manager-listing-submission");
    const { createPropertyLeaseTemplate, leaseTemplateQuestionConfigFromSlice } = await import("@/lib/property-lease-templates");
    const base = createPropertyLeaseTemplate({ kind: "long-term", source: "axis_default" });
    const path = `11111111-1111-1111-1111-111111111111/lease-import/${base.id}/source.pdf`;
    const template = { ...base, draftQuestionConfig: { ...leaseTemplateQuestionConfigFromSlice({ disabledStandardApplicationKeys: [], customApplicationFields: [], applicationConfigMode: "custom" }), importProvenance: { sourcePath: path, sourceSha256: "a".repeat(64), unresolvedCount: 0, issues: [] } } };
    auth.mockResolvedValue({ userId: "11111111-1111-1111-1111-111111111111" });
    maybeSingle.mockResolvedValue({ data: { property_data: { listingSubmission: { ...createDefaultListingSubmission(), propertyLeaseTemplates: [template] } }, updated_at: "2026-09-24T00:00:00Z" }, error: null });
    const { GET } = await import("@/app/api/portal/lease-template-import/route");
    const wrongPath = await GET(new Request(`http://localhost/api/portal/lease-template-import?propertyId=prop-1&leaseTemplateId=${template.id}&path=11111111-1111-1111-1111-111111111111/lease-import/${template.id}/other.pdf`));
    expect(wrongPath.status).toBe(404);
    const response = await GET(new Request(`http://localhost/api/portal/lease-template-import?propertyId=prop-1&leaseTemplateId=${template.id}&path=${path}`));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
  });
});
