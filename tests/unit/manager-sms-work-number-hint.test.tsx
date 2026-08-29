// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const pathname = vi.fn(() => "/portal/communication");

vi.mock("next/navigation", () => ({ usePathname: () => pathname() }));

import { ManagerSmsWorkNumberHint } from "@/components/portal/manager-sms-work-number-hint";

afterEach(() => {
  cleanup();
  pathname.mockReturnValue("/portal/communication");
});

describe("ManagerSmsWorkNumberHint", () => {
  it("does not link to the settings page it is already rendered on", () => {
    pathname.mockReturnValue("/portal/profile");
    render(<ManagerSmsWorkNumberHint show phone="+18559168031" canSend={false} />);

    // Telling someone to go to the page they are reading is a dead end.
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain(
      "Turn off SMS for this send in the meantime.",
    );
  });

  it("links to settings from a compose surface elsewhere", () => {
    pathname.mockReturnValue("/portal/communication");
    render(<ManagerSmsWorkNumberHint show phone={null} canSend={false} />);

    expect(screen.getByRole("link").getAttribute("href")).toBe(
      "/portal/profile?tab=messaging",
    );
    expect(screen.getByRole("alert").textContent).toContain(
      "SMS needs an active work number.",
    );
  });

  it("says a provisioned number is awaiting the carrier, not awaiting setup", () => {
    render(<ManagerSmsWorkNumberHint show phone="+18559168031" canSend={false} />);

    const text = screen.getByRole("alert").textContent ?? "";
    // There is no setup step left for the manager here — the carrier is
    // reviewing. "Finish setup" sends them hunting for a control that is
    // not there.
    expect(text).toContain("waiting on carrier approval");
    expect(text).toContain("+1 (855) 916-8031");
    expect(text).not.toContain("Finish setup");
  });

  it("shows the usable number instead of a warning once it can send", () => {
    render(<ManagerSmsWorkNumberHint show phone="+18559168031" canSend />);

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("+1 (855) 916-8031")).toBeTruthy();
  });
});
