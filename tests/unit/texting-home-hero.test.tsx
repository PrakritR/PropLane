// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TextingHomeHero } from "@/components/marketing/texting-home-hero";
import { phoneScriptFor } from "@/components/marketing/resident-lifecycle-script";
import { publicTextingConfig } from "@/lib/marketing/public-texting";
import { GET_STARTED_HREF } from "@/lib/marketing/public-contact";
import { HOME_HEADLINE } from "@/lib/marketing/home-copy";
import { PublicTextingProvider } from "@/components/marketing/public-texting-context";

const motion = vi.hoisted(() => ({ reduced: false }));
vi.mock("@/components/ui/motion/use-reduced-motion", () => ({ useReducedMotion: () => motion.reduced }));
vi.mock("@/lib/analytics/track-client", () => ({ track: vi.fn() }));
vi.mock("@/components/marketing/text-link-form", () => ({ TextLinkForm: () => <form aria-label="Text me a link" /> }));
vi.mock("next/dynamic", () => ({
  default: () => function WebDemo({ onClose }: { onClose: () => void }) {
    return <div role="dialog" aria-label="PropLane demo"><button onClick={onClose}>Close demo</button></div>;
  },
}));
const config = publicTextingConfig("+12025550123");
const qrDataUrl = "data:image/png;base64,cXItZml4dHVyZQ==";
const conversation = phoneScriptFor("resident", "tour").items.filter((item) => item.kind !== "time");
const messageCount = () => document.querySelectorAll(".texting-bubble, .texting-tour-card").length;

beforeEach(() => {
  motion.reduced = false;
  window.history.replaceState(null, "", "/");
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 16));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("text-first homepage hero", () => {
  it("renders its shared line and QR from the layout snapshot without a client fetch", () => {
    render(<PublicTextingProvider value={{ ...config, qrDataUrl }}><TextingHomeHero /></PublicTextingProvider>);
    expect(screen.getByRole("link", { name: "+1 (202) 555-0123" })).toHaveAttribute("href", config.smsHref);
    expect(screen.getByRole("img", { name: "Scan to text PropLane" })).toHaveAttribute("src", qrDataUrl);
  });
  it("uses the configured SMS link on phones and the QR panel on desktop", () => {
    render(<TextingHomeHero config={config} qrDataUrl={qrDataUrl} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(HOME_HEADLINE);
    const links = screen.getAllByRole("link", { name: "Text PropLane" });
    expect(links.map((link) => link.getAttribute("href"))).toEqual([config.smsHref, "#text-proplane"]);
    const qrLink = screen.getByRole("link", { name: "Text PropLane using your messaging app" });
    expect(qrLink).toHaveAttribute("href", config.smsHref);
    expect(within(qrLink).getByRole("img", { name: "Scan to text PropLane" })).toHaveAttribute("src", qrDataUrl);
    expect(screen.getByRole("link", { name: "+1 (202) 555-0123" })).toHaveAttribute("href", config.smsHref);
    expect(screen.getByRole("form", { name: "Text me a link" })).toBeInTheDocument();
  });

  it("offers signup without inventing a number or showing the text-link form when no number is configured", () => {
    render(<TextingHomeHero config={{ phone: null, smsHref: null }} qrDataUrl={qrDataUrl} />);
    const links = screen.getAllByRole("link", { name: "Start free" });
    expect(links).toHaveLength(2);
    links.forEach((link) => expect(link).toHaveAttribute("href", GET_STARTED_HREF));
    expect(document.querySelector('a[href^="sms:"]')).toBeNull();
    expect(screen.queryByRole("img", { name: "Scan to text PropLane" })).not.toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Text me a link" })).not.toBeInTheDocument();
  });

  it("plays the complete sample once and removes its typing indicator", () => {
    render(<TextingHomeHero config={config} qrDataUrl={qrDataUrl} />);
    expect(messageCount()).toBe(1);
    expect(screen.getByLabelText("PropLane is typing")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1399));
    expect(messageCount()).toBe(1);
    act(() => vi.advanceTimersByTime(1));
    expect(messageCount()).toBe(2);
    act(() => vi.advanceTimersByTime(10_000));
    expect(messageCount()).toBe(conversation.length);
    expect(screen.queryByLabelText("PropLane is typing")).not.toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("restarts the conversation without leaving the previous playback timers active", () => {
    render(<TextingHomeHero config={config} qrDataUrl={null} />);
    act(() => vi.advanceTimersByTime(1400));
    expect(messageCount()).toBe(2);
    fireEvent.click(screen.getByRole("button", { name: "Replay sample conversation" }));
    expect(messageCount()).toBe(1);
    act(() => vi.advanceTimersByTime(750));
    expect(messageCount()).toBe(1);
    act(() => vi.advanceTimersByTime(650));
    expect(messageCount()).toBe(2);
  });

  it("clears pending playback and deep-link frame callbacks when unmounted", () => {
    const view = render(<TextingHomeHero config={config} qrDataUrl={null} />);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shows every message immediately with no replay or typing animation under reduced motion", () => {
    motion.reduced = true;
    render(<TextingHomeHero config={config} qrDataUrl={null} />);
    expect(messageCount()).toBe(conversation.length);
    expect(screen.queryByRole("button", { name: "Replay sample conversation" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("PropLane is typing")).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(16));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("loads the interactive demo only after the visitor opens it and allows closing it", () => {
    render(<TextingHomeHero config={config} qrDataUrl={null} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open the demo" }));
    expect(screen.getByRole("dialog", { name: "PropLane demo" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close demo" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens a text-link demo destination and removes only its demo query on close", () => {
    window.history.replaceState(null, "", "/?demo=open&source=test#pricing");
    render(<TextingHomeHero config={config} qrDataUrl={null} />);
    act(() => vi.advanceTimersByTime(16));
    expect(screen.getByRole("dialog", { name: "PropLane demo" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close demo" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(window.location.search).toBe("?source=test");
    expect(window.location.hash).toBe("#pricing");
  });
});
