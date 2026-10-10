// @vitest-environment jsdom
//
// Resident profile → Application tab mirrors the lease scroll fix: the preview must stay
// reachable inside a bounded flex frame without loosening the iframe sandbox.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

// The preview is exercised signed-in, not in the demo sandbox. jsdom serves the
// page at "/", which `isDemoModeActive()` treats as the landing-page demo embed,
// so without this mock the pdf variant kicks off an unawaited `pdf-lib` import
// that lands after the environment is torn down.
vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
}));

// The flow variant mounts the rasterizing preview, which lazily imports pdf.js.
// Only the shell is under test here, so stub it rather than start an import the
// test never awaits.
vi.mock("@/components/portal/uploaded-lease-pdf-preview", () => ({
  UploadedLeasePdfPreview: () => <div data-testid="uploaded-lease-pdf-preview" />,
}));

import { ApplicationDocumentPreview } from "@/components/portal/pro-applications";

afterEach(cleanup);

const row = {
  id: "app-1",
  name: "Alex Resident",
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

  it("uses page-flow pdf preview when flow is set", () => {
    const { container } = render(
      <ApplicationDocumentPreview
        row={row}
        collapsible={false}
        variant="pdf"
        flow
        bareCanvas
        showDownload={false}
      />,
    );
    const shell = container.querySelector('[data-testid="application-pdf-preview"]');
    expect(shell).not.toBeNull();
    expect(shell!.className).not.toContain("flex-1");
    expect(container.querySelector('[data-testid="uploaded-lease-pdf-preview"]')).not.toBeNull();
    expect(container.querySelector("iframe")).toBeNull();
  });
});
