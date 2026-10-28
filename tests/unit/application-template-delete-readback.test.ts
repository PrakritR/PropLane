import { describe, expect, it } from "vitest";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import {
  submissionAfterRemovingApplicationTemplate,
  submissionHasApplicationTemplate,
} from "@/lib/property-application-template-sync";
import { createPropertyApplicationTemplate } from "@/lib/property-application-templates";

describe("application delete read-back", () => {
  const keep = createPropertyApplicationTemplate({ kind: "long-term" });
  const gone = createPropertyApplicationTemplate({ kind: "long-term" });

  it("carries an explicit removal list on the delete save only", () => {
    const sub = createDefaultListingSubmission();
    const out = submissionAfterRemovingApplicationTemplate(sub, [keep], [gone.id]);
    expect(out.removedApplicationTemplateIds).toEqual([gone.id]);
    expect(submissionAfterRemovingApplicationTemplate(sub, [keep]).removedApplicationTemplateIds).toBeUndefined();
  });

  it("reports a template the server kept, so the toast can fail", () => {
    const stored = { ...createDefaultListingSubmission(), propertyApplicationTemplates: [keep, gone] };
    expect(submissionHasApplicationTemplate(stored, gone.id)).toBe(true);
    expect(submissionHasApplicationTemplate({ ...stored, propertyApplicationTemplates: [keep] }, gone.id)).toBe(false);
    expect(submissionHasApplicationTemplate(null, gone.id)).toBe(false);
  });
});
