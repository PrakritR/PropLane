// @vitest-environment jsdom
//
// F013: the property lease editor renders the full generated document HTML
// (leaseCss(): `body { font-family: ui-serif, ...serif }`, `h2`/`h3`
// uppercase + underlined) directly into the page's own DOM, never an
// iframe. An unscoped `<style>` tag applies globally regardless of where it
// sits in the DOM, and Tailwind's own utilities live inside `@layer` — so
// that unlayered rule beats every chrome utility class regardless of
// specificity, and the "New lease" title, the lease-name field, and every
// Setup section header end up serif and underlined too. This mocks the
// actual lease-document generator (out of scope here — see
// `docs/agents/lease-generation.md`) with a fixed HTML string carrying the
// exact same shape of leak, so the guard is deterministic and never depends
// on jurisdiction/pricing data resolving to a non-empty preview.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";

const LEAK_STYLE_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><title>Lease</title>
<style>
  body { font-family: ui-serif, Georgia, Cambria, "Times New Roman", Times, serif; color: #111; }
  h2 { font-size: 1rem; border-bottom: 2px solid #111; text-transform: uppercase; letter-spacing: .04em; }
  h3 { font-size: 0.95rem; text-decoration: underline; }
</style></head><body>
  <h2>Parties</h2>
  <p>Landlord and Resident.</p>
</body></html>`;

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/property-lease-edit", () => ({
  resolvePropertyLeaseEditHtml: () => LEAK_STYLE_HTML,
}));
if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};

function jumpRail(id: string) {
  const btn = document.querySelector(`[data-attr="listing-v2-rail-${id}"]`) as HTMLElement | null;
  expect(btn).not.toBeNull();
  fireEvent.click(btn!);
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }) as unknown as Response));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("F013: the lease editor chrome is never serif — only the document preview is", () => {
  it("puts the preview-document scope class only on the preview container, never on the dialog/title/headers", async () => {
    const { LEASE_PREVIEW_DOCUMENT_SCOPE, PropertyLeaseFormModal } = await import(
      "@/components/portal/property-lease-form-modal"
    );
    render(
      <PropertyLeaseFormModal
        open
        mode="add"
        sub={createDefaultListingSubmission()}
        templates={[]}
        propertyId="mgr-house-1"
        onClose={() => {}}
        onSave={async () => true}
        showToast={() => {}}
      />,
    );
    const dialog = await screen.findByRole("dialog", { name: "New lease" });

    // The mocked document actually rendered (with its own style scoped) …
    const scoped = document.querySelectorAll(`.${LEASE_PREVIEW_DOCUMENT_SCOPE}`);
    expect(scoped.length).toBeGreaterThan(0);
    // … the "Parties" heading from the mocked document is inside it (the
    // desktop and mobile layouts both mount the side panel in jsdom, since
    // the responsive classes that hide one are pure CSS) …
    for (const partiesNode of screen.getAllByText("Parties")) {
      expect(partiesNode.closest(`.${LEASE_PREVIEW_DOCUMENT_SCOPE}`)).not.toBeNull();
    }
    // … the injected <style> block only ever contains SCOPED selectors …
    const styleTags = document.querySelectorAll(`.${LEASE_PREVIEW_DOCUMENT_SCOPE} style`);
    expect(styleTags.length).toBeGreaterThan(0);
    styleTags.forEach((style) => {
      expect(style.textContent).not.toMatch(/(^|\})\s*(body|h2|h3)\s*\{/);
      expect(style.textContent).toContain(`.${LEASE_PREVIEW_DOCUMENT_SCOPE}`);
    });
    // … and the scope class never lands anywhere OUTSIDE the preview
    // container — never on the dialog root, the "New lease" title, or any
    // Setup/Sections chrome heading.
    scoped.forEach((el) => {
      expect(el.closest('[data-attr="property-lease-html-preview"]')).not.toBeNull();
    });
    expect(dialog.classList.contains(LEASE_PREVIEW_DOCUMENT_SCOPE)).toBe(false);
    for (const titleNode of screen.getAllByText("New lease")) {
      expect(titleNode.closest(`.${LEASE_PREVIEW_DOCUMENT_SCOPE}`)).toBeNull();
    }
    jumpRail("document");
    // The Settings step is gone (C2-CP8); the editor chrome that remains must never carry the scope.
    const railButtons = document.querySelectorAll('[data-attr^="listing-v2-rail-"]');
    expect(railButtons.length).toBe(2);
    railButtons.forEach((button) => {
      expect(button.closest(`.${LEASE_PREVIEW_DOCUMENT_SCOPE}`)).toBeNull();
    });
  });
});
