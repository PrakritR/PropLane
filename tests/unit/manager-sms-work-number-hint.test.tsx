// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const pathname = vi.fn(() => "/portal/communication");
const showToast = vi.fn();

vi.mock("next/navigation", () => ({ usePathname: () => pathname() }));
vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast }),
}));

import {
  ManagerSmsWorkNumberHint,
  ManagerWorkNumberCopyControl,
} from "@/components/portal/pro-sms-work-number-hint";

afterEach(() => {
  cleanup();
  showToast.mockReset();
  pathname.mockReturnValue("/portal/communication");
  vi.unstubAllGlobals();
});

describe("ManagerSmsWorkNumberHint", () => {
  it.each([123, {}, [], true, null, undefined])("handles a malformed phone (%j) with SMS enabled or disabled", (phone) => {
    const { rerender } = render(
      <ManagerSmsWorkNumberHint show phone={phone as unknown as string} canSend />,
    );
    expect(screen.getByRole("alert").textContent).toContain("SMS needs an active work number.");
    rerender(<ManagerSmsWorkNumberHint show phone={phone as unknown as string} canSend={false} />);
    expect(screen.getByRole("alert").textContent).toContain("SMS needs an active work number.");
  });

  it("does not copy an invalid phone value", () => {
    const writeText = vi.fn();
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<ManagerWorkNumberCopyControl phone={{} as unknown as string} />);
    const button = screen.getByRole("button", { name: "Copy work number —" });
    expect(button.hasAttribute("disabled")).toBe(true);
    fireEvent.click(button);
    expect(writeText).not.toHaveBeenCalled();
  });

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
    expect(
      screen.getByRole("button", { name: "Copy work number +1 (855) 916-8031" }),
    ).toBeTruthy();
  });

  it("copies the work number to the clipboard when clicked", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    render(<ManagerWorkNumberCopyControl phone="+18559168031" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy work number +1 (855) 916-8031" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("+18559168031"));
    expect(showToast).toHaveBeenCalledWith("Work number copied.");
    expect(screen.getByText("Copied to clipboard.")).toBeTruthy();
  });
});
