import { leaseTemplateObjectPath } from "@/lib/lease-template-storage";
import type { PropertyLeaseTemplateKind } from "@/lib/property-lease-templates";

export type ParseLeasePdfResult = {
  html: string;
  inferredKind: PropertyLeaseTemplateKind;
  sectionCount: number;
  sourceSha256: string;
  sourceIssues: Array<{ pageNumber: number | null; code: string; message: string }>;
  coverage: { extractedCharacters: number; representedCharacters: number; complete: boolean };
};

export async function parseUploadedLeasePdf(args: {
  url: string;
  fileName: string;
  kind?: PropertyLeaseTemplateKind;
}): Promise<ParseLeasePdfResult> {
  const path = leaseTemplateObjectPath(args.url);
  if (!path) {
    throw new Error("Upload the lease template first, then parse it.");
  }
  const res = await fetch("/api/portal/parse-lease-pdf", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path,
      fileName: args.fileName,
      kind: args.kind,
    }),
  });
  const payload = (await res.json().catch(() => ({}))) as ParseLeasePdfResult & { error?: string };
  if (!res.ok) {
    throw new Error(payload.error ?? "Could not parse that lease PDF.");
  }
  return payload;
}
