import { describe, expect, it } from "vitest";
import {
  scopeLeaseDocumentHtmlForInlinePreview,
  scopeLeaseDocumentPreviewCss,
  stripDisclosureReviewFromLeaseHtml,
} from "@/lib/property-lease-document-display";

// F013: `leaseCss()` (and the smaller per-document-mode stylesheets) is a
// print-document stylesheet meant to own its whole page — `body { font-family:
// ui-serif, ... }`, `h2`/`h3` uppercase + underlined. The property lease
// editor renders the full generated document HTML inline (never in an
// iframe, so its own DOM stays queryable in tests), so an unscoped `<style>`
// tag leaks that serif/underline look onto the entire editor chrome — every
// Tailwind utility loses to it regardless of specificity, because Tailwind's
// utilities live inside `@layer` and any unlayered rule always wins. Scoping
// every selector under the preview container is what stops the leak.
describe("F013: scopeLeaseDocumentPreviewCss", () => {
  const SCOPE = "lease-document-preview-scope";

  it("scopes body/html/* to the container itself, not a nonexistent descendant", () => {
    const scoped = scopeLeaseDocumentPreviewCss(
      `* { box-sizing: border-box; } body { font-family: ui-serif, Georgia, serif; }`,
      SCOPE,
    ).replace(/\s+/g, "");
    expect(scoped).toContain(`.${SCOPE}{box-sizing:border-box;}`);
    expect(scoped).toContain(`.${SCOPE}{font-family:ui-serif,Georgia,serif;}`);
    // Never a bare, unscoped `body` or `*` selector left behind.
    expect(scoped).not.toMatch(/(^|\})body\{/);
    expect(scoped).not.toMatch(/(^|\})\*\{/);
  });

  it("scopes ordinary element/class selectors as descendants", () => {
    const scoped = scopeLeaseDocumentPreviewCss(
      `h2 { text-transform: uppercase; border-bottom: 2px solid #111; } h3 { text-decoration: underline; } .note { color: #555; }`,
      SCOPE,
    ).replace(/\s+/g, "");
    expect(scoped).toContain(`.${SCOPE}h2{text-transform:uppercase;border-bottom:2pxsolid#111;}`);
    expect(scoped).toContain(`.${SCOPE}h3{text-decoration:underline;}`);
    expect(scoped).toContain(`.${SCOPE}.note{color:#555;}`);
    // No bare top-level h2/h3 rule survives — that bare rule is exactly what
    // leaks onto the editor's own `StepHeading`/`PanelSection` headings.
    expect(scoped).not.toMatch(/(^|\})h2\{/);
    expect(scoped).not.toMatch(/(^|\})h3\{/);
  });

  it("recurses into an @media block without corrupting the at-rule", () => {
    const scoped = scopeLeaseDocumentPreviewCss(
      `h1 { font-size: 1.4rem; } @media print { body { padding: 12px; font-size: 10pt; } }`,
      SCOPE,
    ).replace(/\s+/g, "");
    expect(scoped).toContain(`.${SCOPE}h1{font-size:1.4rem;}`);
    expect(scoped).toContain("@mediaprint{");
    expect(scoped).toContain(`.${SCOPE}{padding:12px;font-size:10pt;}`);
  });

  it("scopes every <style> block in a full HTML document string", () => {
    const html = `<!DOCTYPE html><html><head><style>body{font-family:Georgia,serif;} h2{text-transform:uppercase;border-bottom:2px solid #111;}</style></head><body><h2>Rent</h2><p>$1,300/mo</p></body></html>`;
    const out = scopeLeaseDocumentHtmlForInlinePreview(html, SCOPE);
    const flattened = out.replace(/\s+/g, "");
    expect(flattened).toContain(`.${SCOPE}{font-family:Georgia,serif;}`);
    expect(flattened).toContain(`.${SCOPE}h2{text-transform:uppercase;border-bottom:2pxsolid#111;}`);
    // The actual document text is untouched — only the <style> block changes.
    expect(out).toContain("<h2>Rent</h2>");
    expect(out).toContain("<p>$1,300/mo</p>");
  });
});

describe("stripDisclosureReviewFromLeaseHtml (existing behavior, unchanged)", () => {
  it("still removes a disclosure-review aside", () => {
    const html = `<p>Before</p><aside class="disclosure-review"><p>Review this</p></aside><p>After</p>`;
    expect(stripDisclosureReviewFromLeaseHtml(html)).toBe("<p>Before</p><p>After</p>");
  });
});
