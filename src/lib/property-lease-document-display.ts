import { LEASE_AI_REVIEW_DISCLAIMER } from "@/lib/lease-templates/types";
import { sanitizeLeaseDocumentHtml } from "@/lib/lease-document-sanitizer";

/** Disclosure review blocks belong outside the lease body in the property editor. */
export function stripDisclosureReviewFromLeaseHtml(html: string): string {
  return html.replace(/<aside class="disclosure-review"[\s\S]*?<\/aside>\s*/gi, "").trim();
}

export function extractDisclosureReviewFromLeaseHtml(html: string): string | null {
  const match = html.match(/<aside class="disclosure-review"[^>]*>([\s\S]*?)<\/aside>/i);
  if (!match?.[1]?.trim()) return null;
  // Overrides may come from stored/uploaded lease HTML. This fragment is
  // rendered outside the sandboxed document iframe in the portal itself.
  return sanitizeLeaseDocumentHtml(match[1].trim());
}

const PLACEHOLDER_RE = /\[(?:Resident|Placement|LANDLORD)[^\]]*\]/i;

export type PropertyLeaseDocumentReview = {
  issues: string[];
  disclosureHtml: string | null;
};

export function reviewPropertyLeaseDocument(html: string): PropertyLeaseDocumentReview {
  const issues: string[] = [];
  const disclosureHtml = extractDisclosureReviewFromLeaseHtml(html);
  if (disclosureHtml) {
    issues.push("Disclosure review items should be resolved before saving — ask PropLane Assistant for help.");
  }
  if (PLACEHOLDER_RE.test(html)) {
    issues.push("Placeholder text is still in the lease — ask PropLane Assistant to replace bracketed fields.");
  }
  return { issues, disclosureHtml };
}

export { LEASE_AI_REVIEW_DISCLAIMER };
