// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PublicFooter } from "@/components/layout/public-footer";
import { publicTextingConfig } from "@/lib/marketing/public-texting";
afterEach(cleanup);

describe("compact public footer", () => {
  it("keeps only Blog, legal links, Sign in and the App Store badge", () => {
    render(<PublicFooter />);
    const nav = screen.getByRole("navigation", { name: "Footer navigation" });
    expect(within(nav).getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual([
      "/blog", "/privacy", "/tos", "/auth/sign-in",
    ]);
    expect(document.querySelector('[data-attr="footer-app-store"]')).not.toBeNull();
    expect(screen.queryByText("Reviews")).not.toBeInTheDocument();
  });

  it("does not introduce another phone CTA or a fixed support number", () => {
    const { container } = render(<PublicFooter texting={publicTextingConfig("+12025550123")} />);
    expect(container.querySelector('a[href^="sms:"], a[href^="tel:"]')).toBeNull();
    expect(screen.queryByText(/555-0123|309-8345/)).not.toBeInTheDocument();
  });

  it("keeps existing compact callers on the same small footer", () => {
    const { container } = render(<PublicFooter compact />);
    expect(container.querySelector("footer")).toHaveClass("public-simple-footer-compact");
    expect(screen.getByRole("link", { name: "Terms" })).toHaveAttribute("href", "/tos");
  });
});
