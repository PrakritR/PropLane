/** Client side of admin Communication's workspace placement: URLs, row labels, Open in workspace, Assign. */
import { describe, expect, it, vi } from "vitest";
import {
  adminSmsConversationsUrl,
  adminWorkspaceThreadHref,
  assignLeadToServiceWorkspace,
  openAdminWorkspaceThread,
  publishAdminSmsWorkspaces,
} from "@/lib/admin-sms-workspaces";
import { normalizeManagerSmsConversationsPayload } from "@/lib/manager-sms-messages";

const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("urls", () => {
  it("the text stream URL carries the Workspace filter only when one is set", () => {
    expect(adminSmsConversationsUrl("")).toBe("/api/admin/sms-conversations");
    expect(adminSmsConversationsUrl("  ")).toBe("/api/admin/sms-conversations");
    expect(adminSmsConversationsUrl(WS)).toBe(`/api/admin/sms-conversations?workspaceId=${WS}`);
    expect(adminSmsConversationsUrl("unassigned")).toBe("/api/admin/sms-conversations?workspaceId=unassigned");
  });

  it("Open in workspace lands on the property portal's Communication for that conversation", () => {
    expect(adminWorkspaceThreadHref("owner:prospect:+1206")).toBe("/portal/communication/active/owner%3Aprospect%3A%2B1206");
    expect(adminWorkspaceThreadHref("")).toBe("/portal/communication/active");
    expect(adminWorkspaceThreadHref(null)).toBe("/portal/communication/active");
  });
});

describe("row payload", () => {
  const base = { name: "Pat", directoryName: null, savedContactName: null, propertyLabel: null, residentEmail: null, phone: "+12065550123" };

  it("the payload normalizer keeps the placement the server sent", () => {
    const out = normalizeManagerSmsConversationsPayload({
      residents: [
        { ...base, workspaceId: WS, workspaceName: "1. Ambika", messages: [] },
        { ...base, name: "Lead", phone: null, workspaceId: null, unassignedLeadId: "lead-1", messages: [] },
        { ...base, name: "Manager row", messages: [] },
      ] as never,
    });
    expect(out.residents[0]).toMatchObject({ workspaceId: WS, workspaceName: "1. Ambika" });
    expect(out.residents[1]).toMatchObject({ workspaceId: null, unassignedLeadId: "lead-1" });
    // A surface that never sets a workspace (the manager's) is unchanged: no key at all.
    expect("workspaceId" in out.residents[2]!).toBe(false);
  });
});

describe("Open in workspace", () => {
  it("opens the workspace (cookie set server-side), picks the manager portal, then goes to the thread", async () => {
    const calls: Array<[string, unknown]> = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push([url, JSON.parse(String(init?.body))]);
      return Response.json({ ok: true, href: "/portal/properties" });
    });
    const navigate = vi.fn();
    const result = await openAdminWorkspaceThread({ workspaceId: WS, conversationKey: "k1" }, { fetch, navigate });
    expect(result).toEqual({ ok: true, href: "/portal/communication/active/k1" });
    expect(calls).toEqual([
      ["/api/admin/service-workspaces", { action: "open", id: WS }],
      // `keepWorkspace`: Open just set the workspace cookie on purpose, and a plain switch would drop it.
      ["/api/auth/set-active-portal", { role: "manager", keepWorkspace: true }],
    ]);
    expect(navigate).toHaveBeenCalledWith("/portal/communication/active/k1");
  });

  it("a refused open navigates nowhere and returns the server's reason", async () => {
    const navigate = vi.fn();
    const fetch = vi.fn(async () => Response.json({ error: "Service workspace not found." }, { status: 404 }));
    expect(await openAdminWorkspaceThread({ workspaceId: WS }, { fetch, navigate })).toEqual({ ok: false, error: "Service workspace not found." });
    expect(fetch).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe("Assign", () => {
  it("PATCHes the lead with the workspace chosen", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ ok: true }));
    expect(await assignLeadToServiceWorkspace({ leadId: "lead-1", workspaceId: WS }, { fetch })).toEqual({ ok: true });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("/api/admin/unassigned-leads/lead-1");
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual({ action: "assign", workspaceId: WS });
  });

  it("returns the refusal", async () => {
    const fetch = vi.fn(async () => Response.json({ error: "Lead is not open." }, { status: 409 }));
    expect(await assignLeadToServiceWorkspace({ leadId: "lead-1", workspaceId: WS }, { fetch })).toEqual({ ok: false, error: "Lead is not open." });
  });
});

describe("the workspace list store", () => {
  it("keeps only well-formed entries", () => {
    expect(() => publishAdminSmsWorkspaces([{ id: WS, name: "A" }, { id: 3 }, null])).not.toThrow();
    expect(() => publishAdminSmsWorkspaces("nope")).not.toThrow();
  });
});
