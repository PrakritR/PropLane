import type { ApplicationTemplateQuestionConfig } from "@/lib/property-application-templates";
import type { ManagerCustomApplicationField } from "@/lib/manager-listing-submission";
import { emptyCustomApplicationField } from "@/lib/manager-listing-submission";

const DOCUMENTS_SECTION_ID = "documents";

function hasDocumentUploadQuestions(fields: ManagerCustomApplicationField[]): boolean {
  return fields.some((f) => /photo id|proof of income/i.test(f.label ?? ""));
}

/**
 * One-time migration: legacy property "ask for photo ID / proof of income"
 * toggles become ordinary file-upload questions in a Documents section
 * (replica forms-redesign-0927 `withDocuments`).
 */
export function migrateApplicationTemplateDocumentQuestions(
  config: ApplicationTemplateQuestionConfig,
  opts?: { askPhotoId?: boolean; askProofOfIncome?: boolean },
): ApplicationTemplateQuestionConfig {
  if (config.documentsQuestionsMigrated) return config;
  if (config.importProvenance?.sourcePath) return { ...config, documentsQuestionsMigrated: true };

  const fields = [...(config.customApplicationFields ?? [])];
  if (hasDocumentUploadQuestions(fields)) {
    return { ...config, documentsQuestionsMigrated: true };
  }

  const askId = opts?.askPhotoId !== false;
  const askIncome = opts?.askProofOfIncome !== false;
  const additions: ManagerCustomApplicationField[] = [];
  if (askId) {
    additions.push({
      ...emptyCustomApplicationField(),
      id: "photoId",
      label: "Photo ID, front and back",
      type: "file",
      section: DOCUMENTS_SECTION_ID,
      required: false,
    });
  }
  if (askIncome) {
    additions.push({
      ...emptyCustomApplicationField(),
      id: "proofIncome",
      label: "Proof of income",
      type: "file",
      section: DOCUMENTS_SECTION_ID,
      required: false,
    });
  }
  if (!additions.length) {
    return { ...config, documentsQuestionsMigrated: true };
  }

  const disabled = [...(config.disabledStandardApplicationKeys ?? [])];
  return {
    ...config,
    customApplicationFields: [...fields, ...additions],
    disabledStandardApplicationKeys: disabled,
    documentsQuestionsMigrated: true,
  };
}
