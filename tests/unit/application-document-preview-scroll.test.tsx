// @vitest-environment jsdom
//
// Resident profile → Application tab mirrors the lease scroll fix: the preview must stay
// reachable inside a bounded flex frame without loosening the iframe sandbox.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

vi.mock("@/lib/demo-mode", () => ({
  isDemoModeActive: () => false,
}));

import { ApplicationDocumentPreview } from "@/components/portal/manager-applications";

afterEach(cleanup);

const row = {
  id: "app-1",
  bucket: "approved",
  application: { firstName: "Alex", lastName: "Resident", consentCredit: true },
} as never;

describe("application document preview — stretch mode", () => {
  it("scrolls inside the frame when stretch is set (html variant)", () => {
    const { container } = render(
      <ApplicationDocumentPreview
        row={row}
        collapsible={false}
        variant="html"
        stretch
        bareCanvas
        showDownload={false}
      />,
    );
    const frame = container.querySelector("iframe");
    expect(frame).not.toBeNull();
    expect(frame!.getAttribute("scrolling")).toBe("yes");
    expect(frame!.className).toContain("absolute");
    expect(frame!.getAttribute("sandbox")).toBe("");
  });

  it("uses a bounded flex shell for pdf stretch", () => {
    const { container } = render(
      <ApplicationDocumentPreview
        row={row}
        collapsible={false}
        variant="pdf"
        stretch
        bareCanvas
        showDownload={false}
      />,
    );
    const shell = container.querySelector('[data-testid="application-pdf-preview"]');
    expect(shell).not.toBeNull();
    expect(shell!.className).toContain("flex-1");
    expect(shell!.className).toContain("overflow-hidden");
  });
});
