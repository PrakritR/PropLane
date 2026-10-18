// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PublicFooter } from "@/components/layout/public-footer";
import { LegacyPublicFooter } from "@/components/layout/legacy-public-footer";
import { publicTextingConfig } from "@/lib/marketing/public-texting";

vi.mock("next/navigation", () => ({ usePathname: () => "/features" }));
afterEach(cleanup);

describe("public footer phone configuration", () => {
  it("passes the shared PropLane number and SMS destination through the public wrapper", () => {
    const texting = publicTextingConfig("+12025550123");
    const { container } = render(<PublicFooter texting={texting} />);
    expect(screen.getByRole("link", { name: "+1 (202) 555-0123" })).toHaveAttribute("href", texting.smsHref);
    expect(container.querySelectorAll('a[href^="sms:"]')).toHaveLength(1);
    expect(container.querySelector('a[href^="tel:"]')).toBeNull();
  });

  it("omits the phone when no configuration was passed by an existing client caller", () => {
    const { container } = render(<PublicFooter />);
    expect(container.querySelector('a[href^="sms:"], a[href^="tel:"]')).toBeNull();
    expect(screen.getByRole("link", { name: "Contact us" })).toHaveAttribute("href", "/contact");
  });

  it.each([
    null,
    { phone: null, smsHref: null },
    { phone: "+12025550123", smsHref: null },
    { phone: null, smsHref: "sms:+12025550123" },
  ])("fails closed when the shared line is unavailable or incomplete: %j", (texting) => {
    const { container } = render(<LegacyPublicFooter texting={texting} />);
    expect(container.querySelector('[data-attr="footer-text-proplane"]')).toBeNull();
    expect(container.querySelector('a[href^="tel:"]')).toBeNull();
  });
});
