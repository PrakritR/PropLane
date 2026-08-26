// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const showToast = vi.fn();

vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast }),
}));
vi.mock("@/components/portal/manager-sms-compose-modal", () => ({
  ManagerSmsComposeModal: () => null,
}));

import { ManagerSmsPanel } from "@/components/portal/manager-sms-panel";

const ROW_ID = "mgr-1:resident:res-1";
const PAYLOAD = {
  workNumber: "+12065550999",
  personalPhone: null,
  phoneVerified: false,
  forwardInbound: true,
  smsConfigured: true,
  residents: [
    {
      residentUserId: "res-1",
      residentEmail: "jane@example.com",
      name: "Jane Resident",
      phone: "+12065550100",
      propertyLabel: "Unit A",
      tenancyStatus: "resident" as const,
      counterpartyRole: "resident" as const,
      conversationKey: ROW_ID,
      ownerManagerUserId: "mgr-1",
      messages: [
        {
          id: "m1",
          direction: "inbound" as const,
          body: "Hello",
          fromPhone: "+12065550100",
          toPhone: "+12065550999",
          messageSid: "SM1",
          source: "work_number" as const,
          createdAt: "2026-07-20T00:00:00.000Z",
          storageTable: "inbound_sms_log" as const,
        },
      ],
    },
  ],
};

beforeEach(() => {
  const store: Record<string, string> = {};
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
  });
});

afterEach(() => {
  cleanup();
  showToast.mockClear();
  vi.unstubAllGlobals();
});

async function submitReply() {
  render(
    <ManagerSmsPanel
      suppressListPane
      controlledActiveId={ROW_ID}
      allowInlineCompose={false}
    />,
  );
  const input = await screen.findByPlaceholderText("Text message");
  fireEvent.change(input, { target: { value: "Checking in" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  return input;
}

async function submitReplyOverBothChannels() {
  render(
    <ManagerSmsPanel
      suppressListPane
      controlledActiveId={ROW_ID}
      allowInlineCompose={false}
    />,
  );
  const picker = await screen.findByLabelText("Send via");
  fireEvent.click(picker);
  fireEvent.pointerDown(
    await screen.findByRole("option", { name: /^Email$/i }),
  );
  await waitFor(() => expect(picker.textContent).toContain("Email & SMS"));
  const input = await screen.findByPlaceholderText("Write a reply…");
  fireEvent.change(input, { target: { value: "Checking in" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  return input;
}

describe("ManagerSmsPanel ambiguous manual sends", () => {
  it("keeps the draft and removes the optimistic success when the provider outcome is unknown", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") {
          return Response.json(
            {
              code: "delivery_outcome_unknown",
              status: "unknown",
            },
            { status: 409 },
          );
        }
        return Response.json(PAYLOAD);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const input = await submitReply();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/Do not resend this message/i);
    expect(alert).toHaveTextContent(
      /operator review.*check the conversation later/i,
    );
    expect(input).toHaveValue("Checking in");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    await waitFor(() => expect(screen.queryByText("Sending…")).toBeNull());

    const postCall = fetchMock.mock.calls.find(
      ([, init]) => init?.method === "POST",
    );
    const headers = postCall?.[1]?.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toMatch(/^manual_[A-Za-z0-9_-]+_0$/);
    expect(showToast).not.toHaveBeenCalledWith(
      expect.stringMatching(/try again/i),
    );
  });

  it("treats a network failure as unknown without clearing the draft", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") throw new TypeError("network failed");
        return Response.json(PAYLOAD);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const input = await submitReply();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      /could not confirm whether the provider received/i,
    );
    expect(alert).toHaveTextContent(/Do not resend/i);
    expect(input).toHaveValue("Checking in");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    await waitFor(() => expect(screen.queryByText("Sending…")).toBeNull());
    expect(showToast).not.toHaveBeenCalledWith(
      expect.stringMatching(/try again/i),
    );
  });
});

describe("ManagerSmsPanel partial channel outcomes", () => {
  it("reports email success without claiming a refused text was sent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "POST" && url.includes("sms-conversations")) {
          return Response.json({ error: "text unavailable" }, { status: 503 });
        }
        if (init?.method === "POST" && url.includes("send-inbox-message")) {
          return Response.json({ ok: true });
        }
        return Response.json(PAYLOAD);
      }),
    );

    const input = await submitReplyOverBothChannels();

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        "Email sent. Text message failed.",
      ),
    );
    expect(input).toHaveValue("");
  });

  it("reports text success without claiming a refused email was sent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "POST" && url.includes("sms-conversations")) {
          return Response.json({ ok: true, status: "submitted" });
        }
        if (init?.method === "POST" && url.includes("send-inbox-message")) {
          return Response.json({ error: "email unavailable" }, { status: 503 });
        }
        return Response.json(PAYLOAD);
      }),
    );

    const input = await submitReplyOverBothChannels();

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        "Text message sent. Email failed.",
      ),
    );
    expect(input).toHaveValue("");
  });
});
