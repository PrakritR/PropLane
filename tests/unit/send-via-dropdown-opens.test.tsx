/** @vitest-environment jsdom */
/**
 * "Even if other options are not available for Send via, still have the
 * dropdown open."
 *
 * An unavailable channel must stay in the menu as a disabled row explaining
 * itself, never vanish. A field that silently drops SMS looks broken to a
 * manager who knows SMS exists; a field that shows "SMS (not enabled)" tells
 * them what to fix.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { PortalMessageSendViaDropdown } from "@/components/portal/portal-message-compose-fields";

afterEach(cleanup);

describe("Send via", () => {
  it("opens and lists the unavailable channel as disabled", async () => {
    render(
      <PortalMessageSendViaDropdown
        selected={["email"]}
        onChange={vi.fn()}
        smsAvailable={false}
        footerNote="Add a work number under Communication → SMS to text recipients."
        dataAttr="test-send-via"
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /send via|email/i }));

    const sms = await screen.findByText(/SMS \(not enabled\)/i);
    expect(sms).toBeInTheDocument();
    // The multi-select marks the ROW aria-disabled and disables its checkbox,
    // rather than disabling the row button itself.
    const row = sms.closest('[role="option"], li, button');
    expect(row).toBeTruthy();
    expect(row!.getAttribute("aria-disabled")).toBe("true");
    // Email is still selectable in the same open menu.
    expect(screen.getAllByText(/^Email$/i).length).toBeGreaterThan(0);
  });

  it("says how to enable it", () => {
    render(
      <PortalMessageSendViaDropdown
        selected={["email"]}
        onChange={vi.fn()}
        smsAvailable={false}
        footerNote="Add a work number under Communication → SMS to text recipients."
        dataAttr="test-send-via-2"
      />,
    );
    expect(screen.getByText(/Add a work number under Communication/i)).toBeInTheDocument();
  });
});
