// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PortalTextNotificationsBlock } from "@/components/portal/portal-text-notifications-block";

const { sharedGet } = vi.hoisted(() => ({ sharedGet: vi.fn() }));
vi.mock("@/lib/shared-get-cache", () => ({ sharedGet }));
vi.mock("@/components/providers/app-ui-provider", () => ({ useAppUi: () => ({ showToast: vi.fn() }) }));
vi.mock("@/lib/analytics/track-client", () => ({ track: vi.fn() }));
vi.mock("@/components/ui/modal", () => ({ Modal: () => null }));

const fetchMock = vi.fn();
beforeEach(() => {
  sharedGet.mockReset().mockResolvedValue({ ok: true, data: { enabled: false } });
  fetchMock.mockReset().mockResolvedValue(new Response(JSON.stringify({
    phone: "+14255550123", phoneVerifiedAt: "2026-10-18T00:00:00Z", smsConfigured: true,
  })));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("shared phone settings entry", () => {
  it("links a verified phone to the old-and-new-code flow in shared mode", async () => {
    sharedGet.mockResolvedValue({ ok: true, data: { enabled: true } });
    render(<PortalTextNotificationsBlock dataAttrPrefix="resident" />);
    expect(await screen.findByRole("link", { name: "Change phone" })).toHaveAttribute("href", "/auth/verify-phone");
    expect(screen.queryByRole("button", { name: "Change" })).not.toBeInTheDocument();
    expect(sharedGet).toHaveBeenCalledTimes(1);
    expect(sharedGet).toHaveBeenCalledWith("/api/auth/phone");
  });

  it("makes the compact settings row itself a verification link in shared mode", async () => {
    sharedGet.mockResolvedValue({ ok: true, data: { enabled: true } });
    render(<PortalTextNotificationsBlock dataAttrPrefix="vendor" compact />);
    expect(await screen.findByRole("link", { name: /Personal phone/ })).toHaveAttribute("href", "/auth/verify-phone");
    expect(screen.queryByRole("button", { name: /Personal phone/ })).not.toBeInTheDocument();
  });

  it("retains the existing phone editor when the shared-line flag is off", async () => {
    render(<PortalTextNotificationsBlock dataAttrPrefix="resident" />);
    fireEvent.click(await screen.findByRole("button", { name: "Change" }));
    expect(screen.getByRole("button", { name: "Send code" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Change phone" })).not.toBeInTheDocument();
  });

  it("retains legacy controls when the rollout flag cannot be read", async () => {
    sharedGet.mockResolvedValue({ ok: false, status: 503, data: null });
    render(<PortalTextNotificationsBlock dataAttrPrefix="resident" />);
    await screen.findByRole("button", { name: "Change" });
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("does not call the real auth or phone endpoints in demo mode", async () => {
    render(<PortalTextNotificationsBlock dataAttrPrefix="vendor" demo />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Send code" })).toBeInTheDocument());
    expect(sharedGet).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
