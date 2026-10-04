import { LEASE_TEMPLATE_MAX_BYTES } from "@/lib/lease-template-storage";
import type { ApplicationTemplateQuestionConfig } from "@/lib/property-application-templates";

/** What the application PDF import returns: the parsed question draft, its source issues and the stored original. */
export type ApplicationPdfImport = {
  draft: ApplicationTemplateQuestionConfig;
  issues: Array<{ pageNumber: number | null; code: string; message: string }>;
  sourcePath: string | null;
};

/**
 * The existing application PDF import, without the modal: the same `POST /api/portal/application-template-import`
 * the application editor calls (the route stores the original, then parses it; nothing reaches a model). The route
 * takes any plain template id for a property the manager owns, so a brand-new application can be imported before it
 * is saved. Resolves to the draft to write onto the application, or null when nothing was imported.
 */
export async function importApplicationPdf(args: {
  propertyId: string;
  templateId: string;
  file: File | null;
  showToast: (message: string) => void;
  setBusy?: (busy: boolean) => void;
}): Promise<ApplicationPdfImport | null> {
  const { file, showToast } = args;
  if (!file) return null;
  if (!(file.type === "application/pdf" || /\.pdf$/i.test(file.name))) {
    showToast("Choose a PDF file.");
    return null;
  }
  if (file.size > LEASE_TEMPLATE_MAX_BYTES) {
    showToast("The PDF must be 8 MB or smaller.");
    return null;
  }
  args.setBusy?.(true);
  try {
    const body = new FormData();
    body.set("propertyId", args.propertyId);
    body.set("templateId", args.templateId);
    body.set("file", file);
    const response = await fetch("/api/portal/application-template-import", { method: "POST", body });
    const result = (await response.json().catch(() => null)) as {
      error?: string;
      draft?: ApplicationTemplateQuestionConfig;
      source?: { path?: string };
      issues?: ApplicationPdfImport["issues"];
    } | null;
    if (!response.ok || !result) throw new Error(result?.error || "Could not import the application PDF.");
    if (!result.draft) throw new Error("Could not read any questions from that PDF.");
    const issues = result.issues ?? [];
    showToast(issues.length ? "Applied. Resolve the flagged source issues before publishing." : "Applied the imported questions.");
    return { draft: result.draft, issues, sourcePath: result.source?.path ?? null };
  } catch (error) {
    showToast(error instanceof Error ? error.message : "Could not import the application PDF.");
    return null;
  } finally {
    args.setBusy?.(false);
  }
}
