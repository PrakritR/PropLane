// @vitest-environment jsdom
/**
 * Workspace invite sheet: one active manager link per workspace is read on
 * open (or minted when none exists), a role/houses change re-mints it with
 * `replaceActive: true` so an already-shared URL never gains more power, Send
 * stays gated on the input actually parsing to a phone/email/code, and a
 * PropLane-code recipient creates the account-link row directly.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PortalWorkspace } from "@/lib/workspaces/types";

const showToast = vi.fn();

vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast }),
}));

import { WorkspaceInviteSheet } from "@/components/portal/workspace-invite-sheet";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  showToast.mockClear();
});

const workspace: PortalWorkspace = {
  id: "ws-1",
  name: "Acme Portfolio",
  ownerUserId: "owner-1",
  owned: true,
  isDefault: false,
  propertyIds: ["prop-a", "prop-b"],
  propertyLabels: { "prop-a": "House A", "prop-b": "House B" },
  propertyPermissions: {},
  members: [],
};

/** Routes fetch by method + path prefix; each test overrides only what it cares about. */
function mockFetch(overrides: {
  existingLink?: { id: string } | null;
  mintResult?: { url: string; link: { id: string } };
  accountLinksPost?: { ok: boolean; body?: unknown };
}) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });

    if (url.startsWith("/api/pro/invite-links?workspaceId=") && method === "GET") {
      return new Response(JSON.stringify({ link: overrides.existingLink ?? null }), { status: 200 });
    }
    if (url === "/api/pro/invite-links" && method === "POST") {
      const result = overrides.mintResult ?? { url: "https://proplane.test/invite/minted", link: { id: "link-minted" } };
      return new Response(JSON.stringify(result), { status: 200 });
    }
    if (url === "/api/pro/account-links" && method === "GET") {
      return new Response(JSON.stringify({ invites: [] }), { status: 200 });
    }
    if (url === "/api/pro/account-links" && method === "POST") {
      const res = overrides.accountLinksPost ?? { ok: true, body: {} };
      return new Response(JSON.stringify(res.body ?? {}), { status: res.ok ? 200 : 400 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}

/**
 * Advance only the microtask queue (no real timer). `waitFor`'s setTimeout
 * polling, once it resolves, leaves Radix's dismissable-layer outside-pointer
 * listener armed in a way that swallows the next pointerdown on the very
 * trigger it belongs to — a jsdom-only quirk. Awaiting real fetch/json
 * promises through this loop settles the sheet's mount effect without
 * crossing that boundary, so the access menu still opens right after.
 */
async function flushMicrotasks(times = 12) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

function renderSheet(props: Partial<Parameters<typeof WorkspaceInviteSheet>[0]> = {}) {
  return render(
    <WorkspaceInviteSheet
      open
      workspace={workspace}
      onClose={() => {}}
      onChanged={() => {}}
      onEditMember={() => {}}
      {...props}
    />,
  );
}

describe("WorkspaceInviteSheet", () => {
  it("reads the workspace's link on open, then mints one when none exists yet", async () => {
    const { calls } = mockFetch({ existingLink: null });
    renderSheet();

    await waitFor(() =>
      expect(calls.some((c) => c.url === "/api/pro/invite-links" && c.method === "POST")).toBe(true),
    );

    const getCall = calls.find((c) => c.url.startsWith("/api/pro/invite-links?workspaceId="));
    expect(getCall?.url).toContain("workspaceId=ws-1");

    const mintCall = calls.find((c) => c.url === "/api/pro/invite-links" && c.method === "POST");
    expect(mintCall?.body).toMatchObject({
      kind: "manager",
      workspaceId: "ws-1",
      assignedPropertyIds: ["prop-a", "prop-b"],
      teamRole: "viewer",
      houseScope: "all",
    });
  });

  it("skips minting when an active link already exists", async () => {
    const { calls } = mockFetch({ existingLink: { id: "link-existing" } });
    renderSheet();

    await waitFor(() =>
      expect(calls.some((c) => c.url.startsWith("/api/pro/invite-links?workspaceId="))).toBe(true),
    );

    expect(calls.some((c) => c.url === "/api/pro/invite-links" && c.method === "POST")).toBe(false);
  });

  it("re-mints the link with replaceActive: true when the role changes", async () => {
    const { calls } = mockFetch({ existingLink: { id: "link-existing" } });
    renderSheet();
    await flushMicrotasks();
    expect(calls.some((c) => c.url.startsWith("/api/pro/invite-links?workspaceId="))).toBe(true);

    const trigger = document.querySelector('[data-attr="workspace-invite-access"]') as HTMLElement;
    expect(trigger).toBeTruthy();
    fireEvent.pointerDown(trigger, { button: 0, pointerId: 1, isPrimary: true });
    fireEvent.pointerUp(trigger, { button: 0, pointerId: 1, isPrimary: true });
    const roleOption = screen.getByRole("menuitem", { name: "Admin" });
    fireEvent.click(roleOption);
    await flushMicrotasks();

    const remintCall = calls.find((c) => c.url === "/api/pro/invite-links" && c.method === "POST");
    expect(remintCall?.body).toMatchObject({ teamRole: "admin", replaceActive: true });
    expect(showToast).toHaveBeenCalledWith(
      "Link updated. Anyone with the old link will need the new one.",
    );
  });

  it("keeps Send disabled until the recipient parses to a phone, email, or code", async () => {
    mockFetch({ existingLink: { id: "link-existing" } });
    renderSheet();

    const input = screen.getByLabelText("Add people");
    const send = screen.getByRole("button", { name: "Send" });
    expect(send).toBeDisabled();

    fireEvent.change(input, { target: { value: "just a name" } });
    expect(send).toBeDisabled();

    fireEvent.change(input, { target: { value: "someone@example.com" } });
    expect(send).not.toBeDisabled();
  });

  it("POSTs a PropLane-code recipient straight to account-links", async () => {
    const { calls } = mockFetch({ existingLink: { id: "link-existing" } });
    renderSheet();

    const input = screen.getByLabelText("Add people");
    fireEvent.change(input, { target: { value: "PROPLANE-1A2B3C4D" } });
    const send = screen.getByRole("button", { name: "Send" });
    expect(send).not.toBeDisabled();
    fireEvent.click(send);

    await waitFor(() =>
      expect(calls.some((c) => c.url === "/api/pro/account-links" && c.method === "POST")).toBe(true),
    );
    const postCall = calls.find((c) => c.url === "/api/pro/account-links" && c.method === "POST");
    expect(postCall?.body).toMatchObject({
      inviteeAxisId: "PROPLANE-1A2B3C4D",
      tabKind: "manager",
      workspaceId: "ws-1",
      teamRole: "viewer",
      houseScope: "all",
    });
  });
});
