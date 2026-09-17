// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { CommunicationArchivedInboxButton } from "@/components/portal/communication-archived-inbox-button";
import { InboxListSegmentTabs } from "@/components/portal/portal-inbox-ui";

afterEach(() => {
  cleanup();
});

describe("InboxListSegmentTabs", () => {
  it("is Active | Archived destinations under the identity boxes", () => {
    render(<InboxListSegmentTabs commBase="/portal/communication" value="active" />);

    const active = screen.getByRole("link", { name: "Active" });
    const archived = screen.getByRole("link", { name: "Archived" });
    expect(active.getAttribute("href")).toBe("/portal/communication/active");
    expect(archived.getAttribute("href")).toBe("/portal/communication/archived");
    expect(active.getAttribute("aria-current")).toBe("page");
    expect(archived.getAttribute("aria-current")).toBeNull();
    expect(document.querySelector("[data-attr='inbox-list-segments']")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Unread" })).toBeNull();
  });

  it("treats the unread URL as the Active tab", () => {
    render(<InboxListSegmentTabs commBase="/portal/communication" value="unread" />);
    expect(screen.getByRole("link", { name: "Active" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Archived" }).getAttribute("aria-current")).toBeNull();
  });

  it("shows Tours-style counts on Active and Archived", () => {
    render(
      <InboxListSegmentTabs
        commBase="/portal/communication"
        value="archived"
        counts={{ active: 4, archived: 2 }}
      />,
    );
    expect(screen.getByRole("link", { name: /Active/ }).textContent).toContain("4");
    const archived = screen.getByRole("link", { name: /Archived/ });
    expect(archived.getAttribute("aria-current")).toBe("page");
    expect(archived.textContent).toContain("2");
  });
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
});

describe("Communication archived chrome", () => {
  it("mounts Active | Archived tabs on the manager conversation list", () => {
    const source = readFileSync("src/components/portal/pro-unified-inbox.tsx", "utf8");
    expect(source).toContain("<InboxListSegmentTabs");
    expect(source).toContain("PortalIconAction");
    expect(source).toContain("Trash2");
    expect(source).toContain('label="Delete all archived"');
    expect(source).toContain("unified-inbox-delete-all-archived");
    expect(source).not.toMatch(/>\s*Delete all archived\s*</);
    expect(source).toContain("InboxThreadSkeleton");
    expect(source).not.toContain("<CommunicationArchivedInboxButton");
    expect(source).not.toContain("onTellResidents");
    expect(source).not.toContain("<InboxListSegmentRail");
  });

  it("drops the toolbar Phone setup CTA from manager Communication", () => {
    const source = readFileSync("src/components/portal/pro-communication.tsx", "utf8");
    expect(source).not.toContain("ManagerWorkNumberButton");
    expect(source).toContain("hideArchived");
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

  it("manager work-number card has no phone glyph or megaphone", () => {
    const source = readFileSync("src/components/portal/pro-work-number-card.tsx", "utf8");
    expect(source).not.toContain("Megaphone");
    expect(source).not.toContain("Tell residents");
    expect(source).not.toMatch(/import \{[^}]*\bPhone\b[^}]*\} from "lucide-react"/);
    expect(source).not.toMatch(/<Phone[\s/>]/);
    expect(source).toContain("manager-work-email-copy");
    expect(source).toContain("manager-work-number-setup");
    expect(source).toContain("Set up work number");
    expect(source).toContain("Set up work email");
  });
});
