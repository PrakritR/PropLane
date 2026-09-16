// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { CommunicationArchivedInboxButton } from "@/components/portal/communication-archived-inbox-button";

afterEach(() => {
  cleanup();
});

describe("CommunicationArchivedInboxButton", () => {
  it("is a labeled destination into archived messages", () => {
    const onViewChange = vi.fn();
    render(
      <CommunicationArchivedInboxButton
        commBase="/portal/communication"
        listSegment="active"
        onViewChange={onViewChange}
      />,
    );

    const link = screen.getByRole("link", { name: "Archived messages" });
    expect(link.getAttribute("href")).toBe("/portal/communication/archived");
    expect(link.getAttribute("aria-pressed")).toBeNull();
    expect(link.textContent).toContain("Archived");
    expect(link.getAttribute("data-attr")).toBe("communication-archived-inbox-toggle");

    fireEvent.click(link);
    expect(onViewChange).toHaveBeenCalledWith("archived");
  });

  it("stays labeled Archived while that view is open and returns to the inbox", () => {
    const onViewChange = vi.fn();
    render(
      <CommunicationArchivedInboxButton
        commBase="/portal/communication"
        listSegment="archived"
        onViewChange={onViewChange}
      />,
    );

    const link = screen.getByRole("link", { name: "Archived messages" });
    expect(link.getAttribute("href")).toBe("/portal/communication/active");
    expect(link.getAttribute("aria-pressed")).toBe("true");
    expect(link.textContent).toContain("Archived");

    fireEvent.click(link);
    expect(onViewChange).toHaveBeenCalledWith("active");
  });
});

describe("Communication archived chrome", () => {
  it("mounts the labeled Archived button on the manager conversation list", () => {
    const source = readFileSync("src/components/portal/pro-unified-inbox.tsx", "utf8");
    expect(source).toContain("<CommunicationArchivedInboxButton");
    expect(source).toContain("className=\"w-full\"");
    expect(source).not.toContain("onTellResidents");
    expect(source).not.toContain("<InboxListSegmentRail");
  });

  it("thread header Archive is an icon, not the word", () => {
    for (const file of ["src/components/portal/pro-inbox.tsx", "src/components/portal/pro-resident-detail-inbox.tsx"]) {
      const source = readFileSync(file, "utf8");
      expect(source, file).toMatch(/aria-label="Archive conversation"/);
      expect(source, file).toMatch(/data-attr="inbox-thread-archive"/);
      expect(source, file).toMatch(/className=\{INBOX_THREAD_ICON_BTN\}/);
      expect(source, file).not.toMatch(/>Archive</);
    }
  });

  it("manager work-number card no longer carries the megaphone", () => {
    const source = readFileSync("src/components/portal/pro-work-number-card.tsx", "utf8");
    expect(source).not.toContain("Megaphone");
    expect(source).not.toContain("Tell residents");
    expect(source).toContain("manager-work-email-copy");
  });
});
