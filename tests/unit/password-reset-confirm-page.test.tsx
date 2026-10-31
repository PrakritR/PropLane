// @vitest-environment jsdom
//
// `/auth/confirm` is where a reset link now lands. It verifies a `token_hash`, which —
// unlike the PKCE `code` the old link carried — is NOT bound to the browser that asked
// for the reset. So this page is the cross-browser path: a link mailed to a phone and
// opened on a laptop has no prior auth storage at all, and must still work.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const verifyOtp = vi.fn();
let search = "";

vi.mock("@/lib/supabase/browser", () => ({
  createSupabaseBrowserClient: () => ({ auth: { verifyOtp } }),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(search),
}));

import ConfirmPage from "@/app/auth/confirm/page";

const TOKEN = "recovery-token-hash";
let replaced: string[] = [];

beforeEach(() => {
  verifyOtp.mockReset();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 409 }));
  replaced = [];
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { replace: (url: string) => void replaced.push(url) },
  });
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("/auth/confirm for a recovery link", () => {
  it("verifies the token with no pre-existing browser state and lands on the reset form", async () => {
    verifyOtp.mockResolvedValue({ error: null });
    search = `token_hash=${TOKEN}&type=recovery`;

    render(<ConfirmPage />);

    await waitFor(() => expect(verifyOtp).toHaveBeenCalledWith({ token_hash: TOKEN, type: "recovery" }));
    await waitFor(() => expect(replaced).toEqual(["/auth/reset-password"]));
  });

  it("explains an expired or already-used link and offers a new one", async () => {
    verifyOtp.mockResolvedValue({ error: { message: "Token has expired or is invalid" } });
    search = `token_hash=${TOKEN}&type=recovery`;

    render(<ConfirmPage />);

    expect(await screen.findByText(/this reset link no longer works/i)).toBeTruthy();
    expect(screen.getByText(/expire after about an hour and can only be used once/i)).toBeTruthy();
    const cta = screen.getByRole("link", { name: /request a new reset link/i });
    expect(cta.getAttribute("href")).toBe("/auth/forgot-password");
    expect(replaced).toEqual([]);
  });

  it("explains a malformed recovery link rather than hanging on the spinner", async () => {
    search = "type=recovery";

    render(<ConfirmPage />);

    expect(await screen.findByText(/this reset link no longer works/i)).toBeTruthy();
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it("leaves non-recovery confirmations on their own copy and destination", async () => {
    verifyOtp.mockResolvedValue({ error: null });
    search = `token_hash=${TOKEN}&type=signup`;

    render(<ConfirmPage />);

    await waitFor(() => expect(replaced).toEqual(["/auth/continue"]));
  });

  it.each([{ status: 500, code: "unexpected_failure", message: "private backend detail" }, { status: 503, message: "private backend detail" }])("offers retry without finishing on provider failure", async (error) => {
    verifyOtp.mockResolvedValue({ error });
    const finish = vi.fn();
    vi.stubGlobal("fetch", finish);
    search = `token_hash=${TOKEN}&type=signup`;
    render(<ConfirmPage />);
    expect(await screen.findByText(/could not complete verification/i)).toBeTruthy();
    expect(screen.queryByText(/private backend detail/i)).toBeNull();
    expect(finish).not.toHaveBeenCalled();
    expect(replaced).toEqual([]);
  });

  it("explains how to restart a legacy application handoff without redirecting elsewhere", async () => {
    verifyOtp.mockResolvedValue({ error: null });
    const finish = vi.fn().mockResolvedValue({ ok: false, status: 403 });
    vi.stubGlobal("fetch", finish);
    search = `token_hash=${TOKEN}&type=signup`;
    render(<ConfirmPage />);
    expect(await screen.findByText(/return to the original application or invitation/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: /open account setup/i })).toBeTruthy();
    expect(replaced).toEqual([]);
    expect(finish).toHaveBeenCalled();
  });

  it("offers retry when onboarding completion is unavailable", async () => {
    verifyOtp.mockResolvedValue({ error: null });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    search = `token_hash=${TOKEN}&type=signup`;
    render(<ConfirmPage />);
    expect(await screen.findByText(/could not complete verification/i)).toBeTruthy();
    expect(replaced).toEqual([]);
  });

  it("shows failure when onboarding completion cannot be reached", async () => {
    verifyOtp.mockResolvedValue({ error: null });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    search = `token_hash=${TOKEN}&type=signup`;
    render(<ConfirmPage />);
    expect(await screen.findByText(/could not complete verification/i)).toBeTruthy();
    expect(replaced).toEqual([]);
  });

  it("retries the same onboarding handoff after a lost finish response", async () => {
    verifyOtp.mockResolvedValue({ error: { message: "Token already used" } }).mockResolvedValueOnce({ error: null });
    const finish = vi.fn().mockResolvedValue({ ok: true, status: 200 }).mockRejectedValueOnce(new Error("connection lost"));
    vi.stubGlobal("fetch", finish);
    search = `token_hash=${TOKEN}&type=signup`;
    const first = render(<ConfirmPage />);
    expect(await screen.findByText(/could not complete verification/i)).toBeTruthy();
    first.unmount();
    render(<ConfirmPage />);
    await waitFor(() => expect(replaced).toEqual(["/auth/continue"]));
    expect(verifyOtp.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(finish.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(finish.mock.calls[1][1].body).toBe(finish.mock.calls[0][1].body);
  });

  it("never takes its destination from a query param", async () => {
    verifyOtp.mockResolvedValue({ error: null });
    search = `token_hash=${TOKEN}&type=recovery&next=https://evil.example.com`;

    render(<ConfirmPage />);

    await waitFor(() => expect(replaced).toEqual(["/auth/reset-password"]));
  });
});
