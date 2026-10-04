// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { PropertyLeaseClausePaperEditor } from "@/components/portal/property-lease-clause-paper-editor";
import {
  leaseHtmlForScopedDomDisplay,
  scopeLeaseDocumentStyles,
  stripLeaseDocumentShell,
} from "@/lib/lease-html-sections";
import { leaseCss } from "@/lib/lease-templates/types";

// The lease document's own stylesheet is a print-page stylesheet (serif body, uppercase +
// underlined headings). It must only ever style the document, never the portal around it.
const LEASE_HTML = `<!doctype html><html><head><title>Lease</title><style>${leaseCss()}</style></head><body>
<h1>RESIDENTIAL ROOM LEASE AGREEMENT</h1><p>Header</p>
<h2>1. Rent</h2><p>Pay on time.</p>
<h2>2. Rules</h2><p>Be quiet.</p>
</body></html>`;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Every selector of every rule in `css`, including those nested in @media. */
function selectorsOf(css: string): string[] {
  const out: string[] = [];
  for (const m of css.matchAll(/([^{}]+)\{/g)) {
    const prelude = m[1]!.trim();
    if (prelude.startsWith("@")) continue;
    out.push(...prelude.split(",").map((s) => s.trim()));
  }
  return out;
}

describe("lease document style containment", () => {
  it("scopes every selector (including nested @media) under the wrapper", () => {
    const scoped = scopeLeaseDocumentStyles(leaseCss(), ".doc");
    const selectors = selectorsOf(scoped);
    expect(selectors.length).toBeGreaterThan(10);
    for (const selector of selectors) expect(selector === ".doc" || selector.startsWith(".doc ")).toBe(true);
    expect(scoped).toContain("@media print");
  });

  it("dropRootLayout keeps the document typography but not the page layout", () => {
    const scoped = scopeLeaseDocumentStyles("body{font-family:serif;max-width:820px;margin:0 auto;padding:32px}", ".doc", {
      dropRootLayout: true,
    });
    expect(scoped).toContain("font-family:serif");
    expect(scoped).not.toMatch(/max-width|margin|padding/);
  });

  it("strips the document shell so no <style> reaches the portal DOM", () => {
    const stripped = stripLeaseDocumentShell(`${LEASE_HTML}<script>alert(1)</script>`);
    expect(stripped).not.toMatch(/<style|<script|<head|<html|<body|<title|<!doctype/i);
    expect(stripped).toContain("RESIDENTIAL ROOM LEASE AGREEMENT");
  });

  it("strips a shell rebuilt by its own removal, however deeply it is nested", () => {
    // Removing `<script>…</script>` joins the text on either side back into a new `<script`, so the
    // strip has to run to a fixpoint - a capped pass count leaves the deepest nesting behind.
    let nested = "<script>alert(1)</script>";
    for (let i = 0; i < 25; i++) nested = `<scr${nested}ipt>`;
    expect(stripLeaseDocumentShell(nested)).not.toMatch(/<script|<style|<head/i);
  });

  it("strips a shell rebuilt by a different removal", () => {
    // Dropping `<html>` / `<!doctype>` splices the text around it together, which can hand back a
    // tag no earlier pass ever saw: `<scr<html>ipt>` only becomes `<script>` after the html removal.
    expect(stripLeaseDocumentShell("<scr<html>ipt>alert(1)</scr<!doctype html>ipt>")).not.toMatch(
      /<script|<style|<head|<html|<!doctype/i,
    );
  });

  it("leaseHtmlForScopedDomDisplay re-emits only scoped styles", () => {
    const display = leaseHtmlForScopedDomDisplay(LEASE_HTML, ".resident-lease-doc");
    const styles = [...display.matchAll(/<style>([\s\S]*?)<\/style>/g)];
    expect(styles.length).toBe(1);
    for (const selector of selectorsOf(styles[0]![1]!)) expect(selector.startsWith(".resident-lease-doc")).toBe(true);
    expect(display).toContain("RESIDENTIAL ROOM LEASE AGREEMENT");
  });

  it("the Leases-step clause editor injects no unscoped <style> and keeps chrome outside the document class", () => {
    const { container } = render(<PropertyLeaseClausePaperEditor html={LEASE_HTML} onChange={() => {}} />);
    // Nothing in the document may carry a <style> that is not scoped under the document class.
    const styles = [...container.querySelectorAll("style")];
    expect(styles.length).toBe(1);
    for (const selector of selectorsOf(styles[0]!.textContent ?? "")) {
      expect(selector.startsWith(".lease-clause-doc")).toBe(true);
    }
    const header = container.querySelector('[data-attr="lease-clause-header"]');
    expect(header?.classList.contains("lease-clause-doc")).toBe(true);
    expect(header?.textContent).toContain("RESIDENTIAL ROOM LEASE AGREEMENT");
    const paper = container.querySelector('[data-attr="property-lease-clause-paper-editor"]')!;
    expect(paper.classList.contains("lease-clause-doc")).toBe(false);
    expect(container.querySelector('[data-attr="lease-clause-bold"]')?.closest(".lease-clause-doc")).toBeNull();
  });
});
