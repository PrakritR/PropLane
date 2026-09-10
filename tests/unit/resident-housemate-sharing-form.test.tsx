// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DEFAULT_HOUSEMATE_SHARING } from "@/lib/resident-housemate-sharing";

vi.mock("@/hooks/use-portal-session", () => ({ usePortalSession: () => ({ userId: "self-id", ready: true }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { ResidentHousemateSharing } from "@/components/portal/resident-housemate-sharing";

beforeEach(() => {
  window.history.replaceState({}, "", "/resident/my-home/housemates");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/resident/housemate-sharing") && (!init || init.method !== "PATCH")) {
        return new Response(JSON.stringify({ preferences: DEFAULT_HOUSEMATE_SHARING }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/api/resident/housemate-sharing") && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ preferences: body }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("renders a settings table and auto-saves on toggle without a save button", async () => {
  const user = userEvent.setup();
  render(<ResidentHousemateSharing />);

  await waitFor(() => expect(screen.queryByText("Loading your choices…")).toBeNull());

  expect(screen.getByRole("heading", { name: "What housemates can see" })).toBeTruthy();
  expect(screen.getByText("Share with my housemates")).toBeTruthy();
  expect(screen.getByRole("columnheader", { name: "Detail" })).toBeTruthy();
  expect(screen.getByRole("columnheader", { name: "Share" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Save sharing choices" })).toBeNull();
  expect(document.body.textContent).not.toContain("Choose which details to share");
  expect(document.body.textContent).not.toContain("Your property manager can still access");

  const nameCheckbox = screen.getByRole("checkbox", { name: "My name" }) as HTMLInputElement;
  expect(nameCheckbox.checked).toBe(false);
  await user.click(nameCheckbox);

  await waitFor(() => expect(screen.getByText("Saved")).toBeTruthy());
  expect(nameCheckbox.checked).toBe(true);
  expect(fetch).toHaveBeenCalledWith(
    "/api/resident/housemate-sharing",
    expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ ...DEFAULT_HOUSEMATE_SHARING, shareName: true }),
    }),
  );
});
