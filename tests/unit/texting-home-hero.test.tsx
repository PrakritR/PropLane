// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TextingHomeHero } from "@/components/marketing/texting-home-hero";
import { BigNumber } from "@/components/marketing/big-number";
import { publicTextingConfig } from "@/lib/marketing/public-texting";
import { formatPublicPhone } from "@/lib/marketing/format-public-phone";
import { HOME_HEADLINE } from "@/lib/marketing/home-copy";
import { PublicTextingProvider } from "@/components/marketing/public-texting-context";

const config = publicTextingConfig("+12025550123");
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("single-page number cover", () => {
  it("server-renders the configured number from the layout snapshot without a fetch", () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const html = renderToString(<PublicTextingProvider value={config}><TextingHomeHero /></PublicTextingProvider>);
    expect(html).toContain("(202) 555-0123");
    expect(html).toContain("sms:+12025550123?&amp;body=Hi%20PropLane");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("shows only the huge headline and one Text us/number action", () => {
    const { container } = render(<TextingHomeHero config={config} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(HOME_HEADLINE);
    expect(screen.getByRole("link", { name: "Text us (202) 555-0123" })).toHaveAttribute("href", config.smsHref);
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(container.querySelector(".rl-phone-wrap")).toBeNull();
    expect(container.querySelector("p")).toBeNull();
    expect(screen.queryByText(/ONE NUMBER\. EVERY CONVERSATION\./)).not.toBeInTheDocument();
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
