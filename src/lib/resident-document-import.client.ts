import type { ParsedResidentDocument, ResidentDocumentKind } from "@/lib/resident-document-import/types";

export async function parseResidentDocumentPdfClient(args: {
  dataUrl: string;
  fileName: string;
  kind: ResidentDocumentKind;
  propertyId?: string | null;
}): Promise<ParsedResidentDocument> {
  const res = await fetch("/api/portal/parse-resident-document", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      dataUrl: args.dataUrl,
      fileName: args.fileName,
      kind: args.kind,
      propertyId: args.propertyId ?? undefined,
    }),
  });
  const payload = (await res.json().catch(() => ({}))) as { parse?: ParsedResidentDocument; error?: string };
  if (!res.ok) throw new Error(payload.error ?? "Could not read that PDF.");
  if (!payload.parse) throw new Error("Could not read that PDF.");
  return payload.parse;
}

export function parsedFieldsToRecord(fields: ParsedResidentDocument["fields"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of fields) out[field.key] = field.value;
  return out;
}

export function readDataUrlFromFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("Could not read file."));
    reader.readAsDataURL(file);
  });
}
