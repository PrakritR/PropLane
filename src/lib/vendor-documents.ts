/** Vendor-uploaded compliance files stored on `manager_vendor_records.row_data`. */
export type VendorDocumentKind =
  | "w9"
  | "income_tax_return"
  | "form_1099"
  | "ein_letter"
  | "sales_tax_permit"
  | "insurance"
  | "workers_comp"
  | "license"
  | "bond";

export type VendorDocumentRecord = {
  kind: VendorDocumentKind;
  fileName: string;
  /** Authenticated download route — never a public storage URL. */
  url: string;
  storagePath?: string;
  uploadedAt: string;
  /** ISO date the document lapses (insurance, license, bond). Drives `vendor_document_expiry` reminders. */
  expiresAt?: string;
};

export const VENDOR_DOCUMENT_KINDS: VendorDocumentKind[] = [
  "w9",
  "income_tax_return",
  "form_1099",
  "ein_letter",
  "sales_tax_permit",
  "insurance",
  "workers_comp",
  "license",
  "bond",
];

export const VENDOR_DOCUMENT_LABELS: Record<VendorDocumentKind, string> = {
  w9: "Signed W-9",
  income_tax_return: "Income tax return",
  form_1099: "1099 form (prior year)",
  ein_letter: "EIN confirmation letter",
  sales_tax_permit: "Sales tax permit",
  insurance: "Certificate of insurance",
  workers_comp: "Workers' compensation certificate",
  license: "Business / contractor license",
  bond: "Surety bond",
};

export const VENDOR_DOCUMENT_HINTS: Record<VendorDocumentKind, string> = {
  w9: "Signed IRS Form W-9 — required for 1099 reporting. You can also complete the attestation under Payments.",
  income_tax_return:
    "Most recent federal return (Form 1040 or business return). Managers may request this for vendor onboarding.",
  form_1099: "Copy of a 1099-NEC or 1099-MISC you received last year, if your manager asks for income history.",
  ein_letter: "IRS EIN assignment letter (CP 575) or SS-4 confirmation for your business entity.",
  sales_tax_permit: "State or local resale / sales tax certificate, if you collect sales tax on materials or services.",
  insurance:
    "Current general liability certificate — managers often require this before assigning work.",
  workers_comp: "Workers' comp policy or exemption certificate, if required for your trade and state.",
  license: "Active state, city, or trade license (HVAC, electrical, plumbing, etc.).",
  bond: "Contractor or performance bond, if your license or the manager requires it.",
};

/** Grouped checklist shown on the vendor Documents tab. */
export const VENDOR_DOCUMENT_SECTIONS: {
  id: string;
  label: string;
  kinds: VendorDocumentKind[];
}[] = [
  {
    id: "tax",
    label: "Tax & income",
    kinds: ["w9", "income_tax_return", "form_1099", "ein_letter", "sales_tax_permit"],
  },
  {
    id: "insurance",
    label: "Insurance",
    kinds: ["insurance", "workers_comp"],
  },
  {
    id: "licensing",
    label: "Business & licensing",
    kinds: ["license", "bond"],
  },
];

export const VENDOR_DOCUMENT_TABS = VENDOR_DOCUMENT_SECTIONS.map((section) => ({
  id: section.id,
  label: section.label,
}));

export function vendorDocumentSectionForTab(tabId: string) {
  return VENDOR_DOCUMENT_SECTIONS.find((section) => section.id === tabId);
}

export function vendorDocumentStatusLabel(doc: VendorDocumentRecord | undefined): string {
  return doc ? "On file" : "Missing";
}

export function vendorDocumentStatusTone(doc: VendorDocumentRecord | undefined): string {
  if (doc) {
    return "portal-badge-success ring-1 ring-[color-mix(in_srgb,currentColor_25%,transparent)]";
  }
  return "portal-badge-pending ring-1 ring-[color-mix(in_srgb,currentColor_25%,transparent)]";
}

/**
 * The subset of document kinds that gate a vendor's "Verified" standing
 * elsewhere in the product (the manager directory's Insured/Licensed facts,
 * `vendor-directory.server.ts`) or block 1099 reporting. Missing one of
 * these reads as a compliance gap, not ordinary paperwork — it gets the row's
 * `attention` dot + a red `statusWord` plus an always-visible Upload action,
 * never a pill (C262).
 */
export const VENDOR_COMPLIANCE_DOCUMENT_KINDS: VendorDocumentKind[] = ["w9", "insurance", "license"];

export function isVendorComplianceDocumentKind(kind: VendorDocumentKind): boolean {
  return (VENDOR_COMPLIANCE_DOCUMENT_KINDS as readonly string[]).includes(kind);
}

export function isVendorDocumentKind(value: string): value is VendorDocumentKind {
  return (VENDOR_DOCUMENT_KINDS as readonly string[]).includes(value);
}

export function upsertVendorDocument(
  existing: VendorDocumentRecord[] | undefined,
  next: VendorDocumentRecord,
): VendorDocumentRecord[] {
  const list = [...(existing ?? [])];
  const idx = list.findIndex((d) => d.kind === next.kind);
  if (idx >= 0) list[idx] = next;
  else list.push(next);
  return list;
}

export function removeVendorDocument(
  existing: VendorDocumentRecord[] | undefined,
  kind: VendorDocumentKind,
): VendorDocumentRecord[] {
  return (existing ?? []).filter((d) => d.kind !== kind);
}

export function findVendorDocument(
  existing: VendorDocumentRecord[] | undefined,
  kind: VendorDocumentKind,
): VendorDocumentRecord | undefined {
  return (existing ?? []).find((d) => d.kind === kind);
}

/**
 * Read a picked File as a data URL for `/api/vendor/documents/upload`, which
 * only ever parses a JSON body with a `dataUrl` string — never multipart
 * `FormData` (that mismatch is what made "Replace" silently fail: the route
 * throws parsing the body as JSON, which the route's own catch turns into a
 * generic "Upload failed."). Both the Documents panel's inline Replace and
 * the upload wizard share this so the request shape can never drift apart
 * again.
 */
export function readVendorDocumentDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("Could not read file."));
    reader.readAsDataURL(file);
  });
}
