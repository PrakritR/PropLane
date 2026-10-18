// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TextLinkForm } from "@/components/marketing/text-link-form";

const fetchMock = vi.fn();
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const submit = () => fireEvent.submit(screen.getByRole("form", { name: "Text me a demo link" }));

describe("text demo link form", () => {
  it("reads phone and explicit consent from the form and announces confirmed sending", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true })));
    render(<TextLinkForm />);
    fireEvent.change(screen.getByRole("textbox", { name: "Text me a link" }), { target: { value: "+12065550123" } });
    fireEvent.click(screen.getByRole("checkbox"));
    submit();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Text sent. Check your phone."));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ phone: "+12065550123", consent: true });
  });

  it("prevents duplicate submits while the request is pending", async () => {
    let resolve!: (response: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((done) => { resolve = done; }));
    render(<TextLinkForm />);
    submit(); submit();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Send link" })).toBeDisabled();
    resolve(new Response(JSON.stringify({ ok: true })));
    await screen.findByRole("status");
  });

  it("announces transport refusal rather than a fake successful delivery", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "unavailable" }), { status: 503 }));
    render(<TextLinkForm />);
    submit();
    expect(await screen.findByRole("alert")).toHaveTextContent("We couldn't send the text.");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("does not claim failure after an uncertain timeout", async () => {
    fetchMock.mockRejectedValue(new DOMException("Timed out", "TimeoutError"));
    render(<TextLinkForm />);
    submit();
    expect(await screen.findByRole("alert")).toHaveTextContent("Delivery isn't confirmed. Check your phone or open the demo.");
  });

  it("preserves the provider's uncertain-delivery result", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ deliveryUnknown: true }), { status: 503 }));
    render(<TextLinkForm />);
    submit();
    expect(await screen.findByRole("alert")).toHaveTextContent("Delivery isn't confirmed.");
  });
});
