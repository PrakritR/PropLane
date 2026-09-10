// @vitest-environment jsdom
import { StrictMode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import RecoverAccountPage from "@/app/auth/recover-account/page";
vi.mock("@/components/auth/auth-card", () => ({ AuthCard: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("@/components/ui/button", () => ({ Button: ({ children, asChild, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { asChild?: boolean }) => asChild ? <>{children}</> : <button {...props}>{children}</button> }));
vi.mock("@/lib/auth/clear-portal-browser-cache", () => ({ clearPortalBrowserCache: vi.fn() }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState(null, "", "/"); });

const request = { id: "00000000-0000-4000-8000-000000000001", portal: "vendor", state: "retained", expiresAt: "2099-01-01T00:00:00Z", expired: false };
const token = "a".repeat(43);

it("keeps an emailed portal proof through StrictMode and requires explicit Fresh confirmation", async () => {
  window.history.replaceState(null, "", `/auth/recover-account?portal=vendor#request=${request.id}&token=${token}`);
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ request }) });
  vi.stubGlobal("fetch", fetchMock);
  render(<StrictMode><RecoverAccountPage /></StrictMode>);
  const recover = await screen.findByRole("button", { name: "Recover my data" });
  expect(recover).toBeTruthy();
  expect(window.location.hash).toBe("");
  expect(fetchMock.mock.calls.every(call => call[0] === "/api/auth/account-recovery?portal=vendor")).toBe(true);
  const fresh = screen.getByRole("button", { name: "Delete saved data and start fresh" }) as HTMLButtonElement;
  expect(fresh.disabled).toBe(true);
  expect(fetchMock.mock.calls.some(call => call[1]?.method === "POST")).toBe(false);
  fireEvent.click(screen.getByRole("checkbox"));
  expect(fresh.disabled).toBe(false);
  fetchMock.mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ error: "Try again with a new link." }) });
  fireEvent.click(fresh);
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("new link"));
  const post = fetchMock.mock.calls.find(call => call[1]?.method === "POST");
  expect(JSON.parse(post?.[1].body)).toEqual({ action: "fresh", portal: "vendor", requestId: request.id, token, confirm: "DELETE" });
  expect(screen.getByRole("button", { name: "Send a new verification link" })).toBeTruthy();
});

it("never offers a recovery choice after the deadline", async () => {
  window.history.replaceState(null, "", `/auth/recover-account#request=${request.id}&token=${token}`);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ request: { ...request, expired: true } }) }));
  render(<RecoverAccountPage />);
  await screen.findByText(/recovery window has ended/i);
  expect(screen.queryByRole("button", { name: "Recover my data" })).toBeNull();
  expect(screen.queryByRole("checkbox")).toBeNull();
});
