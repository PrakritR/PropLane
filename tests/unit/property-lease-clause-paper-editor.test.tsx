// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PropertyLeaseClausePaperEditor } from "@/components/portal/property-lease-clause-paper-editor";

const SAMPLE_HTML = `<!doctype html><html><body>
<section id="lease-document-header"><h1>Lease agreement</h1><p>Header</p></section>
<section id="lease-clause-rent"><h2>1. Rent</h2><p>Pay on time.</p></section>
<section id="lease-clause-rules"><h2>2. Rules</h2><p>Be quiet.</p></section>
</body></html>`;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("PropertyLeaseClausePaperEditor (C2-LA4-5 / C2-L11-3)", () => {
  it("renders clause toolbar actions and + Add clause rows", () => {
    render(<PropertyLeaseClausePaperEditor html={SAMPLE_HTML} onChange={() => {}} detectedFieldCount={4} />);
    expect(document.querySelector('[data-attr="property-lease-clause-paper-editor"]')).not.toBeNull();
    expect(screen.getByText("4 PDF fields detected")).toBeTruthy();
    expect(document.querySelectorAll('[data-attr="lease-clause-add-after"]').length).toBe(2);
    expect(document.querySelectorAll('[data-attr="lease-clause-bold"]').length).toBeGreaterThan(0);
  });

  it("inserts a clause when + Add clause is clicked", () => {
    const onChange = vi.fn();
    render(<PropertyLeaseClausePaperEditor html={SAMPLE_HTML} onChange={onChange} />);
    const addButtons = document.querySelectorAll('[data-attr="lease-clause-add-after"]');
    fireEvent.click(addButtons[0]!);
    expect(onChange).toHaveBeenCalled();
    const nextHtml = onChange.mock.calls.at(-1)?.[0] as string;
    expect(nextHtml).toContain("New clause");
  });
});
