// @vitest-environment jsdom
/**
 * The invite sheet's permissions form: the same Role / Houses / Selected
 * houses / "<Role> can" system Edit permissions renders
 * (`workspace-permissions-fields.tsx`), defaulted to the inviter's own reach,
 * and carrying through unchanged into both the minted link and the emailed/
 * texted/coded invite. Complements `workspace-invite-sheet.test.tsx`, which
 * owns the mint/reveal state machine; this file owns the permissions-form
 * behavior and the "no pills, no subtext" contract for this sheet.
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

function mockFetch(overrides: {
  existingLink?: { id: string; teamRole?: string | null; houseScope?: string | null; assignedPropertyIds?: string[] } | null;
  mintResult?: { url: string; link: { id: string } };
  revealResult?: { url: string };
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
      return new Response(JSON.stringify({}), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}

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
function tapOption(target: Element | Node) {
  fireEvent.pointerDown(target, { pointerId: 1, clientX: 10, clientY: 10 });
  fireEvent.pointerUp(target, { pointerId: 1, clientX: 10, clientY: 10 });
}
function pickRole(label: string) {
  fireEvent.click(document.querySelector('[data-attr="workspace-invite-role"]') as HTMLElement);
  tapOption(within(screen.getByRole("listbox")).getByText(label));
}
function clickCopy() {
  fireEvent.click(document.querySelector('[data-attr="workspace-invite-copy"]') as HTMLElement);
}

describe("Workspace invite — permissions form defaults", () => {
  it("defaults to the workspace's Viewer role and All houses when the inviter's own reach is not scoped", async () => {
    mockFetch({ existingLink: null });
    renderSheet();

    await waitFor(() => expect(roleFieldText()).toContain("Viewer"));
    expect(housesFieldText()).toContain("All houses");
  });

  it("defaults Houses to 'Only selected houses' — never wider than the inviter's own reach — when the viewer is scoped", async () => {
    mockFetch({ existingLink: null });
    renderSheet({ workspace: { ...workspace, viewerHouseScope: "selected" } });

    await waitFor(() => expect(roleFieldText()).toContain("Viewer"));
    expect(housesFieldText()).toContain("Only selected houses");
  });

  it("still defaults to All houses for an owner (unscoped) viewer even when other workspaces exist", async () => {
    mockFetch({ existingLink: null });
    renderSheet({ workspace: { ...workspace, viewerHouseScope: "all" } });

    await waitFor(() => expect(roleFieldText()).toContain("Viewer"));
    expect(housesFieldText()).toContain("All houses");
  });
});

describe("Workspace invite — Copy link and Send carry the same Role/Houses", () => {
  it("Copy link mints with the chosen role and houses, then opens a link view whose Joins-as row matches", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(async () => undefined) } });
    const { calls } = mockFetch({
      existingLink: null,
      mintResult: { url: "https://proplane.test/invite/for-admin", link: { id: "link-admin" } },
    });
    renderSheet();
    await flushMicrotasks();

    pickRole("Admin");
    await flushMicrotasks();

    clickCopy();
    await flushMicrotasks();

    const mintCall = calls.find((c) => c.url === "/api/pro/invite-links" && c.method === "POST");
    expect(mintCall?.body).toMatchObject({
      teamRole: "admin",
      houseScope: "all",
      assignedPropertyIds: ["prop-a", "prop-b"],
    });

    await waitFor(() =>
      expect(document.querySelector('[data-attr="workspace-invite-link-access"]')?.textContent).toContain(
        "Admin",
      ),
    );
    expect(document.querySelector('[data-attr="workspace-invite-link-access"]')?.textContent).toContain(
      "All houses",
    );
  });

  it("changing role after a link was minted mints a NEW link on the next Copy — the old one keeps what it was made with", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(async () => undefined) } });
    const { calls } = mockFetch({
      existingLink: {
        id: "link-existing",
        teamRole: "viewer",
        houseScope: "all",
        assignedPropertyIds: ["prop-a", "prop-b"],
      },
      mintResult: { url: "https://proplane.test/invite/re-minted", link: { id: "link-re-minted" } },
    });
    renderSheet();
    await flushMicrotasks();

    pickRole("Leasing");
    await flushMicrotasks();

    clickCopy();
    await flushMicrotasks();

    const mintCalls = calls.filter((c) => c.url === "/api/pro/invite-links" && c.method === "POST");
    expect(mintCalls).toHaveLength(1);
    expect(mintCalls[0]?.body).toMatchObject({ teamRole: "leasing", replaceActive: true });
    expect(showToast).toHaveBeenCalledWith(
      "Link updated. Anyone with the old link will need the new one.",
    );
  });

  it("Send posts the exact role and houses shown in the form", async () => {
    const { calls } = mockFetch({ existingLink: null });
    renderSheet();
    await flushMicrotasks();

    pickRole("Bookkeeper");
    await flushMicrotasks();

    const input = screen.getByLabelText("Add people");
    fireEvent.change(input, { target: { value: "PROPLANE-9Z9Z9Z9Z" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(calls.some((c) => c.url === "/api/pro/account-links" && c.method === "POST")).toBe(true),
    );
    const postCall = calls.find((c) => c.url === "/api/pro/account-links" && c.method === "POST");
    expect(postCall?.body).toMatchObject({
      teamRole: "bookkeeper",
      houseScope: "all",
      assignedPropertyIds: ["prop-a", "prop-b"],
    });
  });
});

describe("Workspace invite sheet — no pills, no subtext", () => {
  const SHEET_PATH = "src/components/portal/workspace-invite-sheet.tsx";
  const FIELDS_PATH = "src/components/portal/workspace-permissions-fields.tsx";
  const sheetSource = () => readFileSync(join(process.cwd(), SHEET_PATH), "utf8");

  it("removed the 'Will email …' subtext line from the send row", () => {
    expect(sheetSource()).not.toContain("Will email");
  });

  it("Who has access rows carry plain fact text, never a role/reach pill or Badge", () => {
    const source = sheetSource();
    const listStart = source.indexOf('data-attr="workspace-invite-access-list"');
    expect(listStart).toBeGreaterThan(-1);
    const listSection = source.slice(listStart, source.indexOf("</Modal>", listStart));
    expect(listSection).not.toMatch(/<Badge\b/);
    // The old member/owner rows drew a rounded-full role/reach chip; the new
    // rows are one line of fact text with a person avatar and a ⋯ trigger.
    expect(listSection).not.toMatch(/rounded-full bg-primary\/10 px-2 py-0\.5/);
    expect(listSection).toContain("workspace-invite-owner-fact");
    expect(listSection).toContain("workspace-invite-member-fact");
  });

  it("renders a live 'Role can' capability list rather than staying silent for stock roles", () => {
    expect(sheetSource()).toContain("<RoleCapabilitiesList role={role} grant={effectivePermissions} />");
  });

  it("the shared permissions-fields module declares no description/meta subtext prop", () => {
    const fields = readFileSync(join(process.cwd(), FIELDS_PATH), "utf8");
    expect(fields).not.toMatch(/\bdescription\??:\s*string/);
    expect(fields).not.toMatch(/\bmeta\??:\s*string/);
  });
});
