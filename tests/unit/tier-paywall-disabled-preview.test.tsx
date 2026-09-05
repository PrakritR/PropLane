// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  PortalTierPaywall,
  ResidentTierPaywall,
} from "@/components/portal/portal-tier-paywall";

afterEach(cleanup);

describe("tier paywall disabled previews", () => {
  it("shows managers an inert feature preview and the explicit upgrade CTA", () => {
    const { container } = render(
      <PortalTierPaywall basePath="/portal" featureLabel="Communication" />,
    );

    const preview = container.querySelector("[data-paywall-preview]");
    expect(preview).toBeTruthy();
    expect(preview?.hasAttribute("inert")).toBe(true);
    expect(
      screen.getByRole("link", { name: "Upgrade to Pro or Business" }).getAttribute("href"),
    ).toBe("/portal/profile#portal-plan");
  });

  it("shows residents the same disabled preview with a manager-contact path", () => {
    const { container } = render(
      <ResidentTierPaywall featureLabel="Documents" />,
    );

    expect(container.querySelector("[data-paywall-preview]")?.hasAttribute("inert")).toBe(true);
    expect(
      screen.getByRole("link", { name: "Message property manager" }).getAttribute("href"),
    ).toBe("/resident/communication/active");
    expect(screen.queryByRole("link", { name: "Upgrade to Pro or Business" })).toBeNull();
  });
});
