// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import * as sections from "@/lib/lease-html-sections";
import { LeaseHtmlDirectEditor } from "@/components/portal/lease-html-direct-editor";
const { captureException } = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock("posthog-js", () => ({ default: { captureException } }));
const LEASE =
  '<!doctype html><html><body><h1>Lease</h1><h2>Parties</h2><p>Example Resident</p><p data-disclosure-rule="required">Locked disclosure</p></body></html>';
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 800,
    height: 400,
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 800,
    bottom: 400,
    toJSON: () => ({}),
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("lease visual document lifecycle", () => {
  it("keeps its input listener after an external update and an unrelated parent render", async () => {
    const changed = vi.fn();
    const ready = vi.fn();
    const view = render(
      <LeaseHtmlDirectEditor
        html={LEASE}
        baselineHtml={LEASE}
        onChange={changed}
        onPreviewReady={ready}
      />,
    );
    await waitFor(() => expect(ready).toHaveBeenCalledWith(LEASE));
    const next = LEASE.replace("Example Resident", "Updated Resident");
    view.rerender(
      <LeaseHtmlDirectEditor
        html={next}
        baselineHtml={LEASE}
        onChange={(value) => changed(value)}
        onPreviewReady={ready}
      />,
    );
    await waitFor(() => expect(ready).toHaveBeenCalledWith(next));
    view.rerender(
      <LeaseHtmlDirectEditor
        html={next}
        baselineHtml={LEASE}
        onChange={(value) => changed(value)}
        onPreviewReady={ready}
      />,
    );
    const doc = view.container.querySelector("iframe")!.contentDocument!;
    doc.querySelector("p")!.textContent = "Edited after external update";
    fireEvent.input(doc.body);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed.mock.calls[0][0]).toContain("Edited after external update");
    expect(
      doc
        .querySelector("[data-disclosure-rule]")!
        .getAttribute("contenteditable"),
    ).toBe("false");
  });
  it("reloads the latest HTML on every Visual remount", async () => {
    const ready = vi.fn();
    const view = render(
      <LeaseHtmlDirectEditor
        html={LEASE}
        baselineHtml={LEASE}
        onChange={() => {}}
        onPreviewReady={ready}
      />,
    );
    await waitFor(() => expect(ready).toHaveBeenLastCalledWith(LEASE));
    fireEvent.click(view.getByRole("button", { name: "HTML", exact: true }));
    expect(ready).toHaveBeenLastCalledWith(null);
    const next = LEASE.replace("Example Resident", "HTML change");
    view.rerender(
      <LeaseHtmlDirectEditor
        html={next}
        baselineHtml={LEASE}
        onChange={() => {}}
        onPreviewReady={ready}
      />,
    );
    fireEvent.click(view.getByRole("button", { name: "Visual", exact: true }));
    await waitFor(() => expect(ready).toHaveBeenLastCalledWith(next));
    expect(
      view.container.querySelector("iframe")!.contentDocument!.body.textContent,
    ).toContain("HTML change");
  });
  it("retries a failed document without regenerating or dropping the supplied HTML", async () => {
    vi.spyOn(sections, "injectLeaseVisualEditDocument").mockImplementationOnce(
      () => {
        throw new Error("private document content");
      },
    );
    const ready = vi.fn();
    const change = vi.fn();
    const view = render(
      <LeaseHtmlDirectEditor
        html={LEASE}
        baselineHtml={LEASE}
        onChange={change}
        onPreviewReady={ready}
      />,
    );
    expect(view.getByRole("alert").textContent).toContain("couldn’t display");
    expect(ready).toHaveBeenLastCalledWith(null);
    expect(captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Lease visual preview failed" }),
      { reason: "document_unavailable" },
    );
    fireEvent.click(view.getByRole("button", { name: "Retry preview" }));
    await waitFor(() => expect(ready).toHaveBeenLastCalledWith(LEASE));
    expect(change).not.toHaveBeenCalled();
    expect(
      view.container.querySelector("iframe")!.contentDocument!.body.textContent,
    ).toContain("Example Resident");
  });
  it("does not execute supplied scripts or forward another frame’s section-focus messages", async () => {
    const focus = vi.fn();
    const ready = vi.fn();
    const source = LEASE.replace(
      "</body>",
      "<script>window.privatePayload=1</script></body>",
    );
    const view = render(
      <LeaseHtmlDirectEditor
        html={source}
        baselineHtml={source}
        onChange={() => {}}
        onSectionFocus={focus}
        onPreviewReady={ready}
      />,
    );
    await waitFor(() => expect(ready).toHaveBeenLastCalledWith(source));
    expect(
      view.container.querySelector("iframe")!.contentDocument!.documentElement
        .outerHTML,
    ).not.toContain("privatePayload");
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "lease-visual-section-focus", sectionId: "fake" },
        source: window,
      }),
    );
    expect(focus).not.toHaveBeenCalled();
  });
});
