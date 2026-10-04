import { readLeaseTemplateFile } from "@/components/portal/lease-config-form";
import { parseUploadedLeasePdf } from "@/lib/lease-template-parse.client";
import type { PropertyLeaseTemplate, PropertyLeaseTemplateKind } from "@/lib/property-lease-templates";

async function sha256Text(value: string): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("Secure import review is unavailable.");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The lease fields an uploaded PDF writes. */
export type LeaseUploadFields = Pick<
  PropertyLeaseTemplate,
  | "leaseConfigMode"
  | "leaseCustomKind"
  | "leaseTemplateDocUrl"
  | "leaseTemplateDocName"
  | "leaseTemplateHtmlOverride"
  | "leaseTemplateImportReview"
>;

/**
 * The existing lease upload path, without the modal: the same `readLeaseTemplateFile` upload and the
 * same `parseUploadedLeasePdf` conversion the lease form uses. Resolves to the fields to write onto the
 * lease (the PDF, its converted clauses and the import receipt), or null when nothing was uploaded.
 * In demo mode nothing is parsed: the upload is kept and parsed after a real save, as in the modal.
 */
export function importLeasePdf(args: {
  file: File | null;
  kind: PropertyLeaseTemplateKind;
  showToast: (message: string) => void;
  setBusy: (busy: boolean) => void;
}): Promise<LeaseUploadFields | null> {
  return new Promise((resolve) => {
    if (!args.file) {
      resolve(null);
      return;
    }
    let settled = false;
    const done = (value: LeaseUploadFields | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    readLeaseTemplateFile(
      args.file,
      (url, fileName) => {
        const base = {
          leaseConfigMode: "custom" as const,
          leaseCustomKind: "document" as const,
          leaseTemplateDocUrl: url,
          leaseTemplateDocName: fileName,
        };
        if (url.startsWith("data:")) {
          args.showToast("Lease uploaded. Parsing runs after save in demo mode.");
          done({ ...base, leaseTemplateHtmlOverride: "", leaseTemplateImportReview: undefined });
          return;
        }
        args.setBusy(true);
        void parseUploadedLeasePdf({ url, fileName, kind: args.kind })
          .then(async (result) => {
            const unreadable = result.sourceIssues.some((issue) => issue.code === "unreadable_page");
            const html = unreadable ? "" : result.html;
            const review = html
              ? {
                  sourceSha256: result.sourceSha256,
                  convertedHtmlSha256: await sha256Text(html),
                  reviewedAtIso: new Date().toISOString(),
                  templateVersion: `inline@${new Date().toISOString()}`,
                  issueCodes: result.sourceIssues.map((issue) => issue.code),
                  resolvedIssueCodes: [],
                  extractedCharacters: result.coverage.extractedCharacters,
                  representedCharacters: result.coverage.representedCharacters,
                }
              : undefined;
            args.showToast(
              result.sourceIssues.length
                ? "Applied. Check it against the original PDF."
                : `Applied ${result.sections.length} section${result.sections.length === 1 ? "" : "s"}.`,
            );
            done({ ...base, leaseTemplateHtmlOverride: html, leaseTemplateImportReview: review });
          })
          .catch((error) => {
            args.showToast(error instanceof Error ? error.message : "Could not parse that lease PDF.");
            done(null);
          })
          .finally(() => args.setBusy(false));
      },
      (message) => {
        args.showToast(message);
        done(null);
      },
    );
  });
}
