// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import * as sections from "@/lib/lease-html-sections";
import { LeaseHtmlDirectEditor } from "@/components/portal/lease-html-direct-editor";
const { captureException } = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock("posthog-js", () => ({ default: { captureException } }));
const LEASE =
  '<!doctype html><html><body><h1>Lease</h1><h2>Parties</h2><p>Example Resident</p><p data-disclosure-rule="required">Locked disclosure</p></body></html>';
const rect = (width: number, height: number) =>
  ({
    width,
    height,
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    toJSON: () => ({}),
  }) as DOMRect;
const renderingGlobals = globalThis as unknown as {
  requestAnimationFrame: typeof requestAnimationFrame;
  cancelAnimationFrame: typeof cancelAnimationFrame;
  ResizeObserver: typeof ResizeObserver | undefined;
};
const nativeRendering = {
  requestAnimationFrame: renderingGlobals.requestAnimationFrame,
  cancelAnimationFrame: renderingGlobals.cancelAnimationFrame,
  ResizeObserver: renderingGlobals.ResizeObserver,
};
/** Suspend the rendering-steps callbacks the way a hidden document does. */
const suspendRenderingCallbacks = () => {
  renderingGlobals.requestAnimationFrame = (() => 0) as typeof requestAnimationFrame;
  renderingGlobals.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame;
  renderingGlobals.ResizeObserver = undefined;
};
let rectSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
  rectSpy.mockReturnValue(rect(800, 400));
});
afterEach(() => {
  Object.assign(renderingGlobals, nativeRendering);
  delete (document as { visibilityState?: unknown }).visibilityState;
  vi.useRealTimers();
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
  it("renders updated document content without a view switch", async () => {
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
    expect(view.queryByRole("button", { name: "HTML", exact: true })).toBeNull();
    expect(view.queryByRole("button", { name: "Visual", exact: true })).toBeNull();
    const next = LEASE.replace("Example Resident", "HTML change");
    view.rerender(
      <LeaseHtmlDirectEditor
        html={next}
        baselineHtml={LEASE}
        onChange={() => {}}
        onPreviewReady={ready}
      />,
    );
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
  it("re-checks the document at the deadline instead of failing a preview whose rendering callbacks never fired", async () => {
    vi.useFakeTimers();
    suspendRenderingCallbacks();
    const ready = vi.fn();
    const view = render(
      <LeaseHtmlDirectEditor
        html={LEASE}
        baselineHtml={LEASE}
        onChange={() => {}}
        onPreviewReady={ready}
      />,
    );
    expect(ready).not.toHaveBeenCalledWith(LEASE);
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(ready).toHaveBeenLastCalledWith(LEASE);
    expect(captureException).not.toHaveBeenCalled();
    expect(view.queryByRole("alert")).toBeNull();
    vi.useRealTimers();
  });
  it("does not fail a preview while the document is hidden, and settles when it becomes visible", async () => {
    vi.useFakeTimers();
    suspendRenderingCallbacks();
    let visibility = "hidden";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility,
    });
    rectSpy.mockReturnValue(rect(0, 0));
    const ready = vi.fn();
    const view = render(
      <LeaseHtmlDirectEditor
        html={LEASE}
        baselineHtml={LEASE}
        onChange={() => {}}
        onPreviewReady={ready}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(captureException).not.toHaveBeenCalled();
    expect(view.queryByRole("alert")).toBeNull();
    expect(ready).not.toHaveBeenCalledWith(LEASE);
    rectSpy.mockReturnValue(rect(800, 400));
    visibility = "visible";
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(ready).toHaveBeenLastCalledWith(LEASE);
    expect(captureException).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
  it("keeps a cleared document editable and regains readiness once the manager retypes", () => {
    vi.useFakeTimers();
    const ready = vi.fn();
    function Harness() {
      const [html, setHtml] = useState(LEASE);
      return (
        <LeaseHtmlDirectEditor
          html={html}
          baselineHtml={LEASE}
          onChange={setHtml}
          onPreviewReady={ready}
        />
      );
    }
    const view = render(<Harness />);
    act(() => {
      vi.advanceTimersByTime(20);
    });
    expect(ready).toHaveBeenLastCalledWith(LEASE);
    const doc = view.container.querySelector("iframe")!.contentDocument!;

    act(() => {
      doc.body.innerHTML = "";
      fireEvent.input(doc.body);
    });
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(ready).toHaveBeenLastCalledWith(null);
    expect(view.queryByRole("alert")).toBeNull();
    expect(view.queryByText("Loading lease preview…")).toBeNull();
    expect(captureException).not.toHaveBeenCalled();
    expect(view.container.querySelector("iframe")!.contentDocument).toBe(doc);

    act(() => {
      doc.body.innerHTML = "<h2>Parties</h2><p>Replacement resident</p>";
      fireEvent.input(doc.body);
    });
    act(() => {
      vi.advanceTimersByTime(20);
    });
    expect(ready.mock.calls.at(-1)![0]).toContain("Replacement resident");
    expect(doc.body.textContent).toContain("Replacement resident");
    expect(view.queryByRole("alert")).toBeNull();
    vi.useRealTimers();
  });
});
