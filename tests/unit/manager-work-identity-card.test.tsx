// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { ManagerMessagingNumberStatus } from "@/lib/sms/manager-messaging-number";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const statusState = vi.fn();
const toast = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/use-manager-messaging-number-status", () => ({
  useManagerMessagingNumberStatus: () => statusState(),
}));
vi.mock("@/lib/demo/demo-session", () => ({
  isDemoModeActive: () => false,
}));

vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast: toast }),
}));
// The shell (Radix / Vaul presentation) is not what this file covers: a plain stand-in renders the same title, body and footer.
vi.mock("@/components/ui/modal", () => ({
  Modal: ({ open, title, children, footer }: { open: boolean; title: React.ReactNode; children: React.ReactNode; footer?: React.ReactNode }) =>
    open ? (
      <div role="dialog" aria-label={String(title)}>
        {children}
        {footer}
      </div>
    ) : null,
  ModalFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { ManagerWorkNumberCard } from "@/components/portal/pro-work-number-card";
import { resetSharedGets } from "@/lib/shared-get-cache";

function status(overrides: Partial<ManagerMessagingNumberStatus> = {}): ManagerMessagingNumberStatus {
  return {
    mode: "automatic",
    workspaceRole: "primary",
    provisioningAvailable: true,
    sendingAvailable: true,
    planTier: "paid",
    entitlement: { eligible: true, tier: "pro", source: "stripe" },
    number: {
      state: "active",
      registrationState: "approved",
      carrierRegistrationState: "registered",
      attachmentState: "attached",
      phoneNumber: "+12069228062",
      lastError: null,
    },
    canRequest: false,
    requestedAtSignup: false,
    canSend: true,
    personalPhone: { phone: null, verifiedAt: null, forwardInbound: false },
    ...overrides,
  };
}

function assistantEmailPayload(address: string | null) {
  return {
    provisioningAvailable: true,
    sendingAvailable: true,
    receivingAvailable: true,
    storageReady: true,
    planTier: "paid",
    entitlement: { eligible: true, tier: "pro", source: "stripe" },
    workspaceRole: "primary",
    workspaceEmail: address ? { address, ownerUserId: "mgr-test", ownerName: "Alex" } : null,
    address,
    state: address ? "ready" : "unavailable",
    canRequest: false,
    canUse: Boolean(address),
    requestedAtSignup: false,
  };
}

function stubEmail(address: string | null) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("/api/manager/assistant-email")) {
        return Response.json(assistantEmailPayload(address));
      }
      return new Response(null, { status: 404 });
    }),
  );
}

afterEach(() => {
  // The work email is read through sharedGet; one test's answer must not serve the next.
  resetSharedGets();
  cleanup();
  vi.unstubAllGlobals();
  statusState.mockReset();
});

describe("ManagerWorkNumberCard identity", () => {
  it("shows work email on its own box and has no phone glyph", async () => {
    statusState.mockReturnValue({
      ready: true,
      resolved: true,
      statusError: false,
      status: status(),
      retry: () => {},
    });
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    stubEmail("inbox@axis.housing");

    render(<ManagerWorkNumberCard />);

    await waitFor(() => {
      expect(screen.getByText("inbox@axis.housing")).toBeTruthy();
    });
    expect(screen.getByTitle(/Work number:/)).toBeTruthy();
    expect(screen.getByTitle(/Work email:/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Tell residents" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Tell residents about this number" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Set up messaging" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Copy email" }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("inbox@axis.housing");
    });
    expect(screen.queryByText(/Ready to send/i)).toBeNull();
  });

  it("keeps a Set up work email box when the workspace has no address", async () => {
    statusState.mockReturnValue({
      ready: true,
      resolved: true,
      statusError: false,
      status: status(),
      retry: () => {},
    });
    stubEmail(null);

    render(<ManagerWorkNumberCard />);

    await waitFor(() => {
      expect(screen.getByText("Set up work email")).toBeTruthy();
    });
    expect(screen.getByTitle(/Work number:/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /Set up work email/ }).getAttribute("href")).toBe(
      "/portal/profile?tab=messaging",
    );
  });

  it("renders setup boxes in the live identity slots when nothing is assigned", async () => {
    statusState.mockReturnValue({
      ready: true,
      resolved: true,
      statusError: false,
      status: status({
        number: null,
        canSend: false,
      }),
      retry: () => {},
    });
    stubEmail(null);

    render(<ManagerWorkNumberCard />);

    await waitFor(() => {
      expect(screen.getByText("Set up work number")).toBeTruthy();
      expect(screen.getByText("Set up work email")).toBeTruthy();
    });
    expect(screen.getByRole("link", { name: /Set up work number/ }).getAttribute("data-attr")).toBe(
      "manager-work-number-setup",
    );
    expect(screen.getByRole("link", { name: /Set up work email/ }).getAttribute("data-attr")).toBe(
      "manager-work-email-setup",
    );
  });
});

describe("ManagerWorkNumberCard work email edit", () => {
  function stubEditableEmail(canEditAddress: boolean | undefined) {
    let address = "ambikahomes@proplane.ai";
    const posts: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.url;
        if (!url.includes("/api/manager/assistant-email")) return new Response(null, { status: 404 });
        if (init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          posts.push(body);
          if (body.action === "check_address") {
            return Response.json(body.local === "taken" ? { ok: false, state: "taken", message: "That address is already in use." } : { ok: true, state: "available" });
          }
          address = `${body.local}@proplane.ai`;
          return Response.json({ ...assistantEmailPayload(address), canEditAddress });
        }
        return Response.json({ ...assistantEmailPayload(address), workspaceRole: "co_manager", canEditAddress });
      }),
    );
    return { posts };
  }
  const mountCard = () => {
    statusState.mockReturnValue({ ready: true, resolved: true, statusError: false, status: status(), retry: () => {} });
    render(<ManagerWorkNumberCard />);
  };

  it("shows no Edit icon unless the server says the viewer may edit the address", async () => {
    stubEditableEmail(false);
    mountCard();
    await waitFor(() => expect(screen.getByText("ambikahomes@proplane.ai")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    cleanup();
    resetSharedGets();
    stubEditableEmail(undefined);
    mountCard();
    await waitFor(() => expect(screen.getByText("ambikahomes@proplane.ai")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  });

  it("opens a modal from the Edit icon, checks availability live and saves the new address", async () => {
    const { posts } = stubEditableEmail(true);
    mountCard();
    const edit = await screen.findByRole("button", { name: "Edit" });
    expect(edit.getAttribute("data-attr")).toBe("manager-work-email-edit");
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(edit);
    const input = (await screen.findByLabelText("Address")) as HTMLInputElement;
    expect(input.value).toBe("ambikahomes");
    expect(screen.getByText("@proplane.ai")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(input, { target: { value: "taken" } });
    await waitFor(() => expect(screen.getByText("Taken")).toBeTruthy());
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(input, { target: { value: "ambika.front" } });
    await waitFor(() => expect(screen.getByText("Available")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(posts.some((p) => p.action === "set_address")).toBe(true));
    expect(posts.find((p) => p.action === "set_address")).toMatchObject({ local: "ambika.front" });
    await waitFor(() => expect(screen.getByText("ambika.front@proplane.ai")).toBeTruthy());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(toast).toHaveBeenCalledWith("Work email changed to ambika.front@proplane.ai.");
  });
});
