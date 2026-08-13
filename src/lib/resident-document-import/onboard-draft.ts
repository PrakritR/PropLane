import type { ParsedResidentDocument } from "@/lib/resident-document-import/types";

export type ResidentOnboardDraft = {
  propertyId: string;
  propertyLabel: string;
  roomId: string;
  fields: Record<string, string>;
  applicationFileName?: string;
  applicationDataUrl?: string;
  applicationParse?: ParsedResidentDocument | null;
  leaseFileName?: string;
  leaseDataUrl?: string;
  leaseParse?: ParsedResidentDocument | null;
  leaseFullyExecuted: boolean;
  sendAccountSetup: boolean;
};

const KEY_PREFIX = "axis:resident-onboard-draft:";

export function residentOnboardDraftKey(propertyId: string): string {
  return `${KEY_PREFIX}${propertyId.trim()}`;
}

export function readResidentOnboardDraft(propertyId: string): ResidentOnboardDraft | null {
  if (typeof window === "undefined" || !propertyId.trim()) return null;
  try {
    const raw = sessionStorage.getItem(residentOnboardDraftKey(propertyId));
    if (!raw) return null;
    return JSON.parse(raw) as ResidentOnboardDraft;
  } catch {
    return null;
  }
}

export function writeResidentOnboardDraft(draft: ResidentOnboardDraft): void {
  if (typeof window === "undefined" || !draft.propertyId.trim()) return;
  sessionStorage.setItem(residentOnboardDraftKey(draft.propertyId), JSON.stringify(draft));
}

export function clearResidentOnboardDraft(propertyId: string): void {
  if (typeof window === "undefined" || !propertyId.trim()) return;
  sessionStorage.removeItem(residentOnboardDraftKey(propertyId));
}

export function mergeParsedFields(
  application: ParsedResidentDocument | null | undefined,
  lease: ParsedResidentDocument | null | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  const apply = (parse: ParsedResidentDocument | null | undefined) => {
    if (!parse) return;
    for (const field of parse.fields) {
      if (field.value.trim() && !out[field.key]) out[field.key] = field.value.trim();
    }
  };
  apply(application);
  apply(lease);
  return out;
}
