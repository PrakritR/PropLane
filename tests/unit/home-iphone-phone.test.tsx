// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HomeIphonePhone } from "@/components/marketing/home-iphone-phone";
import { PublicTextingProvider } from "@/components/marketing/public-texting-context";
import type { PhoneItem } from "@/components/marketing/resident-lifecycle-script";

const items: PhoneItem[] = [{ kind: "out", text: "Could I tour on Thursday?" }, { kind: "in", text: "Thursday at 5:30 works." }];
const config = { phone: "+12065550123", smsHref: "sms:+12065550123" };
beforeEach(() => { vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("Phone samples never fetch"); }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("homepage iPhone Messages preview", () => {
  it("renders the configured number in server markup alongside the real scene text", () => {
    const html = renderToStaticMarkup(<PublicTextingProvider value={config}><HomeIphonePhone label="Prospect’s phone" items={items} /></PublicTextingProvider>);
    expect(html).toContain("(206) 555-0123");
    expect(html).toContain("PropLane");
    expect(html).toContain("Could I tour on Thursday?");
    expect(html).toContain("Thursday at 5:30 works.");
    expect(html).toContain("iMessage");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("omits the number without config and exposes no fake interactive chrome", () => {
    const { container } = render(<HomeIphonePhone items={items} />);
    expect(container.querySelector('[data-attr="home-phone-number"]')).toBeNull();
    expect(container.querySelector("button, input, form, a")).toBeNull();
    expect(screen.getByText("PropLane")).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("changes scenes without carrying prior replies over and supports the caller’s typing state", () => {
    const { container, rerender } = render(<HomeIphonePhone items={items} typing="in" />);
    expect(screen.getByRole("status", { name: "Typing" })).toBeInTheDocument();
    expect(container.querySelector(".home-iphone-message--out")).toHaveTextContent(items[0].kind === "out" ? items[0].text : "");
    rerender(<HomeIphonePhone items={[{ kind: "in", text: "Your rent payment is received." }]} />);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText("Could I tour on Thursday?")).toBeNull();
    expect(screen.getByText("Your rent payment is received.")).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });
});
