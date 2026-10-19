// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TextingHomeHero } from "@/components/marketing/texting-home-hero";
import { BigNumber } from "@/components/marketing/big-number";
import { publicTextingConfig } from "@/lib/marketing/public-texting";
import { formatPublicPhone } from "@/lib/marketing/format-public-phone";
import { HOME_HEADLINE } from "@/lib/marketing/home-copy";
import { RESIDENT_GET_STARTED_HREF, VENDOR_GET_STARTED_HREF } from "@/lib/marketing/public-contact";
import { PublicTextingProvider } from "@/components/marketing/public-texting-context";

const config = publicTextingConfig("+12025550123");
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("housing texting cover", () => {
  it("server-renders the configured number from the layout snapshot without a fetch", () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const html = renderToString(<PublicTextingProvider value={config}><TextingHomeHero /></PublicTextingProvider>);
    expect(html).toContain("(202) 555-0123");
    expect(html).toContain("sms:+12025550123?&amp;body=Hi%20PropLane");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("shows the headline, number, decorative housing scene and role strip", () => {
    const { container } = render(<TextingHomeHero config={config} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(HOME_HEADLINE);
    const pill = screen.getByRole("link", { name: "Text PropLane (202) 555-0123" });
    expect(pill).toHaveAttribute("href", config.smsHref);
    expect(pill).toHaveTextContent("Text PropLane");
    expect(pill.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelector(".home-text-number")).toHaveTextContent("(202) 555-0123");
    expect(screen.getAllByRole("link")).toHaveLength(5);
    expect(screen.getByRole("link", { name: "Residents" })).toHaveAttribute("href", RESIDENT_GET_STARTED_HREF);
    expect(screen.getByRole("link", { name: "Vendors" })).toHaveAttribute("href", VENDOR_GET_STARTED_HREF);
    expect(screen.getByRole("link", { name: "Prospects" })).toHaveAttribute("href", "/rent/browse");
    expect(container.querySelector(".home-housing-scene")).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
    expect(container.querySelector(".home-discovery-phone")).not.toBeNull();
    for (const role of ["Prospects", "Residents", "Vendors", "Owners"]) expect(screen.getByText(role)).toBeVisible();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(container.querySelector(".rl-phone-wrap")).toBeNull();
    expect(container.querySelector("p")).toBeNull();
    expect(container.querySelector(".home-big-number")).toBeNull();
    expect(screen.queryByText(/ONE NUMBER\. EVERY CONVERSATION\./)).not.toBeInTheDocument();
  });


  it("does not render a QR even if an older layout snapshot still carries one", () => {
    const legacySnapshot = { ...config, qrDataUrl: "data:image/png;base64,old-qr" };
    render(<PublicTextingProvider value={legacySnapshot}><TextingHomeHero /></PublicTextingProvider>);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /scan/i })).not.toBeInTheDocument();
  });

  it("falls back to Start free without inventing a phone when config is missing", () => {
    render(<TextingHomeHero config={{ phone: null, smsHref: null }} />);
    expect(screen.getByRole("link", { name: "Start free" })).toHaveAttribute("href", "/auth/create-account");
    expect(document.querySelector('a[href^="sms:"]')).toBeNull();
  });

  it("never restores the removed demo modal from a legacy query", () => {
    window.history.replaceState(null, "", "/?demo=open");
    render(<TextingHomeHero config={config} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText(/open the demo|replay/i)).not.toBeInTheDocument();
    window.history.replaceState(null, "", "/");
  });

  it("formats configured numbers and refuses placeholders", () => {
    expect(formatPublicPhone("+12025550123")).toBe("(202) 555-0123");
    expect(formatPublicPhone(null)).toBeNull();
    expect(formatPublicPhone("(206) XXX-XXXX")).toBeNull();
    const { container } = render(<BigNumber config={{ phone: null, smsHref: null }} />);
    expect(container).toBeEmptyDOMElement();
  });

});
