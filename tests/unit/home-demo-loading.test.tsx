// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ComponentType } from "react";
import { DemoSampleLoading, DemoPopupLoading } from "@/components/marketing/site/product-mock/demo-sample-loading";
import { DemoPopupHostContext } from "@/components/marketing/site/product-mock/demo-popup-host";

const registrations = vi.hoisted(() => [] as { loading?: ComponentType }[]);
vi.mock("next/dynamic", () => ({ default: (_loader: unknown, options: { loading?: ComponentType }) => {
  registrations.push(options);
  return options.loading ?? (() => null);
} }));
afterEach(cleanup);

describe("lazy sample loading states", () => {
  it("announces a readable loading state without focusable controls or motion", () => {
    const { container } = render(<DemoSampleLoading />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading sample…");
    expect(container.querySelector("button, a, input, [tabindex]")).toBeNull();
  });

  it("keeps dialog loading inside the supplied preview host", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const { container, unmount } = render(<DemoPopupHostContext value={host}><DemoPopupLoading /></DemoPopupHostContext>);
    expect(within(host).getByRole("status")).toHaveTextContent("Loading sample…");
    expect(container.querySelector('[role="status"]')).toBeNull();
    unmount();
    expect(host.children).toHaveLength(0);
    host.remove();
  });

  it("provides a local fallback when a standalone sample has no popup host", () => {
    render(<DemoPopupLoading />);
    expect(screen.getByRole("status")).toBeVisible();
  });

  it("all lazy record and dialog registrations have a visible fallback without loading their chunks", async () => {
    await Promise.all([
      import("@/components/marketing/site/product-mock/demo-popups-lazy"),
      import("@/components/marketing/site/product-mock/demo-popups-lazy-home"),
      import("@/components/marketing/site/product-mock/demo-popups-lazy-leasing"),
      import("@/components/marketing/site/product-mock/demo-popups-lazy-money"),
      import("@/components/marketing/site/product-mock/demo-popups-lazy-ops"),
      import("@/components/marketing/site/product-mock/demo-popups-lazy-people"),
      import("@/components/marketing/site/product-mock/demo-popups-lazy-resident"),
      import("@/components/marketing/site/product-mock/demo-popups-lazy-vendor"),
    ]);
    expect(registrations.length).toBeGreaterThan(0);
    for (const { loading: Loading } of registrations) {
      expect(Loading).toBeTypeOf("function");
      const { container, unmount } = render(Loading ? <Loading /> : null);
      // Existing filter-icon placeholders remain usable; panels and dialogs announce loading.
      expect(container.querySelector('[role="status"], button')).not.toBeNull();
      unmount();
    }
  });
});
