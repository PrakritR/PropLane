// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PropertyTextCodeRow } from "@/components/portal/property-text-code-row";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PropertyTextCodeRow", () => {
  it("draws nothing at all while the line is per-workspace (the route answers 404)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(404, { error: "Not available." }));
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<PropertyTextCodeRow propertyId="prop-1" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container.textContent).toBe("");
    expect(container.querySelector("button")).toBeNull();
  });

  it("shows the full call to action with copy icons for a live code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json(200, {
          sharedNumber: "+12065550100",
          suggestion: null,
          codes: [{ code: "BROOKLYN5", propertyId: "prop-1", active: true, callToAction: "Text BROOKLYN5 to (206) 555-0100", smsLink: "sms:+12065550100?&body=BROOKLYN5" }],
        }),
      ),
    );
    render(<PropertyTextCodeRow propertyId="prop-1" />);
    expect(await screen.findByText("Text BROOKLYN5 to (206) 555-0100")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy text code" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy text link" })).toBeTruthy();
  });

  it("offers the suggested code when there is none and creates it with one tap", async () => {
    const created = { code: { code: "BROOKLYN5", propertyId: "prop-1", active: true, callToAction: "Text BROOKLYN5 to (206) 555-0100", smsLink: "sms:+12065550100?&body=BROOKLYN5" } };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(200, { sharedNumber: "+12065550100", codes: [], suggestion: "BROOKLYN5" }))
      .mockResolvedValueOnce(json(201, created))
      .mockResolvedValueOnce(json(200, { sharedNumber: "+12065550100", codes: [created.code], suggestion: null }));
    vi.stubGlobal("fetch", fetchMock);
    render(<PropertyTextCodeRow propertyId="prop-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Create BROOKLYN5" }));
    await screen.findByText("Text BROOKLYN5 to (206) 555-0100");
    const [, init] = fetchMock.mock.calls[1]!;
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ propertyId: "prop-1", code: "BROOKLYN5" });
  });
});
