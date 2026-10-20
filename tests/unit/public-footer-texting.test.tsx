// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PublicFooter } from "@/components/layout/public-footer";
import { publicTextingConfig } from "@/lib/marketing/public-texting";
import { iosAppDownloadUrl } from "@/lib/ios-app-download";
afterEach(cleanup);

describe("quiet public footer", () => {
  it("uses real destinations and keeps a Portal entry in the footer", () => {
    render(<PublicFooter />);
    const nav = screen.getByRole("navigation", { name: "Footer navigation" });
    expect(within(nav).getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual([
      "/blog", "/privacy", "/tos", "/security", iosAppDownloadUrl(), "/auth/sign-in", "/#contact",
    ]);
    expect(screen.getByRole("link", { name: "App Store" })).toHaveAttribute("data-attr", "footer-app-store");
    expect(screen.queryByText("Reviews")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Portal" })).toHaveAttribute("href", "/auth/sign-in");
  });

  it("uses the configured shared SMS line, never a separate support number", () => {
    const config = publicTextingConfig("+12025550123");
    render(<PublicFooter texting={config} />);
    expect(screen.getByRole("link", { name: "Text (202) 555-0123" })).toHaveAttribute("href", config.smsHref);
    expect(screen.queryByText(/309-8345/)).not.toBeInTheDocument();
  });

  it("omits the number when unconfigured and preserves existing compact callers", () => {
    const { container } = render(<PublicFooter compact />);
    expect(container.querySelector("footer")).toHaveClass("public-simple-footer-compact");
    expect(container.querySelector('a[href^="sms:"], a[href^="tel:"]')).toBeNull();
    expect(screen.getByRole("link", { name: "Terms" })).toHaveAttribute("href", "/tos");
  });
});
