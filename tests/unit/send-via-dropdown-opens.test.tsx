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
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  PortalMessageSendViaDropdown,
  portalMessageSendViaFooterNote,
} from "@/components/portal/portal-message-compose-fields";

afterEach(cleanup);

describe("Send via", () => {
  it("opens and lists the unavailable channel as disabled", async () => {
    render(
      <PortalMessageSendViaDropdown
        selected={["email"]}
        onChange={vi.fn()}
        smsAvailable={false}
        footerNote=""
        dataAttr="test-send-via"
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /send via|email|proplane/i }));

    expect(screen.getByText(/^PropLane$/i)).toBeInTheDocument();
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

  it("does not show the Communication → SMS setup footnote", () => {
    expect(portalMessageSendViaFooterNote(false)).toBe("");
    expect(portalMessageSendViaFooterNote(true)).toBe("");
    render(
      <PortalMessageSendViaDropdown
        selected={["email"]}
        onChange={vi.fn()}
        smsAvailable={true}
        footerNote={portalMessageSendViaFooterNote(true)}
        dataAttr="test-send-via-2"
      />,
    );
    expect(screen.queryByText(/Add a work number under Communication/i)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/SMS uses your work number; recipients need a phone on file or under Other/i),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/SMS uses your work number when enabled/i)).not.toBeInTheDocument();
  });

  it("compose and share surfaces do not reintroduce a Send-via footnote", () => {
    const files = [
      "src/components/portal/pro-work-orders-panel.tsx",
      "src/components/portal/schedule-inbox-compose-modal.tsx",
      "src/components/portal/share-lead-link-modal.tsx",
      "src/components/portal/portal-record-share-modal.tsx",
      "src/components/portal/pro-messaging-settings-panel.tsx",
    ];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/Always saved to PropLane inbox/);
      expect(source, file).not.toMatch(/SMS uses your work number/);
      expect(source, file).not.toMatch(/Sent via PropLane when email and SMS delivery are configured/);
      expect(source, file).not.toMatch(/We'll email and text every resident in your portfolio/);
    }
  });
});
