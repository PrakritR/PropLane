// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  DocsScrollspyNav,
  docsActiveIdFromHash,
  resolveDocsActiveSection,
} from "@/components/docs/docs-scrollspy-nav";

const sectionIds = ["getting-started", "workflows", "security"] as const;

describe("docs scrollspy section resolution", () => {
  it("moves downward to the last section above the reading marker", () => {
    expect(
      resolveDocsActiveSection({
        sections: [
          { id: "getting-started", top: -260 },
          { id: "workflows", top: 80 },
          { id: "security", top: 640 },
        ],
        viewportHeight: 600,
        documentHeight: 2400,
        scrollY: 600,
      }),
    ).toBe("workflows");
  });

  it("moves upward when an earlier section crosses the reading marker", () => {
    expect(
      resolveDocsActiveSection({
        sections: [
          { id: "getting-started", top: -40 },
          { id: "workflows", top: 260 },
          { id: "security", top: 780 },
        ],
        viewportHeight: 600,
        documentHeight: 2400,
        scrollY: 260,
      }),
    ).toBe("getting-started");
  });

  it("selects the final section at the bottom of a document", () => {
    expect(
      resolveDocsActiveSection({
        sections: [
          { id: "getting-started", top: -800 },
          { id: "workflows", top: -180 },
          { id: "security", top: 310 },
        ],
        viewportHeight: 600,
        documentHeight: 1801,
        scrollY: 1200,
      }),
    ).toBe("security");
  });
});

describe("docs hash selection", () => {
  it("accepts a valid section hash for direct links", () => {
    expect(docsActiveIdFromHash("#workflows", sectionIds)).toBe("workflows");
  });

  it("falls back for an invalid or malformed hash", () => {
    expect(docsActiveIdFromHash("#not-a-doc-section", sectionIds)).toBeUndefined();
    expect(docsActiveIdFromHash("#%", sectionIds)).toBeUndefined();
    expect(docsActiveIdFromHash("not-a-hash", sectionIds)).toBeUndefined();
  });
});

describe("DocsScrollspyNav", () => {
  afterEach(() => {
    cleanup();
    window.history.replaceState(null, "", "/");
  });

  it("uses a valid hash on load and selects a link immediately when clicked", () => {
    window.history.replaceState(null, "", "#workflows");
    render(
      <DocsScrollspyNav groups={[{
        group: "Guide",
        links: sectionIds.map((id) => ({ id, label: id })),
      }]} dataAttrPrefix="product-docs-scrollspy" />,
    );

    const workflows = screen.getByRole("link", { name: "workflows" });
    expect(workflows).toHaveAttribute("aria-current", "location");
    expect(workflows).toHaveAttribute("data-attr", "product-docs-scrollspy-workflows");
    expect(workflows).toHaveAttribute("href", "#workflows");
    expect(document.querySelectorAll('[aria-current="location"]')).toHaveLength(1);

    fireEvent.click(screen.getByRole("link", { name: "security" }));
    expect(screen.getByRole("link", { name: "security" })).toHaveAttribute("aria-current", "location");
    expect(workflows).not.toHaveAttribute("aria-current");
    expect(document.querySelectorAll('[aria-current="location"]')).toHaveLength(1);
  });

  it("keeps the desktop index scrollable on short viewports", () => {
    render(
      <DocsScrollspyNav groups={[{
        group: "Guide",
        links: sectionIds.map((id) => ({ id, label: id })),
      }]} />,
    );

    const nav = screen.getByRole("navigation", { name: "Docs sections" });
    expect(nav.className).toContain("lg:max-h-[calc(100dvh-7rem)]");
    expect(nav.className).toContain("lg:overflow-y-auto");
    expect(nav.className).toContain("lg:px-1");
    expect(nav.className).toContain("lg:pb-1");
  });

  it("falls back to the first link when the initial hash is not a docs section", () => {
    window.history.replaceState(null, "", "#unknown-section");
    render(
      <DocsScrollspyNav groups={[{
        group: "Guide",
        links: sectionIds.map((id) => ({ id, label: id })),
      }]} />,
    );

    expect(screen.getByRole("link", { name: "getting-started" })).toHaveAttribute("aria-current", "location");
  });

  it("keeps native anchor behavior and a visible keyboard focus treatment", async () => {
    const user = userEvent.setup();
    render(
      <DocsScrollspyNav groups={[{
        group: "Guide",
        links: sectionIds.map((id) => ({ id, label: id })),
      }]} />,
    );

    const firstLink = screen.getByRole("link", { name: "getting-started" });
    await user.tab();

    expect(firstLink).toHaveFocus();
    expect(firstLink).toHaveAttribute("href", "#getting-started");
    expect(firstLink.className).toContain("focus-visible:ring-2");
    expect(firstLink.className).toContain("focus-visible:ring-primary");
  });
});
