// @vitest-environment jsdom
/**
 * `ReminderSentHistory` — the read-only Sent history table.
 *
 * Fetches from `/api/portal/reminder-history`; these tests mock `fetch` to
 * hand it the exact response shape that route returns.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { ReminderSentHistory, type ReminderSentHistoryItem } from "@/components/portal/reminder-sent-history";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function item(over: Partial<ReminderSentHistoryItem>): ReminderSentHistoryItem {
  return {
    id: "row-1",
    kind: "tour",
    kindLabel: "Tour",
    status: "sent",
    recipientEmail: "guest@example.com",
    recipientPhone: null,
    recipientRole: "counterparty",
    channel: "email",
    sendAtLabel: "Sep 10, 10:00 AM",
    sentAtLabel: "Sep 10, 10:00 AM",
    lastError: null,
    ...over,
  };
}

function mockFetchOnce(body: unknown, ok = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok,
      json: async () => body,
    }),
  );
}

describe("ReminderSentHistory", () => {
  it("hides the SMS column when the flag is off but still lists the SMS row", async () => {
    mockFetchOnce({
      items: [
        item({ id: "email-row", kindLabel: "Tour" }),
        item({
          id: "sms-row",
          kind: "tour_interest",
          kindLabel: "Tour interest follow-up",
          channel: "sms",
          recipientEmail: null,
          recipientPhone: "+14155551234",
        }),
      ],
      nextCursor: null,
      smsUiEnabled: false,
    });

    render(<ReminderSentHistory />);

    await waitFor(() => expect(screen.getByText("Tour interest follow-up")).toBeInTheDocument());

    // No dedicated channel/SMS column.
    expect(screen.queryByText("Channel")).not.toBeInTheDocument();
    expect(screen.queryByText("SMS")).not.toBeInTheDocument();

    // Both rows are still present.
    expect(screen.getByText("Tour")).toBeInTheDocument();
    expect(screen.getByText("Tour interest follow-up")).toBeInTheDocument();
    expect(screen.getByText("+14155551234")).toBeInTheDocument();
  });

  it("shows the SMS column and channel value when the flag is on", async () => {
    mockFetchOnce({
      items: [
        item({
          id: "sms-row",
          kind: "tour_interest",
          kindLabel: "Tour interest follow-up",
          channel: "sms",
          recipientEmail: null,
          recipientPhone: "+14155551234",
        }),
      ],
      nextCursor: null,
      smsUiEnabled: true,
    });

    render(<ReminderSentHistory />);

    await waitFor(() => expect(screen.getByText("Channel")).toBeInTheDocument());
    expect(screen.getByText("SMS")).toBeInTheDocument();
  });

  it("renders the work_order kind as 'Service visit', never 'Work order'", async () => {
    mockFetchOnce({
      items: [item({ id: "wo-row", kind: "work_order", kindLabel: "Service visit" })],
      nextCursor: null,
      smsUiEnabled: false,
    });

    render(<ReminderSentHistory />);

    await waitFor(() => expect(screen.getByText("Service visit")).toBeInTheDocument());
    expect(screen.queryByText(/work order/i)).not.toBeInTheDocument();
  });

  it("renders the exact last_error string for a failed row", async () => {
    const weirdError = 'SMTP 550 5.1.1: mailbox "foo@bar.com" not found — retry budget exhausted after 5 attempts';
    mockFetchOnce({
      items: [
        item({
          id: "failed-row",
          status: "failed",
          sentAtLabel: null,
          lastError: weirdError,
        }),
      ],
      nextCursor: null,
      smsUiEnabled: false,
    });

    render(<ReminderSentHistory />);

    await waitFor(() => expect(screen.getByText(weirdError)).toBeInTheDocument());
  });

  it("shows a loading state, then an empty state when there are no rows", async () => {
    mockFetchOnce({ items: [], nextCursor: null, smsUiEnabled: false });

    render(<ReminderSentHistory />);

    expect(screen.getByText(/loading sent reminders/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/no reminders have been sent yet/i)).toBeInTheDocument());
  });

  it("shows a non-blaming error state on a failed fetch", async () => {
    mockFetchOnce({ error: "Failed to load reminder history." }, false);

    render(<ReminderSentHistory />);

    await waitFor(() => expect(screen.getByText(/did not load/i)).toBeInTheDocument());
    expect(screen.queryByText(/you/i)).not.toBeInTheDocument();
  });
});
