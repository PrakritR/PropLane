// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import {
  INBOX_THREAD_ICON_BTN,
  INBOX_THREAD_ICON_BTN_DANGER,
  InboxAvatar,
  PORTAL_INBOX_COMPOSER_SEND_CLASS,
  PORTAL_LIST_PAGE_BODY,
  inboxInitials,
  inboxNameIsPhoneLike,
  shouldShowComposerCounter,
} from "@/components/portal/portal-inbox-ui";
import { smsTurnChannelTag } from "@/components/portal/pro-sms-panel";
import { buildSmsThreadScheduleBody, smsThreadCanSchedule } from "@/lib/sms-thread-schedule";
import { communicationScheduledOption } from "@/components/portal/communication-status-filter";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

afterEach(cleanup);

describe("phone-glyph initials", () => {
  it("never makes '+(' out of a phone number", () => {
    expect(inboxNameIsPhoneLike("+1 (510) 309-8345")).toBe(true);
    expect(inboxInitials("+1 (510) 309-8345")).toBe("?");
  });

  it("keeps real initials for a name, including one with digits", () => {
    expect(inboxNameIsPhoneLike("Lease QA Resident")).toBe(false);
    expect(inboxNameIsPhoneLike("Unit 4B Tenant")).toBe(false);
    expect(inboxInitials("Lease QA Resident")).toBe("LQ");
  });

  it("draws a phone glyph tile for a number-only contact and letters for a person", () => {
    const { container, rerender } = render(<InboxAvatar tile name="+1 (510) 309-8345" />);
    expect(container.querySelector('[data-inbox-avatar-glyph="phone"]')).not.toBeNull();
    expect(container.textContent).not.toContain("+(");
    rerender(<InboxAvatar tile name="Erin Tester" />);
    expect(container.querySelector('[data-inbox-avatar-glyph="phone"]')).toBeNull();
    expect(container.textContent).toBe("ET");
  });
});

describe("SMS thread channel label", () => {
  it("names the channel only when a turn left on a different one than the thread", () => {
    expect(smsTurnChannelTag("sms", "sms")).toBeNull();
    expect(smsTurnChannelTag("email", "sms")).toBe("Email");
    expect(smsTurnChannelTag("inbox", "sms")).toBe("In-app");
  });

  it("no longer hard-codes a 'Text' word under every bubble, but keeps 'Sent by'", () => {
    const src = read("src/components/portal/pro-sms-panel.tsx");
    expect(src).not.toMatch(/<span>Text<\/span>/);
    expect(src).toContain('data-attr="sms-sent-by"');
  });
});

describe("SMS composer schedule control", () => {
  const future = new Date(Date.now() + 86_400_000 * 3).toISOString().slice(0, 16);

  it("mounts the schedule menu and the pinned scheduled bar in the text thread", () => {
    const src = read("src/components/portal/pro-sms-panel.tsx");
    expect(src).toContain("InboxComposerScheduleMenu");
    expect(src).toContain("useThreadScheduledCards");
    expect(src).toContain("{threadScheduledCards}");
    expect(src).toContain("/api/portal/scheduled-inbox-messages");
  });

  it("is withheld for a phone-only contact, because the scheduler keys on an email", () => {
    expect(smsThreadCanSchedule(undefined)).toBe(false);
    expect(smsThreadCanSchedule("  ")).toBe(false);
    expect(smsThreadCanSchedule("a@b.co")).toBe(true);
    const built = buildSmsThreadScheduleBody({ residentEmail: "", text: "hi", viaEmail: false, viaSms: true, sendAtLocal: future });
    expect(built.ok).toBe(false);
  });

  it("builds a text-only scheduled send that does not also email or land in the inbox", () => {
    const built = buildSmsThreadScheduleBody({
      residentEmail: "Erin@Example.com",
      residentName: "Erin",
      text: " hello ",
      viaEmail: false,
      viaSms: true,
      sendAtLocal: future,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.body).toMatchObject({
      recipientEmail: "erin@example.com",
      body: "hello",
      deliverViaSms: true,
      deliverViaEmail: false,
      deliverViaInbox: false,
    });
  });

  it("refuses a past time and an empty message", () => {
    const past = buildSmsThreadScheduleBody({ residentEmail: "a@b.co", text: "x", viaEmail: false, viaSms: true, sendAtLocal: "2020-01-01T09:00" });
    expect(past).toEqual({ ok: false, error: "Send time must be in the future." });
    const empty = buildSmsThreadScheduleBody({ residentEmail: "a@b.co", text: "  ", viaEmail: false, viaSms: true, sendAtLocal: future });
    expect(empty.ok).toBe(false);
  });
});

describe("Scheduled in the Communication Filter (phone)", () => {
  it("labels the option with its count, and drops the number at zero", () => {
    expect(communicationScheduledOption(3)).toEqual({ value: "scheduled", label: "Scheduled 3" });
    expect(communicationScheduledOption(0).label).toBe("Scheduled");
  });

  it("is offered only on a phone and mounts the Schedule panel as a list view", () => {
    const comm = read("src/components/portal/pro-communication.tsx");
    expect(comm).toContain("showScheduled={isPhone}");
    const unified = read("src/components/portal/pro-unified-inbox.tsx");
    expect(unified).toContain("ManagerInboxSchedulePanel");
    expect(unified).toContain('requestedStatus === "scheduled"');
  });
});

describe("the bottom bar is cleared once", () => {
  it("the list page body no longer re-adds the scroll inset #portal-main-content already pads by", () => {
    expect(PORTAL_LIST_PAGE_BODY).not.toContain("--portal-mobile-scroll-bottom-inset");
    expect(PORTAL_LIST_PAGE_BODY).not.toContain("5.5rem");
    expect(PORTAL_LIST_PAGE_BODY).toContain("max-lg:pb-2");
  });

  it("the composer drops its second safe-area pad when the bottom nav is present", () => {
    const css = read("src/app/globals.css");
    expect(css).toMatch(
      /html:has\(\.portal-native-bottom-nav\) #portal-main-content \.portal-inbox-composer\s*\{\s*padding-bottom: 0\.25rem;/,
    );
    expect(css).not.toMatch(/data-communication-thread-reading\] \.portal-inbox-composer\s*\{\s*padding-bottom: max\(/);
  });

  it("the 0/1600 counter shows only past 80% of the limit, in the tools row", () => {
    expect(shouldShowComposerCounter(0, 1600)).toBe(false);
    expect(shouldShowComposerCounter(1280, 1600)).toBe(false);
    expect(shouldShowComposerCounter(1281, 1600)).toBe(true);
    expect(shouldShowComposerCounter(5000, undefined)).toBe(false);
    const ui = read("src/components/portal/portal-inbox-ui.tsx");
    expect(ui).toContain('data-attr="inbox-composer-counter"');
  });
});

describe("44px phone tap targets", () => {
  it("thread header icons, Back and Send are 44px below md", () => {
    expect(INBOX_THREAD_ICON_BTN).toContain("max-md:size-11");
    expect(INBOX_THREAD_ICON_BTN_DANGER).toContain("max-md:size-11");
    expect(PORTAL_INBOX_COMPOSER_SEND_CLASS).toContain("max-md:size-11");
    const ui = read("src/components/portal/portal-inbox-ui.tsx");
    expect(ui).toContain("max-md:min-h-11 max-md:min-w-11");
    expect(read("src/components/portal/pro-sms-panel.tsx")).toContain("min-h-11 min-w-11");
  });

  it("composer toolbar buttons are 44px below md and unchanged from md up", () => {
    const tools = read("src/components/portal/inbox-composer-tools.tsx");
    expect(tools).toContain("max-md:h-11");
    expect(tools).toContain("max-md:w-11");
    expect(tools).not.toMatch(/max-md:(h|w)-9\b/);
    expect(tools).toContain("h-7"); // desktop size kept
  });

  it("the record header icons are 44px on phones and compact only from lg", () => {
    const shell = read("src/components/portal/portal-list-detail-shell.tsx");
    expect(shell).toContain(":not([data-labeled-primary])]:!size-8");
    expect(shell).toContain("lg:[&_button:not([data-labeled-primary])]:!size-8");
    expect(shell).toContain("max-lg:[&_button:not([data-labeled-primary])]:!size-11");
    // No un-prefixed forced 32px override left.
    expect(shell).not.toMatch(/(^|[\s"'`])\[&_button:not\(\[data-labeled-primary\]\)\]:!size-8/);
  });
});

describe("the Communication header on a phone", () => {
  it("hides the work number/email boxes below lg and lets the email wrap to its full address", () => {
    const card = read("src/components/portal/pro-work-number-card.tsx");
    expect(card).toContain("max-lg:hidden");
    expect(card).toContain("wrapValue");
  });

  it("gives a dismissed setup banner no wrapper slot", () => {
    expect(read("src/app/portal/layout.tsx")).toContain("lg:hidden empty:hidden");
  });
});

describe("a stored doubled room count", () => {
  it("collapses 'Alder Row — 3 rooms · 3 rooms' to one count and leaves other titles alone", async () => {
    const { collapseDuplicateRoomCount, displayPropertyTitle } = await import("@/lib/property-title");
    expect(collapseDuplicateRoomCount("Alder Row — 3 rooms · 3 rooms")).toBe("Alder Row — 3 rooms");
    expect(collapseDuplicateRoomCount("Alder Row — 3 rooms")).toBe("Alder Row — 3 rooms");
    expect(collapseDuplicateRoomCount("Magnolia House · 5 rooms · 2 rooms")).toBe("Magnolia House · 5 rooms · 2 rooms");
    expect(displayPropertyTitle({ title: "Alder Row — 3 rooms · 3 rooms" })).toBe("Alder Row — 3 rooms");
    expect(read("src/lib/domain-action-events.server.ts")).toContain("collapseDuplicateRoomCount(input.application.property");
  });

  it("the shared thread header drops its avatar tile on a phone so five 44px icons leave the name room", () => {
    expect(read("src/components/portal/portal-inbox-ui.tsx")).toContain('className="size-8 rounded-lg max-md:hidden"');
  });
});
