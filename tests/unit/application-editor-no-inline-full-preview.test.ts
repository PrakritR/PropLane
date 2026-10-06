import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

/**
 * The applicant's full form (property card, Lease · About you · Details · Review · Fee) is never drawn inline
 * at the foot of an application editor. The applicant preview lives only in the shell's "Applicant sees" panel
 * (right column from lg; behind the header Preview eye below lg).
 */
describe("application editors draw no inline full-form preview", () => {
  const editors = [
    "src/components/portal/pro-application-questions-editor-modal.tsx",
    "src/components/portal/property-application-form-modal.tsx",
    "src/components/portal/listing-wizard-v2/inline-application-questions.tsx",
    "src/components/portal/question-editor/application-questions-editor.tsx",
  ];

  it.each(editors)("%s mounts neither RentalApplicationWizard nor CosignerApplyFlow", (path) => {
    const source = read(path);
    expect(source).not.toMatch(/<RentalApplicationWizard\b/);
    expect(source).not.toMatch(/<CosignerApplyFlow\b/);
    expect(source).not.toContain("application-full-wizard-preview");
  });

  it("the template editor's preview is the side panel", () => {
    const source = read("src/components/portal/pro-application-questions-editor-modal.tsx");
    expect(source).toMatch(/sidePanel=\{\s*<ApplicationSectionPreviewPane/);
  });

  it("the shell opens the side panel behind the header Preview eye below lg", () => {
    expect(read("src/components/portal/add-workspace/index.tsx")).toMatch(/previewInEye/);
  });
});
