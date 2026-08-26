// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ManagerSmsContactModal } from "@/components/portal/manager-sms-contact-modal";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ManagerSmsContactModal", () => {
  it("saves a named phone contact and returns the server-resolved identity", async () => {
    const onSaved = vi.fn();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      contact: {
        conversationKey: "manager:unknown:+12065550123",
        displayName: "Jordan Lee",
        phone: "+12065550123",
        counterpartyRole: "unknown",
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    render(<ManagerSmsContactModal open onClose={() => {}} onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Jordan Lee" } });
    fireEvent.change(screen.getByLabelText("Phone number"), { target: { value: "(206) 555-0123" } });
    fireEvent.click(screen.getByRole("button", { name: "Save contact" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({
      conversationKey: "manager:unknown:+12065550123",
      displayName: "Jordan Lee",
      phone: "+12065550123",
      counterpartyRole: "unknown",
    }));
    expect(fetchMock).toHaveBeenCalledWith("/api/manager/sms-contacts", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ displayName: "Jordan Lee", phone: "(206) 555-0123" }),
    }));
  });

  it("shows a server validation error without closing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: "Enter a valid phone number, including country code." }),
      { status: 400, headers: { "content-type": "application/json" } },
    )));

    render(<ManagerSmsContactModal open onClose={() => {}} onSaved={() => {}} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Jordan" } });
    fireEvent.change(screen.getByLabelText("Phone number"), { target: { value: "555" } });
    fireEvent.click(screen.getByRole("button", { name: "Save contact" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Enter a valid phone number");
  });
});
