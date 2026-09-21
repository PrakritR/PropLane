// @vitest-environment jsdom
/**
 * Workspace invite sheet: opening the sheet only READS the workspace's
 * active link (hydrating role/houses/permissions from it) and never mints as
 * a side effect. Copy link and Send are the only two actions that can mint —
 * and only when the on-screen Role / Houses fields no longer match the held
 * link's terms, always with `replaceActive: true`, so an already-shared URL
 * never gains power and the emailed/texted invite always carries the URL it
 * describes.
 *
 * The Role and Houses controls are the same `WorkspacePermissionsFields`
 * system Edit permissions renders (two `FieldSingleSelect` dropdowns, not a
 * single combined chip), so these tests drive them the way
 * `field-select-listbox-pick.test.tsx` drives any other `FieldSingleSelect`:
 * click the trigger by its `data-attr`, then tap an option in the resulting
 * listbox.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
 * crossing that boundary, so the Role field still opens right after.
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

function roleFieldText() {
  return document.querySelector('[data-attr="workspace-invite-role"]')?.textContent ?? "";
}

function housesFieldText() {
  return document.querySelector('[data-attr="workspace-invite-houses"]')?.textContent ?? "";
}

/** Tap (pointerdown + pointerup, no drag) — the gesture `FieldSingleSelect`'s listbox requires to pick. */
function tapOption(target: Element | Node) {
  fireEvent.pointerDown(target, { pointerId: 1, clientX: 10, clientY: 10 });
  fireEvent.pointerUp(target, { pointerId: 1, clientX: 10, clientY: 10 });
}

function pickRole(label: string) {
  fireEvent.click(document.querySelector('[data-attr="workspace-invite-role"]') as HTMLElement);
  const listbox = screen.getByRole("listbox");
  tapOption(within(listbox).getByText(label));
}

function pickHouseScope(matcher: string | RegExp) {
  fireEvent.click(document.querySelector('[data-attr="workspace-invite-houses"]') as HTMLElement);
  const listbox = screen.getByRole("listbox");
  tapOption(within(listbox).getByText(matcher));
}

function clickCopy() {
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
    expect(roleFieldText()).toContain("Viewer");
    expect(housesFieldText()).toContain("All houses");
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

    await waitFor(() => expect(roleFieldText()).toContain("Admin"));
    expect(housesFieldText()).toContain("Only selected houses");
    expect(screen.getByText("Selected houses")).toBeTruthy();
    expect(calls.some((c) => c.url === "/api/pro/invite-links" && c.method === "POST")).toBe(false);
  });

  it("Copy link reuses the held link through the reveal path when the Role/Houses fields have not changed", async () => {
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

    clickCopy();
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

  it("mints with replaceActive: true, and toasts the replacement, only after the role changes then Copy is pressed", async () => {
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

    pickRole("Admin");
    await flushMicrotasks();

    // Changing the Role field alone never mints.
    expect(calls.some((c) => c.url === "/api/pro/invite-links" && c.method === "POST")).toBe(false);

    clickCopy();
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

    clickCopy();
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
    await waitFor(() => expect(roleFieldText()).toContain("Viewer"));

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

  it("mints a fresh link before emailing when the Role/Houses fields no longer match the held link", async () => {
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

    pickRole("Admin");
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
    await waitFor(() => expect(roleFieldText()).toContain("Viewer"));

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
    await waitFor(() => expect(roleFieldText()).toContain("Viewer"));

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
    await waitFor(() => expect(roleFieldText()).toContain("Custom"));
    await flushMicrotasks();

    const addPropertiesCheckbox = document.querySelector(
      '[data-attr="team-grant-add-properties"]',
    ) as HTMLInputElement;
    expect(addPropertiesCheckbox).toBeTruthy();
    fireEvent.click(addPropertiesCheckbox);
    await flushMicrotasks();

    // Toggling the workspace grant alone never mints.
    expect(calls.some((c) => c.url === "/api/pro/invite-links" && c.method === "POST")).toBe(false);

    clickCopy();
    await flushMicrotasks();

    const mintCall = calls.find((c) => c.url === "/api/pro/invite-links" && c.method === "POST");
    expect(mintCall?.body).toMatchObject({
      teamRole: "custom",
      replaceActive: true,
      workspacePermissions: { addProperties: true },
    });
  });

  it("Copy on an unchanged Custom workspace grant still reveals rather than reminting", async () => {
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
    await waitFor(() => expect(roleFieldText()).toContain("Custom"));
    await flushMicrotasks();

    clickCopy();
    await waitFor(() =>
      expect(
        calls.some((c) => c.url === "/api/pro/invite-links/link-existing/link" && c.method === "POST"),
      ).toBe(true),
    );
    expect(calls.some((c) => c.url === "/api/pro/invite-links" && c.method === "POST")).toBe(false);
  });
});

/**
 * "Copy link" ([data-attr="workspace-invite-copy"]) resolves the URL, copies
 * it to the clipboard, THEN advances to a second view of the SAME sheet
 * (`view: "link"`) — Back returns to the form with state untouched, Done
 * closes.
 */
describe("WorkspaceInviteSheet — invite link view", () => {
  it("Copy link writes the URL to the clipboard and advances to the link view, hiding the recipient field", async () => {
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
    await waitFor(() => expect(roleFieldText()).toContain("Viewer"));
    expect(screen.getByLabelText("Add people")).toBeTruthy();

    clickCopy();
    await waitFor(() =>
      expect((screen.getByLabelText("Invite link") as HTMLInputElement).value).toBe(
        "https://proplane.test/invite/revealed",
      ),
    );
    expect(writeText).toHaveBeenCalledWith("https://proplane.test/invite/revealed");
    expect(showToast).toHaveBeenCalledWith("Invite link copied.");
    expect(screen.queryByLabelText("Add people")).toBeNull();
    expect(document.querySelector('[data-attr="workspace-invite-role"]')).toBeNull();
  });

  it("the link view's Joins as row reads the same role/houses the form held", async () => {
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
    await waitFor(() => expect(roleFieldText()).toContain("Admin"));

    clickCopy();
    await waitFor(() =>
      expect(document.querySelector('[data-attr="workspace-invite-link-access"]')?.textContent).toContain(
        "Admin",
      ),
    );
    expect(document.querySelector('[data-attr="workspace-invite-link-access"]')?.textContent).toContain(
      "All houses",
    );
  });

  it("the Copy icon in the link view writes the URL to the clipboard again", async () => {
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
    await waitFor(() => expect(roleFieldText()).toContain("Viewer"));

    clickCopy();
    await waitFor(() =>
      expect((screen.getByLabelText("Invite link") as HTMLInputElement).value).toBe(
        "https://proplane.test/invite/revealed",
      ),
    );
    writeText.mockClear();

    fireEvent.click(document.querySelector('[data-attr="workspace-invite-copy-link"]') as HTMLElement);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("https://proplane.test/invite/revealed"));
    expect(showToast).toHaveBeenCalledWith("Invite link copied.");
  });

  it("Back returns to the form view with the previously chosen role still selected", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(async () => undefined) } });
    mockFetch({
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

    pickRole("Admin");
    await flushMicrotasks();

    clickCopy();
    await waitFor(() => expect(screen.getByLabelText("Invite link")).toBeTruthy());

    fireEvent.click(document.querySelector('[data-attr="workspace-invite-back"]') as HTMLElement);
    await flushMicrotasks();

    expect(screen.getByLabelText("Add people")).toBeTruthy();
    expect(roleFieldText()).toContain("Admin");
  });

  it("Done in the link view calls onClose", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(async () => undefined) } });
    const onClose = vi.fn();
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
    renderSheet({ onClose });
    await waitFor(() => expect(roleFieldText()).toContain("Viewer"));

    clickCopy();
    await waitFor(() => expect(screen.getByLabelText("Invite link")).toBeTruthy());

    fireEvent.click(document.querySelector('[data-attr="workspace-invite-done"]') as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("pressing Copy link with matching terms twice mints only once", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(async () => undefined) } });
    const { calls } = mockFetch({ existingLink: null });
    renderSheet();
    await waitFor(() =>
      expect(calls.some((c) => c.url.startsWith("/api/pro/invite-links?workspaceId="))).toBe(true),
    );
    await flushMicrotasks();

    clickCopy();
    await waitFor(() =>
      expect(calls.some((c) => c.url === "/api/pro/invite-links" && c.method === "POST")).toBe(true),
    );
    await waitFor(() => expect(screen.getByLabelText("Invite link")).toBeTruthy());

    fireEvent.click(document.querySelector('[data-attr="workspace-invite-back"]') as HTMLElement);
    await flushMicrotasks();

    clickCopy();
    await flushMicrotasks();

    const mintCalls = calls.filter((c) => c.url === "/api/pro/invite-links" && c.method === "POST");
    expect(mintCalls).toHaveLength(1);
  });
});

describe("WorkspaceInviteSheet — Who has access", () => {
  it("renders member rows as plain fact text, never a role/reach pill, with a ⋯ trigger", async () => {
    mockFetch({ existingLink: { id: "link-existing" } });
    renderSheet({
      workspace: {
        ...workspace,
        members: [
          {
            linkId: "member-1",
            userId: "user-1",
            name: "manager2",
            email: "manager2@test.proplane.local",
            role: "admin",
            houseScope: "all",
            propertyIds: workspace.propertyIds,
            modules: [],
            status: "accepted",
            joinedAt: "2026-09-01T00:00:00.000Z",
            legacyRights: false,
          },
        ],
      },
    });

    await waitFor(() => expect(screen.getByText(/manager2/)).toBeTruthy());
    const fact = document.querySelector('[data-attr="workspace-invite-member-fact"]');
    expect(fact?.textContent).toContain("manager2");
    expect(fact?.textContent).toContain("Admin");
    expect(fact?.textContent).toContain("All houses");
    // No pill/chip element wraps the role or reach text on this row.
    expect(document.querySelector('[data-attr="workspace-invite-member-chip"]')).toBeNull();
    expect(document.querySelector('[data-attr="workspace-invite-member-actions"]')).toBeTruthy();
  });

  it("the ⋯ menu item calls onEditMember with the row's link id (source wiring)", () => {
    // A Radix dropdown nested inside this Modal does not reliably open under
    // jsdom's synthetic pointer/keyboard events once the sheet's own async
    // hydration has re-rendered the tree (a jsdom+Radix FocusScope timing
    // quirk, not a behavior of this component) — see `docs/agents/co-manager-access.md`
    // and the sibling `workspace-permissions-fields.tsx` interactive coverage
    // for the same limitation. Assert the wiring at the source instead.
    const sheet = readFileSync(join(process.cwd(), "src/components/portal/workspace-invite-sheet.tsx"), "utf8");
    expect(sheet).toContain('data-attr="workspace-invite-member-edit"');
    expect(sheet).toContain('onSelect={() => onEditMember(m.linkId)}');
  });

  it("the owner row reads as plain fact text too", async () => {
    mockFetch({ existingLink: { id: "link-existing" } });
    renderSheet();
    await waitFor(() =>
      expect(document.querySelector('[data-attr="workspace-invite-owner-fact"]')?.textContent).toContain(
        "Owner",
      ),
    );
  });
});
