// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FinishSetupCard } from "@/components/public/finish-setup-card";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("FinishSetupCard", () => {
  it("shows the bound number's last four as a plain fact and sends no phone", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, { challengeId: "ch1" }));
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<FinishSetupCard token={"S".repeat(43)} kind="landlord" boundPhoneLastFour="4417" />);
    expect(screen.getByText("Finish setup")).toBeTruthy();
    expect(container.querySelector("[data-attr='finish-setup-phone']")?.textContent).toBe("Ending 4417");
    fireEvent.click(screen.getByText("Text me a code"));
    await screen.findByLabelText("Code");
    expect(fetchMock.mock.calls[0]![0]).toBe(`/api/start/${"S".repeat(43)}/send`);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({});
  });

  it("verifies, then offers one explicit button into the portal", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(200, { challengeId: "ch1" }))
      .mockResolvedValueOnce(json(200, { ok: true }))
      .mockResolvedValueOnce(json(200, { portalHref: "/manager" }));
    vi.stubGlobal("fetch", fetchMock);
    render(<FinishSetupCard token={"S".repeat(43)} kind="vendor" boundPhoneLastFour="4417" />);
    fireEvent.click(screen.getByText("Text me a code"));
    fireEvent.change(await screen.findByLabelText("Code"), { target: { value: "123456" } });
    fireEvent.click(screen.getByText("Verify"));
    await waitFor(() => expect(screen.getByText("Go to your vendor portal")).toBeTruthy());
    expect(fetchMock.mock.calls[1]![0]).toBe("/api/auth/phone/verify");
  });
});
