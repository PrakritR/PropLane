/**
 * Publishing what the listing editor's inline Application step left in draft.
 *
 * A generic property save (`POST /api/property-records`) never advances an applicant-visible version: the
 * server keeps the stored published config of every existing form and drops the published config of a new
 * one (`preserveServerOwnedApplicationVersions`). Only `PATCH /api/portal/application-template-import`
 * publishes. The inline step edits the DRAFT, so without this call an edit saved from the listing editor
 * stayed a draft forever and applicants kept seeing the old form.
 *
 * `PublishedMarks` remembers, per form, what the SERVER last published (its version and the fingerprint of
 * that config), so a form is published only when its saved draft is ahead of it, and the version sent is the
 * server's, not the one the editor's own preview publish counted.
 */
import {
  applicationDraftReviewFingerprint,
  applicationTemplateQuestionPublishGate,
  readPropertyApplicationTemplates,
} from "@/lib/property-application-templates";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";

export type PublishedMarks = Map<string, { version: number; fingerprint: string | null }>;

/** What the server has published for each form of a submission it just stored or just loaded. */
export function publishedMarksOf(sub: ManagerListingSubmissionV1 | null | undefined): PublishedMarks {
  const marks: PublishedMarks = new Map();
  if (!sub) return marks;
  for (const template of readPropertyApplicationTemplates(sub)) {
    const published = template.publishedQuestionConfig;
    marks.set(template.id, {
      version: published?.version ?? 0,
      fingerprint: published ? applicationDraftReviewFingerprint(published) : null,
    });
  }
  return marks;
}

/**
 * Publishes every form whose saved draft is ahead of what the server last published, one at a time (each
 * publish rewrites the record). A refusal (the review gate, a stale version) leaves the form a draft and is
 * retried by the next save. Never throws.
 */
export async function publishPendingApplicationVersions(
  propertyId: string,
  saved: ManagerListingSubmissionV1,
  marks: PublishedMarks,
  request: typeof fetch | undefined = typeof fetch === "function" ? fetch : undefined,
): Promise<void> {
  if (!request || !propertyId.trim()) return;
  for (const template of readPropertyApplicationTemplates(saved)) {
    const draft = template.draftQuestionConfig;
    if (!draft) continue;
    const fingerprint = applicationDraftReviewFingerprint(draft);
    const mark = marks.get(template.id);
    if (mark && mark.fingerprint === fingerprint) continue;
    if (!applicationTemplateQuestionPublishGate(template).ok) continue;
    try {
      const response = await request("/api/portal/application-template-import", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ propertyId, templateId: template.id, expectedPublishedVersion: mark?.version ?? 0 }),
      });
      if (!response?.ok) continue;
      const result = (await response.json().catch(() => null)) as { version?: number } | null;
      marks.set(template.id, { version: result?.version ?? (mark?.version ?? 0) + 1, fingerprint });
    } catch {
      // The draft is saved; the next save tries again.
    }
  }
}
