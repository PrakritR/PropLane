import { describe, expect, it } from "vitest";
import {
  reinsertMissingDisclosureParagraphs,
  sanitizeLeaseDocumentHtml,
  sanitizeManagerLeaseDocumentEdit,
} from "@/lib/lease-document-sanitizer";

describe("lease document HTML sanitizer", () => {
  it("stores only allowlisted document markup", () => {
    const html = sanitizeLeaseDocumentHtml(`
      <html><head><style>@import url(https://evil.test/style.css); p { color: red; background: url(https://evil.test/pixel); }</style></head>
      <body><p onclick="alert(1)">Safe wording</p><script>alert(1)</script><img src="https://evil.test/pixel" onerror="alert(2)"><a href="javascript:alert(3)">bad link</a></body></html>
    `);

    expect(html).toContain("Safe wording");
    expect(html).not.toMatch(/script|onclick|onerror|javascript:|https:\/\/evil\.test|<img|<a\b/i);
  });

  it("rejects escaped CSS external-load syntax while preserving safe generated CSS bytes", () => {
    const unsafe = sanitizeLeaseDocumentHtml('<html><head><style>p { background: u\\72l(https://evil.test/pixel); }</style></head><body><p>Text</p></body></html>');
    const unclosed = sanitizeLeaseDocumentHtml('<html><head><style>p { background: url(https://evil.test/pixel); }');
    const imageSet = sanitizeLeaseDocumentHtml('<html><head><style>p { background: image-set("https://evil.test/pixel" 1x); }</style></head><body><p>Text</p></body></html>');
    const safe = '<html><head><style>body { font-family: Georgia, "Times New Roman", serif; } @media print { body { padding: 12px; } }</style></head><body><p style="font-weight:700">Text</p></body></html>';

    expect(unsafe).not.toContain("evil.test");
    expect(unclosed).not.toContain("evil.test");
    expect(imageSet).not.toContain("evil.test");
    expect(sanitizeLeaseDocumentHtml(safe)).toBe(safe);
  });

  it("restores a P7 verbatim disclosure block before persisting a manager edit", () => {
    const original = `
      <html><body><p>Manager wording</p>
      <!-- proplane-verbatim-disclosure:start:lead-paint --><section><p>Required disclosure text.</p></section><!-- proplane-verbatim-disclosure:end:lead-paint -->
      </body></html>`;
    const edited = original.replace("Required disclosure text.", "Changed wording.");

    const result = sanitizeManagerLeaseDocumentEdit(original, edited);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.html).toContain("Required disclosure text.");
      expect(result.html).not.toContain("Changed wording.");
    }
  });

  it("rejects an edit that removes a marked required disclosure", () => {
    const original = "<!-- proplane-verbatim-disclosure:start:lead --><p>Required</p><!-- proplane-verbatim-disclosure:end:lead -->";

    expect(sanitizeManagerLeaseDocumentEdit(original, "<p>Manager replacement</p>")).toEqual({
      ok: false,
      error: "Required disclosure clauses cannot be removed. Edit the surrounding text only.",
    });
  });

  it("rejects an edit that changes the order of marked required disclosures", () => {
    const original = "<!-- proplane-verbatim-disclosure:start:one --><p>One</p><!-- proplane-verbatim-disclosure:end:one --><!-- proplane-verbatim-disclosure:start:two --><p>Two</p><!-- proplane-verbatim-disclosure:end:two -->";
    const reordered = "<!-- proplane-verbatim-disclosure:start:two --><p>Two</p><!-- proplane-verbatim-disclosure:end:two --><!-- proplane-verbatim-disclosure:start:one --><p>One</p><!-- proplane-verbatim-disclosure:end:one -->";

    expect(sanitizeManagerLeaseDocumentEdit(original, reordered)).toEqual({
      ok: false,
      error: "Required disclosure clauses must remain in place and unchanged.",
    });
  });

  it("reinserts disclosure paragraphs deleted by the visual editor before sanitizing", () => {
    const original =
      '<html><body><h2>Term</h2><p>Month-to-month.</p><p data-disclosure-rule="fed-lead-paint">Lead paint disclosure.</p></body></html>';
    const edited = '<html><body><h2>Term</h2><p>Month-to-month with edits.</p></body></html>';
    const merged = reinsertMissingDisclosureParagraphs(original, edited);
    const result = sanitizeManagerLeaseDocumentEdit(original, merged);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.html).toContain('data-disclosure-rule="fed-lead-paint"');
      expect(result.html).toContain("Lead paint disclosure.");
    }
  });
});
