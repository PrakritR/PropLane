import { NextResponse } from "next/server";
import { mapApplicationPdfImport, applicationImportMappingToDraft } from "@/lib/rental-application/application-pdf-import";
import { parsePdfForImport } from "@/lib/pdf-import/pdf-source.server";
import {
  applicationTemplateQuestionConfigFromSlice,
  applicationDraftReviewFingerprint,
  publishApplicationTemplateQuestionDraft,
  applicationFormVariantForTemplate,
  readPropertyApplicationTemplates,
  updatePropertyApplicationTemplate,
  withPropertyApplicationTemplatesExplicit,
} from "@/lib/property-application-templates";
import { LEASE_TEMPLATE_BUCKET, LEASE_TEMPLATE_MAX_BYTES } from "@/lib/lease-template-storage";
import { rateLimit } from "@/lib/rate-limit";
import { getReportsAuthContext } from "@/lib/reports/auth";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";

export const runtime = "nodejs";
// Bounded local OCR allows four 12-second page attempts plus PDF extraction.
export const maxDuration = 60;

const IMPORT_PATH = /^[0-9a-f-]{36}\/application-import\/[A-Za-z0-9-]{1,120}\/[A-Za-z0-9._-]+\.pdf$/i;

function sourcePath(userId: string, templateId: string): string {
  return `${userId}/application-import/${templateId}/${Date.now()}-${crypto.randomUUID()}.pdf`;
}

/** Publishing is the only path that can advance an applicant-visible version. */
export async function PATCH(req: Request) {
  const auth = await getReportsAuthContext();
  if (!auth?.userId) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const body = await req.json().catch(() => null) as { propertyId?: string; templateId?: string; expectedPublishedVersion?: number } | null;
  const propertyId = body?.propertyId?.trim() ?? "";
  const templateId = body?.templateId?.trim() ?? "";
  if (!propertyId || !templateId || !Number.isSafeInteger(body?.expectedPublishedVersion) || (body?.expectedPublishedVersion ?? -1) < 0) {
    return NextResponse.json({ error: "Property, template, and expected version are required." }, { status: 400 });
  }
  const owned = await ownedTemplate(auth.userId, propertyId, templateId);
  if (!owned) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const current = readPropertyApplicationTemplates(owned.submission).find((item) => item.id === templateId)!;
  if ((current.publishedQuestionConfig?.version ?? 0) !== body!.expectedPublishedVersion) {
    return NextResponse.json({ error: "This form was already published by another edit. Reload before publishing." }, { status: 409 });
  }
  let published;
  try { published = publishApplicationTemplateQuestionDraft(current); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Review the draft before publishing." }, { status: 422 }); }
  const templates = updatePropertyApplicationTemplate(readPropertyApplicationTemplates(owned.submission), templateId, published);
  const nextSubmission = withPropertyApplicationTemplatesExplicit(owned.submission, templates);
  const { data, error } = await owned.db.from("manager_property_records")
    .update({ property_data: { ...owned.propertyData, listingSubmission: nextSubmission }, updated_at: new Date().toISOString() })
    .eq("id", propertyId).eq("manager_user_id", auth.userId).eq("updated_at", owned.updatedAt).select("id");
  if (error) return NextResponse.json({ error: "Could not publish the application." }, { status: 502 });
  if (!data?.length) return NextResponse.json({ error: "The property changed while publishing. Reload and try again." }, { status: 409 });
  return NextResponse.json({ version: published.publishedQuestionConfig?.version, template: published });
}

/** The manager explicitly acknowledges the exact imported source before publish. */
export async function PUT(req: Request) {
  const auth = await getReportsAuthContext();
  if (!auth?.userId) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const body = await req.json().catch(() => null) as { propertyId?: string; templateId?: string; sourceSha256?: string; draftFingerprint?: string; expectedRevision?: string; resolvedIssueIndexes?: number[] } | null;
  const propertyId = body?.propertyId?.trim() ?? "";
  const templateId = body?.templateId?.trim() ?? "";
  const owned = await ownedTemplate(auth.userId, propertyId, templateId);
  if (!owned) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const template = readPropertyApplicationTemplates(owned.submission).find((item) => item.id === templateId)!;
  const provenance = template.draftQuestionConfig?.importProvenance;
  if (!provenance?.sourcePath || !provenance.sourceSha256 || provenance.sourceSha256 !== body?.sourceSha256) {
    return NextResponse.json({ error: "The imported source changed. Compare it again before publishing." }, { status: 409 });
  }
  const draftFingerprint = applicationDraftReviewFingerprint(template.draftQuestionConfig!);
  if (!body?.draftFingerprint || body.draftFingerprint !== draftFingerprint || !body.expectedRevision || body.expectedRevision !== owned.updatedAt) {
    return NextResponse.json({ error: "The application draft changed. Compare it again before publishing." }, { status: 409 });
  }
  if (!IMPORT_PATH.test(provenance.sourcePath) || !provenance.sourcePath.startsWith(`${auth.userId}/application-import/${templateId}/`)) {
    return NextResponse.json({ error: "The imported source is unavailable. Import it again." }, { status: 409 });
  }
  const { data: sourceFile, error: sourceError } = await owned.db.storage.from(LEASE_TEMPLATE_BUCKET).download(provenance.sourcePath);
  if (sourceError || !sourceFile) return NextResponse.json({ error: "The original PDF is unavailable. Import it again." }, { status: 409 });
  let source;
  try {
    source = await parsePdfForImport({ bytes: new Uint8Array(await sourceFile.arrayBuffer()), fileName: provenance.sourceName ?? "application.pdf" });
  } catch {
    return NextResponse.json({ error: "The original PDF could not be read. Import it again." }, { status: 409 });
  }
  if (source.sourceSha256 !== provenance.sourceSha256) {
    return NextResponse.json({ error: "The original PDF changed. Import it again." }, { status: 409 });
  }
  const mapping = mapApplicationPdfImport(source);
  if (applicationFormVariantForTemplate(template) === "cosigner") {
    for (const question of mapping.questions.filter((item) => item.type === "file" || item.type === "photos")) {
      mapping.issues.push({ pageNumber: question.sourcePage, code: "cosigner_upload_unavailable", message: `“${question.label}” needs an upload, which the co-signer form cannot collect. Remove this question before publishing.` });
    }
  }
  const storedIssues = provenance.issues ?? [];
  if (mapping.issues.length !== storedIssues.length || mapping.issues.some((issue, index) =>
    issue.pageNumber !== storedIssues[index]?.pageNumber ||
    issue.code !== storedIssues[index]?.code ||
    issue.message !== storedIssues[index]?.message
  )) {
    return NextResponse.json({ error: "The PDF reading changed. Import it again before publishing." }, { status: 409 });
  }
  if (mapping.issues.some((issue) => issue.code === "unreadable_page")) {
    return NextResponse.json({ error: "Some PDF pages could not be read. Upload a clearer PDF before publishing." }, { status: 409 });
  }
  const resolvedIssueIndexes = body?.resolvedIssueIndexes;
  if (!Array.isArray(resolvedIssueIndexes) ||
    resolvedIssueIndexes.length !== mapping.issues.length ||
    new Set(resolvedIssueIndexes).size !== mapping.issues.length ||
    resolvedIssueIndexes.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= mapping.issues.length)
  ) return NextResponse.json({ error: "Resolve each listed PDF issue before confirming the application." }, { status: 409 });
  const reviewed = updatePropertyApplicationTemplate(readPropertyApplicationTemplates(owned.submission), templateId, {
    draftQuestionConfig: { ...template.draftQuestionConfig!, importProvenance: { ...provenance, unresolvedCount: 0, issues: mapping.issues, resolvedIssueIndexes, reviewedByUserId: auth.userId, reviewedAt: new Date().toISOString(), reviewedDraftFingerprint: draftFingerprint } },
  });
  const nextSubmission = withPropertyApplicationTemplatesExplicit(owned.submission, reviewed);
  const { data, error } = await owned.db.from("manager_property_records")
    .update({ property_data: { ...owned.propertyData, listingSubmission: nextSubmission }, updated_at: new Date().toISOString() })
    .eq("id", propertyId).eq("manager_user_id", auth.userId).eq("updated_at", owned.updatedAt).select("id");
  if (error) return NextResponse.json({ error: "Could not record the source review." }, { status: 502 });
  if (!data?.length) return NextResponse.json({ error: "The property changed while reviewing. Reload and compare again." }, { status: 409 });
  return NextResponse.json({ draft: reviewed.find((item) => item.id === templateId)?.draftQuestionConfig });
}

function submissionFrom(row: unknown): ManagerListingSubmissionV1 | null {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const submission = (row as { listingSubmission?: unknown }).listingSubmission;
  return submission && typeof submission === "object" && !Array.isArray(submission)
    ? (submission as ManagerListingSubmissionV1)
    : null;
}

async function ownedTemplate(userId: string, propertyId: string, templateId: string) {
  const db = createSupabaseServiceRoleClient();
  const { data, error } = await db
    .from("manager_property_records")
    .select("property_data, updated_at")
    .eq("id", propertyId)
    .eq("manager_user_id", userId)
    .maybeSingle();
  if (error || !data) return null;
  const submission = submissionFrom(data.property_data);
  if (!submission || !readPropertyApplicationTemplates(submission).some((template) => template.id === templateId)) return null;
  return { db, submission, propertyData: data.property_data as Record<string, unknown>, updatedAt: data.updated_at };
}

/** Upload, store, then parse a manager-owned original. Nothing reaches a model. */
export async function POST(req: Request) {
  const auth = await getReportsAuthContext();
  if (!auth?.userId) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  if (!(await rateLimit(`application-template-import:${auth.userId}`, 8, 60_000)).ok) {
    return NextResponse.json({ error: "Too many imports. Try again shortly." }, { status: 429 });
  }
  const body = await req.formData().catch(() => null);
  const propertyId = typeof body?.get("propertyId") === "string" ? String(body.get("propertyId")).trim() : "";
  const templateId = typeof body?.get("templateId") === "string" ? String(body.get("templateId")).trim() : "";
  const file = body?.get("file");
  if (!propertyId || !templateId || !(file instanceof File)) return NextResponse.json({ error: "Property, application, and PDF are required." }, { status: 400 });
  if (file.type !== "application/pdf" || file.size < 8 || file.size > LEASE_TEMPLATE_MAX_BYTES) {
    return NextResponse.json({ error: "Upload a PDF between 8 bytes and 8 MB." }, { status: 400 });
  }
  const owned = await ownedTemplate(auth.userId, propertyId, templateId);
  if (!owned) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const bytes = new Uint8Array(await file.arrayBuffer());
  let source;
  try {
    source = await parsePdfForImport({ bytes, fileName: file.name });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not read the PDF." }, { status: 422 });
  }
  const path = sourcePath(auth.userId, templateId);
  const { error: uploadError } = await owned.db.storage.from(LEASE_TEMPLATE_BUCKET).upload(path, bytes, {
    contentType: "application/pdf", cacheControl: "0", upsert: false,
  });
  if (uploadError) return NextResponse.json({ error: "Could not securely store the original PDF." }, { status: 502 });
  const mapping = mapApplicationPdfImport(source);
  const targetTemplate = readPropertyApplicationTemplates(owned.submission).find((item) => item.id === templateId)!;
  if (applicationFormVariantForTemplate(targetTemplate) === "cosigner") {
    for (const question of mapping.questions.filter((item) => item.type === "file" || item.type === "photos")) {
      mapping.issues.push({ pageNumber: question.sourcePage, code: "cosigner_upload_unavailable", message: `“${question.label}” needs an upload, which the co-signer form cannot collect. Remove this question before publishing.` });
    }
  }
  const draft = applicationTemplateQuestionConfigFromSlice(applicationImportMappingToDraft(mapping));
  draft.importProvenance = {
    sourceName: source.fileName,
    sourcePath: path,
    sourceSha256: source.sourceSha256,
    importedAt: new Date().toISOString(),
    unresolvedCount: mapping.issues.length,
    issues: mapping.issues,
  };
  const templates = updatePropertyApplicationTemplate(
    readPropertyApplicationTemplates(owned.submission),
    templateId,
    { draftQuestionConfig: draft },
  );
  const nextSubmission = withPropertyApplicationTemplatesExplicit(owned.submission, templates);
  const { data: savedRows, error: saveError } = await owned.db
    .from("manager_property_records")
    .update({ property_data: { ...owned.propertyData, listingSubmission: nextSubmission }, updated_at: new Date().toISOString() })
    .eq("id", propertyId)
    .eq("manager_user_id", auth.userId)
    .eq("updated_at", owned.updatedAt)
    .select("id");
  if (saveError || !savedRows?.length) {
    await owned.db.storage.from(LEASE_TEMPLATE_BUCKET).remove([path]);
    return NextResponse.json({ error: "Could not save the imported application draft." }, { status: 502 });
  }
  return NextResponse.json({ draft, issues: mapping.issues, source: { path, pageCount: source.pages.length, sourceSha256: source.sourceSha256 } });
}

/** Original comparison stream. Both property and owner are re-derived per request. */
export async function GET(req: Request) {
  const auth = await getReportsAuthContext();
  if (!auth?.userId) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const url = new URL(req.url);
  const propertyId = url.searchParams.get("propertyId")?.trim() ?? "";
  const templateId = url.searchParams.get("templateId")?.trim() ?? "";
  if (url.searchParams.get("meta") === "1") {
    const owned = await ownedTemplate(auth.userId, propertyId, templateId);
    if (!owned) return NextResponse.json({ error: "Not found." }, { status: 404 });
    const draft = readPropertyApplicationTemplates(owned.submission).find((item) => item.id === templateId)?.draftQuestionConfig;
    if (!draft?.importProvenance?.sourcePath) return NextResponse.json({ error: "Not found." }, { status: 404 });
    return NextResponse.json({ draftFingerprint: applicationDraftReviewFingerprint(draft), revision: owned.updatedAt }, { headers: { "Cache-Control": "private, no-store" } });
  }
  const path = url.searchParams.get("path")?.trim() ?? "";
  if (!IMPORT_PATH.test(path) || !path.startsWith(`${auth.userId}/application-import/${templateId}/`)) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const owned = await ownedTemplate(auth.userId, propertyId, templateId);
  if (!owned) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const template = readPropertyApplicationTemplates(owned.submission).find((item) => item.id === templateId);
  const storedPath = template?.draftQuestionConfig?.importProvenance?.sourcePath;
  if (storedPath !== path) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const { data, error } = await owned.db.storage.from(LEASE_TEMPLATE_BUCKET).download(path);
  if (error || !data) return NextResponse.json({ error: "Not found." }, { status: 404 });
  return new NextResponse(data, { headers: { "Content-Type": "application/pdf", "Cache-Control": "private, no-store", "Content-Disposition": "inline; filename=original-application.pdf" } });
}
