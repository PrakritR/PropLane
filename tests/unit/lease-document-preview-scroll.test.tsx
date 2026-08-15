// @vitest-environment jsdom
//
// Reported: "I am unable to scroll through the lease" — manager → resident detail → Lease.
//
// The `flow` preview renders the document in an iframe that is supposed to grow to its content
// height so the PAGE scrolls and there is no nested scroll region. It measures that height from
// `iframe.contentDocument` — which is ALWAYS null here, because `sandbox=""` applies every
// restriction including `allow-same-origin`, putting the frame in an opaque origin.
//
// So the frame kept its initial height, `scrolling="no"` stopped it scrolling, and the wrapper's
// `overflow-hidden` clipped the rest. Anything past the first screen of the lease was
// unreachable rather than merely off-screen.
//
// The fix must keep `sandbox=""` — lease HTML carries manager-authored edits and content derived
// from third-party uploads, and `allow-same-origin` on a srcDoc frame would hand that content
// this origin.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

vi.mock("@/lib/lease-pipeline-storage", () => ({
  getLeaseDocumentHtml: () => "<html><body><p>Lease body</p></body></html>",
}));

import { LeaseDocumentPreview } from "@/components/portal/lease-document-preview";

afterEach(cleanup);

const row = { id: "lease-1", application: {} } as never;

describe("lease document preview — flow mode", () => {
  it("keeps the document reachable when the height cannot be measured", () => {
    const { container } = render(<LeaseDocumentPreview row={row} flow />);
    const frame = container.querySelector("iframe");
    expect(frame).not.toBeNull();

    // jsdom gives no layout, so `contentDocument` measurement never yields a height here — the
    // same state the real sandboxed frame is permanently in. The frame must therefore scroll
    // itself rather than sit at a fixed height with its overflow clipped away.
    expect(frame!.getAttribute("scrolling")).toBe("auto");
    // A bounded height, not a hardcoded short one that silently truncates a long lease.
    expect(frame!.className).toContain("h-[min(78vh,900px)]");
  });

  it("never loosens the sandbox to measure the document", () => {
    const { container } = render(<LeaseDocumentPreview row={row} flow />);
    const sandbox = container.querySelector("iframe")!.getAttribute("sandbox");
    // `allow-same-origin` on a srcDoc frame gives the lease content this origin. It is exactly
    // what would make the height readable, and exactly why it must not be added.
    expect(sandbox).toBe("");
    expect(sandbox).not.toContain("allow-same-origin");
    expect(sandbox).not.toContain("allow-scripts");
  });
});
