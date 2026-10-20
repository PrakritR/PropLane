// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePublicTexting } from "@/components/marketing/public-texting-context";
import { formatPublicPhone } from "@/lib/marketing/format-public-phone";
import { publicTextingConfig } from "@/lib/marketing/public-texting";
import { PUBLIC_SUPPORT_PHONE_DISPLAY, PUBLIC_SUPPORT_PHONE_TEL } from "@/lib/marketing/public-contact";

const mocks = vi.hoisted(() => ({ config: vi.fn(), fetch: vi.fn() }));
vi.mock("@/lib/marketing/public-texting.server", () => ({ getPublicTextingConfig: mocks.config }));
vi.mock("@/components/marketing/marketing-page-shell", () => ({
  MarketingPageShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  MarketingSection: ({ children }: { children: ReactNode }) => <section>{children}</section>,
  MarketingHero: ({ title }: { title: string }) => <h1>{title}</h1>,
}));
vi.mock("@/components/marketing/site/final-cta", () => ({ SiteFinalCta: () => null }));
vi.mock("@/components/partner/partner-meeting-scheduler", () => ({ PartnerMeetingScheduler: () => null }));
vi.mock("@/components/providers/app-ui-provider", () => ({ useAppUi: () => ({ showToast: vi.fn() }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }), useSearchParams: () => new URLSearchParams() }));

import AboutPage from "@/app/(public)/about/page";
import { ManagedTalkSection } from "@/components/marketing/site/managed-service-sections";

const configured = publicTextingConfig("+12065550123");
const unavailable = publicTextingConfig(null);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.config.mockResolvedValue(configured);
  vi.stubGlobal("fetch", mocks.fetch);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("one configured number on public contact pages", () => {
  it.each([{ Page: AboutPage }])("renders only the shared SMS destination on page %#", async ({ Page }) => {
    const { container } = render(await Page());
    const smsLinks = container.querySelectorAll<HTMLAnchorElement>('a[href^="sms:"]');
    expect(smsLinks.length).toBeGreaterThan(0);
    for (const link of smsLinks) {
      expect(link.getAttribute("href")).toBe(configured.smsHref);
      expect(link).toHaveTextContent(formatPublicPhone(configured.phone)!);
    }
    expect(container).not.toHaveTextContent(PUBLIC_SUPPORT_PHONE_DISPLAY);
    expect(container.querySelector(`a[href="tel:${PUBLIC_SUPPORT_PHONE_TEL}"]`)).toBeNull();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each([{ Page: AboutPage }])("omits the number entirely when unavailable on page %#", async ({ Page }) => {
    mocks.config.mockResolvedValue(unavailable);
    const { container } = render(await Page());
    expect(container.querySelector('a[href^="sms:"],a[href^="tel:"]')).toBeNull();
    expect(screen.queryByText("Text PropLane")).not.toBeInTheDocument();
    expect(container).not.toHaveTextContent(PUBLIC_SUPPORT_PHONE_DISPLAY);
  });

  it("managed service uses the same configured SMS destination", async () => {
    const { container } = render(await ManagedTalkSection({}));
    const link = screen.getByRole("link", { name: /Text PropLane/ });
    expect(link).toHaveAttribute("href", configured.smsHref);
    expect(link).toHaveTextContent(formatPublicPhone(configured.phone)!);
    expect(container.querySelector('a[href^="tel:"]')).toBeNull();
    expect(container).not.toHaveTextContent(PUBLIC_SUPPORT_PHONE_DISPLAY);
    expect(mocks.config).toHaveBeenCalledOnce();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("managed service omits the SMS option when unconfigured and retains email", async () => {
    mocks.config.mockResolvedValue(unavailable);
    const { container } = render(await ManagedTalkSection({}));
    expect(container.querySelector('a[href^="sms:"],a[href^="tel:"]')).toBeNull();
    expect(screen.queryByRole("link", { name: /Text PropLane/ })).not.toBeInTheDocument();
    expect(container.querySelector('a[href^="mailto:"]')).toBeTruthy();
    expect(container).not.toHaveTextContent(PUBLIC_SUPPORT_PHONE_DISPLAY);
  });

  it("managed service never imports the fixed support number", () => {
    const source = readFileSync("src/components/marketing/site/managed-service-sections.tsx", "utf8");
    expect(source).not.toMatch(/PUBLIC_SUPPORT_PHONE_(DISPLAY|TEL)/);
  });

  it("the provider defaults to unavailable rather than a fixed support number", () => {
    function Probe() { return <output>{JSON.stringify(usePublicTexting())}</output>; }
    render(<Probe />);
    expect(screen.getByRole("status")).toHaveTextContent(JSON.stringify(unavailable));
  });

  // The home page owns the Contact section now; the fixed support number must not come back on either surface.
  it.each(["src/app/(public)/about/page.tsx", "src/app/(public)/page.tsx"])(
    "guards against reintroducing fixed support constants in %s",
    (file) => {
      expect(readFileSync(file, "utf8")).not.toMatch(/PUBLIC_SUPPORT_PHONE_(DISPLAY|TEL)/);
    },
  );
});
