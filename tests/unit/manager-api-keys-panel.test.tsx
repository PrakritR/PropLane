// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ManagerApiKeysPanel } from "@/components/portal/pro-api-keys-panel";

describe("ManagerApiKeysPanel permissions", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("grants an area’s read tools when its Write permission is selected", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/manager/api-keys" && init?.method === "POST") {
        return new Response(JSON.stringify({ token: "pl_live_test" }), { status: 201 });
      }
      return new Response(JSON.stringify({ keys: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<ManagerApiKeysPanel />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "Create API key" }));
    fireEvent.change(screen.getByLabelText("Key name"), { target: { value: "My harness" } });

    const paymentRead = container.querySelector('[data-attr="api-key-payments-read"]') as HTMLInputElement;
    const paymentWrite = container.querySelector('[data-attr="api-key-payments-write"]') as HTMLInputElement;
    expect(paymentRead).not.toBeChecked();
    expect(paymentWrite).not.toBeChecked();
    fireEvent.click(paymentWrite);
    expect(paymentWrite).toBeChecked();
    expect(paymentRead).toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "Create API key", exact: true }));
    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
      expect(post).toBeDefined();
      expect(JSON.parse(String(post![1]?.body))).toMatchObject({
        transport: "api",
        allowedTools: expect.arrayContaining(["list_charges", "create_charge"]),
      });
    });
  });
});
