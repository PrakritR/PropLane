// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TextLinkForm } from "@/components/marketing/text-link-form";

const fetchMock = vi.fn();
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const submit = () => fireEvent.submit(screen.getByRole("form", { name: "Text me a link" }));

describe("text demo link form", () => {
  it("texts a code first, then asks for it and announces the link only after verification", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, codeSent: true })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));
    render(<TextLinkForm />);
    fireEvent.change(screen.getByRole("textbox", { name: "Text me a link" }), { target: { value: "+12065550123" } });
    fireEvent.click(screen.getByRole("checkbox"));
    submit();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("We texted you a code."));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ phone: "+12065550123", consent: true });
    fireEvent.change(screen.getByLabelText("Code"), { target: { value: "123456" } });
    submit();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Text sent. Check your phone."));
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ phone: "+12065550123", action: "verify", otp: "123456" });
  });

  it("says so when the code did not work and keeps the code field", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, codeSent: true })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "x" }), { status: 400 }));
    render(<TextLinkForm />);
    fireEvent.change(screen.getByRole("textbox", { name: "Text me a link" }), { target: { value: "+12065550123" } });
    submit();
    await screen.findByLabelText("Code");
    fireEvent.change(screen.getByLabelText("Code"), { target: { value: "000000" } });
    submit();
    expect(await screen.findByRole("alert")).toHaveTextContent("That code did not work.");
    expect(screen.getByLabelText("Code")).toBeInTheDocument();
  });

  it("prevents duplicate submits while the request is pending", async () => {
    let resolve!: (response: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((done) => { resolve = done; }));
    render(<TextLinkForm />);
    submit(); submit();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Send link" })).toBeDisabled();
    resolve(new Response(JSON.stringify({ ok: true, codeSent: true })));
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
    expect(await screen.findByRole("alert")).toHaveTextContent("Delivery isn't confirmed. Check your phone or view the dashboard.");
  });

  it("preserves the provider's uncertain-delivery result", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ deliveryUnknown: true }), { status: 503 }));
    render(<TextLinkForm />);
    submit();
    expect(await screen.findByRole("alert")).toHaveTextContent("Delivery isn't confirmed.");
  });
});
