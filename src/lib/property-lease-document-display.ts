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

/**
 * F013: `leaseCss()` (`lib/lease-templates/types.ts`) is a print-document
 * stylesheet — `body { font-family: ui-serif, ... }`, `h2`/`h3` uppercase and
 * underline — meant for a document that owns its whole page (an iframe, an
 * exported PDF, an email). The property lease editor's read-only side
 * preview instead renders the full generated document HTML with
 * `dangerouslySetInnerHTML` directly into the page's own DOM (never an
 * iframe, since the same tests that assert its rendered text also assert
 * live edits stage/apply/discard through ordinary DOM queries). A `<style>`
 * tag applies globally regardless of where in the DOM it sits, and Tailwind
 * emits its own utilities inside `@layer`, so an UNLAYERED rule this simple
 * (`body`, `h2`, `h3`, bare element selectors) beats every Tailwind utility
 * class on the page regardless of specificity or source order — that is how
 * the "New lease" title, the lease-name field, and every Setup section
 * header end up serif and underlined outside the preview.
 *
 * Scope every selector in every `<style>` block under `scopeClassName`
 * before injecting, so the same lease-document look renders only inside its
 * own preview container and can never leak onto the surrounding chrome.
 * Only the small, hand-written, non-nested stylesheets this app generates
 * are ever run through this — no untrusted CSS, and at most one level of
 * `@media` nesting (`leaseCss()`'s `@media print` block).
 */
export function scopeLeaseDocumentPreviewCss(css: string, scopeClassName: string): string {
  let out = "";
  let i = 0;
  const n = css.length;
  while (i < n) {
    const braceIndex = css.indexOf("{", i);
    if (braceIndex === -1) {
      out += css.slice(i);
      break;
    }
    const selectorPart = css.slice(i, braceIndex);
    const trimmedSelector = selectorPart.trim();
    if (trimmedSelector.startsWith("@")) {
      // An at-rule block (`@media print { ... }`) — keep it, but recurse into
      // its body so any nested selector is scoped the same way.
      let depth = 1;
      let j = braceIndex + 1;
      while (j < n && depth > 0) {
        if (css[j] === "{") depth += 1;
        else if (css[j] === "}") depth -= 1;
        j += 1;
      }
      const inner = css.slice(braceIndex + 1, j - 1);
      out += `${selectorPart}{${scopeLeaseDocumentPreviewCss(inner, scopeClassName)}}`;
      i = j;
      continue;
    }
    const closeIndex = css.indexOf("}", braceIndex);
    if (closeIndex === -1) {
      out += css.slice(i);
      break;
    }
    const declarations = css.slice(braceIndex + 1, closeIndex);
    const scopedSelector = trimmedSelector
      .split(",")
      .map((piece) => {
        const part = piece.trim();
        if (!part) return part;
        // `body`/`html`/`*` used to mean "the whole printed page" — the
        // scope container now plays that role, since the browser drops the
        // fragment's own `<html>/<head>/<body>` wrapper tags on injection.
        if (part === "body" || part === "html" || part === "*") return `.${scopeClassName}`;
        return `.${scopeClassName} ${part}`;
      })
      .join(", ");
    out += `${scopedSelector}{${declarations}}`;
    i = closeIndex + 1;
  }
  return out;
}

/** Runs every `<style>` block in `html` through {@link scopeLeaseDocumentPreviewCss}. */
export function scopeLeaseDocumentHtmlForInlinePreview(html: string, scopeClassName: string): string {
  return html.replace(
    /<style([^>]*)>([\s\S]*?)<\/style>/gi,
    (_match, attrs: string, css: string) => `<style${attrs}>${scopeLeaseDocumentPreviewCss(css, scopeClassName)}</style>`,
  );
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
