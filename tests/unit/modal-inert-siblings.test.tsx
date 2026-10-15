// @vitest-environment jsdom
//
// M007 — real DOM `inert` (not just Radix's own aria-hidden) on everything
// outside an open Modal, restored exactly on close. See
// src/components/ui/motion/inert-boundary.ts for the ref-counted contract
// (a nested modal must not un-inert the page until the LAST one closes).
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { Modal } from "@/components/ui/modal";

afterEach(cleanup);

/** A page-content node living as its own top-level sibling of body, the way
 * the real app's root layout content sits beside wherever Radix portals a
 * dialog — this is exactly what `useInertOutsideModal` must inert. */
function attachPageContent() {
  const el = document.createElement("div");
  el.setAttribute("data-testid", "page-content");
  document.body.appendChild(el);
  return el;
}

describe("Modal — inert on siblings (M007)", () => {
  it("marks the underlying page content inert while open, and clears it on close", async () => {
    const pageContent = attachPageContent();
    expect(pageContent.hasAttribute("inert")).toBe(false);

    const { rerender } = render(
      <Modal open title="Confirm" onClose={() => {}}>
        Body
      </Modal>,
    );

    expect(pageContent.hasAttribute("inert")).toBe(true);

    rerender(
      <Modal open={false} title="Confirm" onClose={() => {}}>
        Body
      </Modal>,
    );

    expect(pageContent.hasAttribute("inert")).toBe(false);
    document.body.removeChild(pageContent);
  });

  it("never removes an inert attribute the page already had for its own reasons", async () => {
    const pageContent = attachPageContent();
    pageContent.setAttribute("inert", "");

    const { rerender } = render(
      <Modal open title="Confirm" onClose={() => {}}>
        Body
      </Modal>,
    );
    expect(pageContent.hasAttribute("inert")).toBe(true);

    rerender(
      <Modal open={false} title="Confirm" onClose={() => {}}>
        Body
      </Modal>,
    );
    // Still inert — that was the page's own state, never ours to clear.
    expect(pageContent.hasAttribute("inert")).toBe(true);
    document.body.removeChild(pageContent);
  });

  it("never seals a menu that opened after the modal, even when the content ref is re-attached", async () => {
    const { rerender } = render(
      <Modal open title="Confirm" onClose={() => {}} contentRef={() => {}}>
        Body
      </Modal>,
    );
    // A menu portaled to <body> after the modal opened sits above it.
    const menuHost = document.createElement("div");
    menuHost.innerHTML = '<div data-radix-popper-content-wrapper=""><div role="menu"></div></div>';
    document.body.appendChild(menuHost);
    // A new `contentRef` function detaches and re-attaches the content node: release, then acquire again.
    rerender(
      <Modal open title="Confirm" onClose={() => {}} contentRef={() => {}}>
        Body
      </Modal>,
    );
    expect(menuHost.hasAttribute("inert")).toBe(false);
    document.body.removeChild(menuHost);
  });

  it("still seals a page that merely holds an inline listbox deep inside it", () => {
    const pageContent = attachPageContent();
    // An inline (never portaled) combobox list, the shape listing-address-autocomplete renders.
    pageContent.innerHTML = '<main><form><div><ul role="listbox"><li>5257 Brooklyn Ave</li></ul></div></form></main>';

    render(
      <Modal open title="Confirm" onClose={() => {}}>
        Body
      </Modal>,
    );
    expect(pageContent.hasAttribute("inert")).toBe(true);
    document.body.removeChild(pageContent);
  });
});
