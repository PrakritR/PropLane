import { describe, expect, it } from "vitest";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import { applicationDraftReviewFingerprint, applicationTemplateQuestionConfigFromSlice, createPropertyApplicationTemplate, publishApplicationTemplateQuestionDraft } from "@/lib/property-application-templates";
import { preserveServerOwnedApplicationVersions } from "@/lib/rental-application/server-owned-template-versions";

describe("server-owned application versions", () => {
  const draft = applicationTemplateQuestionConfigFromSlice({ applicationConfigMode: "custom", disabledStandardApplicationKeys: [], customApplicationFields: [] });
  const published = publishApplicationTemplateQuestionDraft({ ...createPropertyApplicationTemplate({ kind: "long-term" }), draftQuestionConfig: draft });
  const payload = (templates: typeof published[]) => ({ listingSubmission: { ...createDefaultListingSubmission(), propertyApplicationTemplates: templates } });

  it("matches a reviewed question after storage reorders its object keys", () => {
    const field = { id: "imported", key: "contact", label: "Preferred contact", type: "select" as const, required: false, options: ["Email", "Phone"], section: "additional" as const };
    const storedField = { id: field.id, key: field.key, type: field.type, label: field.label, options: field.options, section: field.section, required: field.required };
    expect(applicationDraftReviewFingerprint({ ...draft, customApplicationFields: [field] }))
      .toBe(applicationDraftReviewFingerprint({ ...draft, customApplicationFields: [storedField] }));
  });

  it("strips a forged version from a new template", () => {
    const next = preserveServerOwnedApplicationVersions(payload([published]), payload([])) as ReturnType<typeof payload>;
    expect(next.listingSubmission.propertyApplicationTemplates[0]?.publishedQuestionConfig).toBeUndefined();
  });

  it("strips forged import provenance from a newly submitted template", () => {
    const newTemplate = {
      ...createPropertyApplicationTemplate({ kind: "long-term" }),
      draftQuestionConfig: { ...draft, importProvenance: { sourcePath: "owner/application-import/forged/source.pdf", sourceSha256: "a".repeat(64), unresolvedCount: 0, reviewedByUserId: "attacker" } },
    };
    const next = preserveServerOwnedApplicationVersions(payload([newTemplate]), payload([])) as ReturnType<typeof payload>;
    expect(next.listingSubmission.propertyApplicationTemplates[0]?.draftQuestionConfig?.importProvenance).toBeUndefined();
  });

  it("keeps current and historical snapshots through a stale generic save", () => {
    const modified = { ...published, publishedQuestionConfig: { ...published.publishedQuestionConfig!, version: 99 }, publishedQuestionConfigVersions: [] };
    const next = preserveServerOwnedApplicationVersions(payload([modified]), payload([published])) as ReturnType<typeof payload>;
    expect(next.listingSubmission.propertyApplicationTemplates[0]?.publishedQuestionConfig).toEqual(published.publishedQuestionConfig);
    expect(next.listingSubmission.propertyApplicationTemplates[0]?.publishedQuestionConfigVersions).toEqual(published.publishedQuestionConfigVersions);
  });

  it("does not let an omission erase a published template pinned by applicants", () => {
    const next = preserveServerOwnedApplicationVersions(payload([]), payload([published])) as ReturnType<typeof payload>;
    expect(next.listingSubmission.propertyApplicationTemplates).toEqual([published]);
  });

  it("keeps import review provenance server-owned across generic edits", () => {
    const imported = { ...published, draftQuestionConfig: { ...draft, importProvenance: { sourcePath: "owner/application-import/template/source.pdf", sourceSha256: "a".repeat(64), unresolvedCount: 2 } } };
    const forged = { ...imported, draftQuestionConfig: { ...imported.draftQuestionConfig, importProvenance: { ...imported.draftQuestionConfig.importProvenance, unresolvedCount: 0, reviewedByUserId: "attacker" } } };
    const next = preserveServerOwnedApplicationVersions(payload([forged]), payload([imported])) as ReturnType<typeof payload>;
    expect(next.listingSubmission.propertyApplicationTemplates[0]?.draftQuestionConfig?.importProvenance).toEqual(imported.draftQuestionConfig.importProvenance);
  });

  it("restores imported provenance from published history when the editable draft omits it", () => {
    const provenance = { sourcePath: "owner/application-import/template/source.pdf", sourceSha256: "c".repeat(64), unresolvedCount: 0, reviewedByUserId: "owner", reviewedDraftFingerprint: applicationDraftReviewFingerprint(draft) };
    const importedPublished = publishApplicationTemplateQuestionDraft({
      ...createPropertyApplicationTemplate({ kind: "long-term" }),
      draftQuestionConfig: { ...draft, importProvenance: provenance },
    });
    const stored = {
      ...importedPublished,
      draftQuestionConfig: { ...importedPublished.draftQuestionConfig!, importProvenance: undefined },
    };
    const edited = { ...stored, draftQuestionConfig: { ...draft, customApplicationFields: [{ id: "new", key: "new", label: "New", type: "text" as const, required: false, options: [] }] } };
    const next = preserveServerOwnedApplicationVersions(payload([edited]), payload([stored])) as ReturnType<typeof payload>;
    expect(next.listingSubmission.propertyApplicationTemplates[0]?.draftQuestionConfig?.importProvenance).toEqual(provenance);
  });

  it.each([null, undefined, {}, [], "invalid"])("retains publication history when the whole property payload is %s", (value) => {
    const next = preserveServerOwnedApplicationVersions(value, payload([published])) as ReturnType<typeof payload>;
    expect(next.listingSubmission.propertyApplicationTemplates).toEqual([published]);
  });

  it.each([null, undefined, {}, [], "invalid"])("retains publication history when listingSubmission is %s", (value) => {
    const next = preserveServerOwnedApplicationVersions({ label: "edited", listingSubmission: value }, payload([published])) as ReturnType<typeof payload>;
    expect(next.listingSubmission.propertyApplicationTemplates).toEqual([published]);
  });

  it("retains a deleted imported draft and its review receipt through a later save", () => {
    const imported = {
      ...createPropertyApplicationTemplate({ kind: "long-term" }),
      draftQuestionConfig: {
        ...draft,
        importProvenance: { sourcePath: "owner/application-import/template/source.pdf", sourceSha256: "b".repeat(64), unresolvedCount: 0, reviewedByUserId: "owner", reviewedAt: "now", reviewedDraftFingerprint: "fingerprint" },
      },
    };
    const afterDelete = preserveServerOwnedApplicationVersions(payload([]), payload([imported])) as ReturnType<typeof payload>;
    expect(afterDelete.listingSubmission.propertyApplicationTemplates).toEqual([imported]);
    const replacement = { ...imported, draftQuestionConfig: { ...draft, importProvenance: undefined } };
    const afterRecreate = preserveServerOwnedApplicationVersions(payload([replacement]), afterDelete) as ReturnType<typeof payload>;
    expect(afterRecreate.listingSubmission.propertyApplicationTemplates[0]?.draftQuestionConfig?.importProvenance).toEqual(imported.draftQuestionConfig.importProvenance);
  });

  it("keeps a published template's identity and variant stable", () => {
    const retargeted = { ...published, kind: "short-term" as const, formVariant: "short_term" as const, listingSeedKey: "short-term" as const };
    const next = preserveServerOwnedApplicationVersions(payload([retargeted]), payload([published])) as ReturnType<typeof payload>;
    expect(next.listingSubmission.propertyApplicationTemplates[0]).toMatchObject({
      id: published.id,
      kind: published.kind,
      formVariant: published.formVariant,
      listingSeedKey: published.listingSeedKey,
    });
  });

  it("keeps the original published template reachable after an id change", () => {
    const renamed = { ...published, id: "reused-id" };
    const next = preserveServerOwnedApplicationVersions(payload([renamed]), payload([published])) as ReturnType<typeof payload>;
    expect(next.listingSubmission.propertyApplicationTemplates).toContainEqual(published);
  });

  it("retains protected templates when a valid submission omits its template array", () => {
    const next = preserveServerOwnedApplicationVersions({ listingSubmission: { marker: true } }, payload([published])) as ReturnType<typeof payload>;
    expect(next.listingSubmission.propertyApplicationTemplates).toEqual([published]);
  });
});
