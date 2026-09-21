// @vitest-environment jsdom
/**
 * Workspace invite sheet: opening the sheet only READS the workspace's
 * active link (hydrating role/houses/permissions from it) and never mints as
 * a side effect. Invite link and Send are the only two actions that can mint
 * — and only when the on-screen Role/Houses no longer match the held link's
 * terms, always with `replaceActive: true`, so an already-shared URL never
 * gains power and the emailed/texted invite always carries the URL it
 * describes. The sheet is ONE view (the "Edit permissions" layout) with an
 * inline link box that appears only for terms that currently resolve to a
 * held link.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PortalWorkspace } from "@/lib/workspaces/types";

const showToast = vi.fn();

vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast }),
}));

const deliverManagerDirectoryMessage = vi.fn(async () => ({ ok: true, message: "sent" }) as const);
const sendWorkspaceInviteSms = vi.fn(async () => ({ ok: true }) as const);
vi.mock("@/lib/manager-vendor-invite-client", () => ({
  deliverManagerDirectoryMessage: (...args: unknown[]) =>
    (deliverManagerDirectoryMessage as unknown as (...a: unknown[]) => unknown)(...args),
  sendWorkspaceInviteSms: (...args: unknown[]) =>
    (sendWorkspaceInviteSms as unknown as (...a: unknown[]) => unknown)(...args),
}));

import { WorkspaceInviteSheet } from "@/components/portal/workspace-invite-sheet";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  showToast.mockClear();
  deliverManagerDirectoryMessage.mockClear();
  sendWorkspaceInviteSms.mockClear();
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

type ExistingLink = {
  id: string;
  teamRole?: string | null;
  houseScope?: string | null;
  assignedPropertyIds?: string[];
  propertyPermissions?: Record<string, unknown>;
  workspacePermissions?: Record<string, unknown>;
} | null;

/** Routes fetch by method + path prefix; each test overrides only what it cares about. */
function mockFetch(overrides: {
  existingLink?: ExistingLink;
  mintResult?: { url: string; link: { id: string } };
  revealResult?: { url: string };
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
    if (/^\/api\/pro\/invite-links\/[^/]+\/link$/.test(url) && method === "POST") {
      const result = overrides.revealResult ?? { url: "https://proplane.test/invite/revealed" };
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
 * crossing that boundary, so the Role menu still opens right after.
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
      inviterName="Jamie Rivera"
      {...props}
    />,
  );
}

function roleTrigger() {
  return screen.getByRole("button", { name: "Role" });
}

function housesTrigger() {
  return screen.getByRole("button", { name: "Houses" });
}

function tap(target: Element) {
  fireEvent.pointerDown(target, { pointerId: 1, clientX: 10, clientY: 10, isPrimary: true });
  fireEvent.pointerUp(target, { pointerId: 1, clientX: 10, clientY: 10, isPrimary: true });
}

/** Opens the Role menu and picks the given option value ("admin", "custom", …). */
function selectRole(value: string) {
  fireEvent.click(roleTrigger());
  const option = document.querySelector(`[data-field-select-option-value="${value}"]`) as HTMLElement;
  tap(option);
}

function clickInviteLink() {
  const btn = document.querySelector('[data-attr="workspace-invite-copy"]') as HTMLElement;
  fireEvent.click(btn);
}

describe("WorkspaceInviteSheet", () => {
  it("reads the workspace's link on open and mints nothing when none exists yet", async () => {
    const { calls } = mockFetch({ existingLink: null });
    renderSheet();

    await waitFor(() =>
      expect(calls.some((c) => c.url.startsWith("/api/pro/invite-links?workspaceId="))).toBe(true),
    );
    await flushMicrotasks();

    const getCall = calls.find((c) => c.url.startsWith("/api/pro/invite-links?workspaceId="));
    expect(getCall?.url).toContain("workspaceId=ws-1");
    expect(calls.some((c) => c.url === "/api/pro/invite-links" && c.method === "POST")).toBe(false);
    expect(roleTrigger().textContent).toContain("Viewer");
    expect(housesTrigger().textContent).toContain("All houses");
  });

  it("hydrates role, houses and permissions from an existing link on open, and mints nothing", async () => {
    const { calls } = mockFetch({
      existingLink: {
        id: "link-existing",
        teamRole: "admin",
        houseScope: "selected",
        assignedPropertyIds: ["prop-b"],
        propertyPermissions: {},
      },
    });
    renderSheet();

    await waitFor(() => expect(roleTrigger().textContent).toContain("Admin"));
    expect(housesTrigger().textContent).toContain("Only selected houses");
    expect(screen.getByText("Selected houses")).toBeTruthy();
    expect(calls.some((c) => c.url === "/api/pro/invite-links" && c.method === "POST")).toBe(false);
  });

  it("Invite link reuses the held link through the reveal path when Role/Houses have not changed", async () => {
    const { calls } = mockFetch({
      existingLink: {
        id: "link-existing",
        teamRole: "viewer",
        houseScope: "all",
        assignedPropertyIds: ["prop-a", "prop-b"],
        propertyPermissions: {},
      },
      revealResult: { url: "https://proplane.test/invite/revealed" },
    });
    renderSheet();
    await waitFor(() =>
      expect(calls.some((c) => c.url.startsWith("/api/pro/invite-links?workspaceId="))).toBe(true),
    );
    await flushMicrotasks();

    clickInviteLink();
    await waitFor(() =>
      expect(
        calls.some((c) => c.url === "/api/pro/invite-links/link-existing/link" && c.method === "POST"),
      ).toBe(true),
    );

    expect(calls.some((c) => c.url === "/api/pro/invite-links" && c.method === "POST")).toBe(false);
    expect(showToast).not.toHaveBeenCalledWith(
      "Link updated. Anyone with the old link will need the new one.",
    );
  });

  it("mints with replaceActive: true, and toasts the replacement, only after the role changes then Invite link is pressed", async () => {
    const { calls } = mockFetch({
      existingLink: {
        id: "link-existing",
        teamRole: "viewer",
        houseScope: "all",
        assignedPropertyIds: ["prop-a", "prop-b"],
        propertyPermissions: {},
      },
    });
    renderSheet();
    await flushMicrotasks();

    selectRole("admin");
    await flushMicrotasks();

    // Changing Role alone never mints.
    expect(calls.some((c) => c.url === "/api/pro/invite-links" && c.method === "POST")).toBe(false);

    clickInviteLink();
    await flushMicrotasks();

    const mintCall = calls.find((c) => c.url === "/api/pro/invite-links" && c.method === "POST");
    expect(mintCall?.body).toMatchObject({ teamRole: "admin", replaceActive: true });
    expect(showToast).toHaveBeenCalledWith(
      "Link updated. Anyone with the old link will need the new one.",
    );
  });

  it("does not toast a replacement the first time a link is ever minted", async () => {
    const { calls } = mockFetch({ existingLink: null });
    renderSheet();
    await waitFor(() =>
      expect(calls.some((c) => c.url.startsWith("/api/pro/invite-links?workspaceId="))).toBe(true),
    );
    await flushMicrotasks();

    clickInviteLink();
    await waitFor(() =>
      expect(calls.some((c) => c.url === "/api/pro/invite-links" && c.method === "POST")).toBe(true),
    );

    expect(showToast).not.toHaveBeenCalledWith(
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

  it("emailing an invite always carries a join URL and names the manager, not the workspace, as the inviter", async () => {
    mockFetch({
      existingLink: {
        id: "link-existing",
        teamRole: "viewer",
        houseScope: "all",
        assignedPropertyIds: ["prop-a", "prop-b"],
        propertyPermissions: {},
      },
      revealResult: { url: "https://proplane.test/invite/revealed" },
    });
    renderSheet({ inviterName: "Jamie Rivera" });
    await waitFor(() => expect(roleTrigger().textContent).toContain("Viewer"));

    const input = screen.getByLabelText("Add people");
    fireEvent.change(input, { target: { value: "someone@example.com" } });
    const send = screen.getByRole("button", { name: "Send" });
    fireEvent.click(send);
    await waitFor(() => expect(deliverManagerDirectoryMessage).toHaveBeenCalledTimes(1));

    const [preview] = deliverManagerDirectoryMessage.mock.calls[0] as [
      { subject: string; body: string },
      ...unknown[],
    ];
    // The manager sends the invite, not the workspace — Low 4.
    expect(preview.subject).toContain("Jamie Rivera");
    expect(preview.body).toContain("Join: https://proplane.test/invite/revealed");
  });

  it("mints a fresh link before emailing when Role/Houses no longer match the held link", async () => {
    const { calls } = mockFetch({
      existingLink: {
        id: "link-existing",
        teamRole: "viewer",
        houseScope: "all",
        assignedPropertyIds: ["prop-a", "prop-b"],
        propertyPermissions: {},
      },
      mintResult: { url: "https://proplane.test/invite/fresh", link: { id: "link-fresh" } },
    });
    renderSheet();
    await flushMicrotasks();

    selectRole("admin");
    await flushMicrotasks();

    const input = screen.getByLabelText("Add people");
    fireEvent.change(input, { target: { value: "someone@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await flushMicrotasks();

    const mintCall = calls.find((c) => c.url === "/api/pro/invite-links" && c.method === "POST");
    expect(mintCall?.body).toMatchObject({ teamRole: "admin", replaceActive: true });
    expect(deliverManagerDirectoryMessage).toHaveBeenCalledTimes(1);
    const [preview] = deliverManagerDirectoryMessage.mock.calls[0] as [{ body: string }, ...unknown[]];
    expect(preview.body).toContain("Join: https://proplane.test/invite/fresh");
  });

  it("texting an invite parses the recipient to E.164 and sends through the manager's work number, not the shared directory path (Info finding)", async () => {
    mockFetch({
      existingLink: {
        id: "link-existing",
        teamRole: "viewer",
        houseScope: "all",
        assignedPropertyIds: ["prop-a", "prop-b"],
        propertyPermissions: {},
      },
      revealResult: { url: "https://proplane.test/invite/revealed" },
    });
    renderSheet();
    await waitFor(() => expect(roleTrigger().textContent).toContain("Viewer"));

    const input = screen.getByLabelText("Add people");
    fireEvent.change(input, { target: { value: "(206) 555-1212" } });
    const send = screen.getByRole("button", { name: "Send" });
    expect(send).not.toBeDisabled();
    fireEvent.click(send);

    await waitFor(() => expect(sendWorkspaceInviteSms).toHaveBeenCalledTimes(1));
    expect(deliverManagerDirectoryMessage).not.toHaveBeenCalled();
    const [payload] = sendWorkspaceInviteSms.mock.calls[0] as [
      { workspaceId: string; phone: string; linkId: string; text?: string },
    ];
    expect(payload.workspaceId).toBe("ws-1");
    expect(payload.phone).toBe("+12065551212");
    // The server composes the text from the link; the client only names it.
    expect(payload.linkId).toBe("link-existing");
    expect(payload.text).toBeUndefined();
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.stringContaining("texted")));
  });

  it("a failed text toasts the real reason and suggests copying the link instead, rather than pretending to send", async () => {
    sendWorkspaceInviteSms.mockResolvedValueOnce({
      ok: false,
      error: "No work number on this account yet. Finish SMS setup under Communication first.",
    });
    mockFetch({
      existingLink: {
        id: "link-existing",
        teamRole: "viewer",
        houseScope: "all",
        assignedPropertyIds: ["prop-a", "prop-b"],
        propertyPermissions: {},
      },
      revealResult: { url: "https://proplane.test/invite/revealed" },
    });
    renderSheet();
    await waitFor(() => expect(roleTrigger().textContent).toContain("Viewer"));

    const input = screen.getByLabelText("Add people");
    fireEvent.change(input, { target: { value: "2065551212" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        "No work number on this account yet. Finish SMS setup under Communication first. Copy the link and send it yourself instead.",
      ),
    );
  });

  it("changing a Custom role's workspace-level grant re-mints instead of reusing the held link (Low finding)", async () => {
    const { calls } = mockFetch({
      existingLink: {
        id: "link-existing",
        teamRole: "custom",
        houseScope: "all",
        assignedPropertyIds: ["prop-a", "prop-b"],
        propertyPermissions: {},
        workspacePermissions: {},
      },
      mintResult: { url: "https://proplane.test/invite/fresh-grant", link: { id: "link-fresh-grant" } },
    });
    renderSheet();
    await waitFor(() => expect(roleTrigger().textContent).toContain("Custom"));
    await flushMicrotasks();

    const addPropertiesCheckbox = document.querySelector(
      '[data-attr="team-grant-add-properties"]',
    ) as HTMLInputElement;
    expect(addPropertiesCheckbox).toBeTruthy();
    fireEvent.click(addPropertiesCheckbox);
    await flushMicrotasks();

    // Toggling the workspace grant alone never mints.
    expect(calls.some((c) => c.url === "/api/pro/invite-links" && c.method === "POST")).toBe(false);

    clickInviteLink();
    await flushMicrotasks();

    const mintCall = calls.find((c) => c.url === "/api/pro/invite-links" && c.method === "POST");
    expect(mintCall?.body).toMatchObject({
      teamRole: "custom",
      replaceActive: true,
      workspacePermissions: { addProperties: true },
    });
  });

  it("Invite link on an unchanged Custom workspace grant still reveals rather than reminting", async () => {
    const { calls } = mockFetch({
      existingLink: {
        id: "link-existing",
        teamRole: "custom",
        houseScope: "all",
        assignedPropertyIds: ["prop-a", "prop-b"],
        propertyPermissions: {},
        workspacePermissions: { teams: true },
      },
      revealResult: { url: "https://proplane.test/invite/revealed-custom" },
    });
    renderSheet();
    await waitFor(() => expect(roleTrigger().textContent).toContain("Custom"));
    await flushMicrotasks();

    clickInviteLink();
    await waitFor(() =>
      expect(
        calls.some((c) => c.url === "/api/pro/invite-links/link-existing/link" && c.method === "POST"),
      ).toBe(true),
    );
    expect(calls.some((c) => c.url === "/api/pro/invite-links" && c.method === "POST")).toBe(false);
  });
});

/**
 * The link box is inline in the SAME view (no second screen): it renders
 * only while the held link's terms still match Role/Houses on screen, and is
 * replaced by a one-line "Access changed" notice the moment they diverge.
 */
describe("WorkspaceInviteSheet — inline link box", () => {
  it("shows no link box until Invite link is pressed", async () => {
    mockFetch({
      existingLink: {
        id: "link-existing",
        teamRole: "viewer",
        houseScope: "all",
        assignedPropertyIds: ["prop-a", "prop-b"],
        propertyPermissions: {},
      },
      revealResult: { url: "https://proplane.test/invite/revealed" },
    });
    renderSheet();
    await waitFor(() => expect(roleTrigger().textContent).toContain("Viewer"));

    expect(document.querySelector('[data-attr="workspace-invite-link-box"]')).toBeNull();
    expect(document.querySelector('[data-attr="workspace-invite-link-stale"]')).toBeNull();
    expect(screen.getByLabelText("Add people")).toBeTruthy();
  });

  it("shows the link box with the URL and 'This link joins as Admin · All houses in …' after pressing, for an Admin role", async () => {
    mockFetch({
      existingLink: {
        id: "link-existing",
        teamRole: "admin",
        houseScope: "all",
        assignedPropertyIds: ["prop-a", "prop-b"],
        propertyPermissions: {},
      },
      revealResult: { url: "https://proplane.test/invite/revealed" },
    });
    renderSheet();
    await waitFor(() => expect(roleTrigger().textContent).toContain("Admin"));

    clickInviteLink();
    await waitFor(() =>
      expect((screen.getByLabelText("Invite link") as HTMLInputElement).value).toBe(
        "https://proplane.test/invite/revealed",
      ),
    );

    const box = document.querySelector('[data-attr="workspace-invite-link-box"]');
    expect(box).toBeTruthy();
    const access = document.querySelector('[data-attr="workspace-invite-link-access"]');
    expect(access?.textContent).toBe("Admin · All houses in Acme Portfolio");
    // The form stays visible — the box is inline, not a second screen.
    expect(screen.getByLabelText("Add people")).toBeTruthy();
  });

  it("changing Role hides the box and shows the 'Access changed' line", async () => {
    mockFetch({
      existingLink: {
        id: "link-existing",
        teamRole: "viewer",
        houseScope: "all",
        assignedPropertyIds: ["prop-a", "prop-b"],
        propertyPermissions: {},
      },
      revealResult: { url: "https://proplane.test/invite/revealed" },
    });
    renderSheet();
    await waitFor(() => expect(roleTrigger().textContent).toContain("Viewer"));

    clickInviteLink();
    await waitFor(() =>
      expect(document.querySelector('[data-attr="workspace-invite-link-box"]')).toBeTruthy(),
    );

    selectRole("admin");
    await flushMicrotasks();

    expect(document.querySelector('[data-attr="workspace-invite-link-box"]')).toBeNull();
    const stale = document.querySelector('[data-attr="workspace-invite-link-stale"]');
    expect(stale?.textContent).toBe("Access changed — press Invite link again for a link with these terms.");
  });

  it("pressing Invite link again mints with the new role (replaceActive: true) and shows the box again", async () => {
    const { calls } = mockFetch({
      existingLink: {
        id: "link-existing",
        teamRole: "viewer",
        houseScope: "all",
        assignedPropertyIds: ["prop-a", "prop-b"],
        propertyPermissions: {},
      },
      revealResult: { url: "https://proplane.test/invite/revealed" },
      mintResult: { url: "https://proplane.test/invite/fresh-admin", link: { id: "link-fresh-admin" } },
    });
    renderSheet();
    await waitFor(() => expect(roleTrigger().textContent).toContain("Viewer"));

    clickInviteLink();
    await waitFor(() =>
      expect(document.querySelector('[data-attr="workspace-invite-link-box"]')).toBeTruthy(),
    );

    selectRole("admin");
    await flushMicrotasks();
    expect(document.querySelector('[data-attr="workspace-invite-link-box"]')).toBeNull();

    clickInviteLink();
    await waitFor(() =>
      expect(calls.some((c) => c.url === "/api/pro/invite-links" && c.method === "POST")).toBe(true),
    );
    await waitFor(() =>
      expect(document.querySelector('[data-attr="workspace-invite-link-box"]')).toBeTruthy(),
    );

    const mintCall = calls.find((c) => c.url === "/api/pro/invite-links" && c.method === "POST");
    expect(mintCall?.body).toMatchObject({ teamRole: "admin", replaceActive: true });
    expect((screen.getByLabelText("Invite link") as HTMLInputElement).value).toBe(
      "https://proplane.test/invite/fresh-admin",
    );
  });

  it("the Copy icon in the link box writes the URL to the clipboard", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    mockFetch({
      existingLink: {
        id: "link-existing",
        teamRole: "viewer",
        houseScope: "all",
        assignedPropertyIds: ["prop-a", "prop-b"],
        propertyPermissions: {},
      },
      revealResult: { url: "https://proplane.test/invite/revealed" },
    });
    renderSheet();
    await waitFor(() => expect(roleTrigger().textContent).toContain("Viewer"));

    clickInviteLink();
    await waitFor(() =>
      expect((screen.getByLabelText("Invite link") as HTMLInputElement).value).toBe(
        "https://proplane.test/invite/revealed",
      ),
    );

    fireEvent.click(document.querySelector('[data-attr="workspace-invite-copy-link"]') as HTMLElement);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("https://proplane.test/invite/revealed"));
    expect(showToast).toHaveBeenCalledWith("Invite link copied.");
  });

  it("pressing Invite link with matching terms twice mints only once", async () => {
    const { calls } = mockFetch({ existingLink: null });
    renderSheet();
    await waitFor(() =>
      expect(calls.some((c) => c.url.startsWith("/api/pro/invite-links?workspaceId="))).toBe(true),
    );
    await flushMicrotasks();

    clickInviteLink();
    await waitFor(() =>
      expect(calls.some((c) => c.url === "/api/pro/invite-links" && c.method === "POST")).toBe(true),
    );
    await waitFor(() => expect(document.querySelector('[data-attr="workspace-invite-link-box"]')).toBeTruthy());

    clickInviteLink();
    await flushMicrotasks();

    const mintCalls = calls.filter((c) => c.url === "/api/pro/invite-links" && c.method === "POST");
    expect(mintCalls).toHaveLength(1);
  });
});

describe("WorkspaceInviteSheet — Edit-permissions layout, no hint, no member list", () => {
  it("renders Role and Houses with the Edit-permissions field selects", async () => {
    mockFetch({ existingLink: { id: "link-existing" } });
    renderSheet();
    await waitFor(() => expect(roleTrigger()).toBeTruthy());
    expect(housesTrigger()).toBeTruthy();
    expect(document.querySelector('[data-attr="co-manager-role"]')).toBeTruthy();
    expect(document.querySelector('[data-attr="workspace-invite-houses"]')).toBeTruthy();
  });

  it("shows no hint line under the recipient field", async () => {
    mockFetch({ existingLink: { id: "link-existing" } });
    renderSheet();

    const input = screen.getByLabelText("Add people");
    fireEvent.change(input, { target: { value: "someone@example.com" } });

    expect(document.querySelector('[data-attr="workspace-invite-hint"]')).toBeNull();
  });

  it("shows no 'Who has access' member list", async () => {
    mockFetch({ existingLink: { id: "link-existing" } });
    renderSheet();
    await waitFor(() => expect(roleTrigger()).toBeTruthy());

    expect(document.querySelector('[data-attr="workspace-invite-access-list"]')).toBeNull();
    expect(screen.queryByText("Who has access")).toBeNull();
  });

  it("footer has Invite link and Send", async () => {
    mockFetch({ existingLink: { id: "link-existing" } });
    renderSheet();
    await waitFor(() => expect(roleTrigger()).toBeTruthy());

    expect(document.querySelector('[data-attr="workspace-invite-copy"]')?.textContent).toContain("Invite link");
    expect(document.querySelector('[data-attr="workspace-invite-send"]')?.textContent).toContain("Send");
  });
});
