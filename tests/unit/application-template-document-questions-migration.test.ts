import { describe, expect, it } from "vitest";
import { migrateApplicationTemplateDocumentQuestions } from "@/lib/application-template-document-questions-migration";
import { applicationTemplateQuestionConfigFromSlice } from "@/lib/property-application-templates";

describe("migrateApplicationTemplateDocumentQuestions", () => {
  it("adds Photo ID and proof of income file questions once", () => {
    const base = applicationTemplateQuestionConfigFromSlice({
      disabledStandardApplicationKeys: [],
      applicationConfigMode: "custom",
      customApplicationFields: [],
    });
    const migrated = migrateApplicationTemplateDocumentQuestions(base);
    expect(migrated.documentsQuestionsMigrated).toBe(true);
    const labels = migrated.customApplicationFields?.map((f) => f.label) ?? [];
    expect(labels).toContain("Photo ID, front and back");
    expect(labels).toContain("Proof of income");
    const again = migrateApplicationTemplateDocumentQuestions(migrated);
    expect(again.customApplicationFields?.length).toBe(migrated.customApplicationFields?.length);
  });
});
