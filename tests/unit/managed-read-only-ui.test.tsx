// @vitest-environment jsdom
/**
 * A PropLane-managed workspace is view-only for its owner (`PortalWorkspace.readOnly`, derived on the server). The UI half:
 * no create action, no edit chrome, no write entries in a row menu, no wizard, one strip under the top bar, and a
 * `data-read-only="managed"` backstop on the root. The server stays the authority; none of this is the boundary.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render as rtlRender, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { Pencil, Plus, SlidersHorizontal, Trash2 } from "lucide-react";
import type { PortalWorkspace } from "@/lib/workspaces/types";
import { resolveAddPropertyWorkspaceAction } from "@/lib/workspaces/add-property-gate";
import { isWriteActionLabel, readOnlyMenuLabelAllowed } from "@/lib/workspaces/read-only";

const ctx = vi.hoisted(() => ({ active: null as Partial<PortalWorkspace> | null }));
vi.mock("@/components/portal/workspace-provider", () => ({
  useWorkspaces: () => (ctx.active ? { active: ctx.active, workspaces: [ctx.active], loading: false } : null),
}));

import { PortalReadOnlyContext } from "@/components/portal/portal-read-only-context";
import { PortalReadOnlyProvider } from "@/components/portal/portal-read-only";
import { PortalIconAction, PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ManagedReadOnlyStrip } from "@/components/portal/managed-read-only-strip";

/** Renders under the same context the portal layout provides: read-only exactly when the active workspace says so. */
function render(ui: ReactElement) {
  return rtlRender(<PortalReadOnlyContext.Provider value={ctx.active?.readOnly === true}>{ui}</PortalReadOnlyContext.Provider>);
}

const owned = (over: Partial<PortalWorkspace> = {}): Partial<PortalWorkspace> => ({
  id: "ws-1",
  ownerUserId: "owner-1",
  name: "Ambika Homes",
  owned: true,
  canAddProperties: true,
  ...over,
});

beforeEach(() => {
  ctx.active = null;
});
afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-read-only");
});

describe("a read-only workspace yields no create action", () => {
  it("returns read-only (never open / switch / no-owned) for an owned workspace marked readOnly", () => {
    const ws = { id: "ws-1", owned: true, canAddProperties: true, readOnly: true };
    expect(resolveAddPropertyWorkspaceAction({ loading: false, active: ws, workspaces: [ws] })).toEqual({ kind: "read-only" });
  });

  it("does not switch to another workspace while the active one is read-only", () => {
    const active = { id: "ws-1", owned: true, readOnly: true };
    const other = { id: "ws-2", owned: true, readOnly: false };
    expect(resolveAddPropertyWorkspaceAction({ loading: false, active, workspaces: [active, other] })).toEqual({ kind: "read-only" });
  });

  it("leaves a normal workspace exactly as before", () => {
    const ws = { id: "ws-1", owned: true, canAddProperties: false };
    expect(resolveAddPropertyWorkspaceAction({ loading: false, active: ws, workspaces: [ws] })).toEqual({ kind: "open" });
    expect(resolveAddPropertyWorkspaceAction({ loading: true, active: ws, workspaces: [ws] })).toEqual({ kind: "wait" });
    expect(resolveAddPropertyWorkspaceAction(null)).toEqual({ kind: "open" });
  });
});

describe("the round blue + and the edit chrome", () => {
  it("draws the page's create action for a normal workspace and nowhere else", () => {
    ctx.active = owned();
    render(<PortalPrimaryIconAction label="Add property" icon={Plus} />);
    expect(screen.getByRole("button", { name: "Add property" })).toBeTruthy();
    cleanup();
    ctx.active = null;
    render(<PortalPrimaryIconAction label="Add property" />);
    expect(screen.getByRole("button", { name: "Add property" })).toBeTruthy();
  });

  it("draws no create action on a read-only workspace", () => {
    ctx.active = owned({ readOnly: true });
    render(<PortalPrimaryIconAction label="Add property" />);
    expect(screen.queryByRole("button", { name: "Add property" })).toBeNull();
  });

  it("hides Edit and Delete header actions on a read-only workspace but keeps Filter", () => {
    ctx.active = owned({ readOnly: true });
    render(
      <>
        <PortalIconAction icon={Pencil} label="Edit" />
        <PortalIconAction icon={Trash2} label="Delete" />
        <PortalIconAction icon={SlidersHorizontal} label="Filter" />
      </>,
    );
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(screen.getByRole("button", { name: "Filter" })).toBeTruthy();
  });

  it("shows Edit and Delete on a normal workspace", () => {
    ctx.active = owned();
    render(
      <>
        <PortalIconAction icon={Pencil} label="Edit" />
        <PortalIconAction icon={Trash2} label="Delete" />
      </>,
    );
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
  });

  it("classifies labels: writes hidden, looking kept", () => {
    for (const label of ["Edit", "Delete", "Archive", "Add resident", "Upload", "Invite"]) expect(isWriteActionLabel(label), label).toBe(true);
    for (const label of ["Filter", "Share", "Download", "Settings", "Copy link"]) expect(isWriteActionLabel(label), label).toBe(false);
  });
});

describe("row ⋯ menus", () => {
  function Menu() {
    return (
      <DropdownMenu open>
        <DropdownMenuTrigger asChild>
          <button type="button">Actions</button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>View</DropdownMenuItem>
          <DropdownMenuItem>Open booking</DropdownMenuItem>
          <DropdownMenuItem>Download PDF</DropdownMenuItem>
          <DropdownMenuItem>Edit pricing</DropdownMenuItem>
          <DropdownMenuItem>Archive</DropdownMenuItem>
          <DropdownMenuItem>Delete</DropdownMenuItem>
          <DropdownMenuItem>Assign to teammate</DropdownMenuItem>
          <DropdownMenuItem>Sign out</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  it("drops edit / delete / archive / assign and keeps View / Open / Download (and unrelated entries like Sign out)", () => {
    ctx.active = owned({ readOnly: true });
    render(<Menu />);
    for (const kept of ["View", "Open booking", "Download PDF", "Sign out"]) expect(screen.getByText(kept), kept).toBeTruthy();
    for (const gone of ["Edit pricing", "Archive", "Delete", "Assign to teammate"]) expect(screen.queryByText(gone), gone).toBeNull();
  });

  it("keeps every entry on a normal workspace", () => {
    ctx.active = owned();
    render(<Menu />);
    for (const label of ["View", "Edit pricing", "Archive", "Delete", "Assign to teammate"]) expect(screen.getByText(label), label).toBeTruthy();
  });

  it("allowlists by verb", () => {
    expect(readOnlyMenuLabelAllowed("View")).toBe(true);
    expect(readOnlyMenuLabelAllowed("Mark paid")).toBe(true);
    expect(readOnlyMenuLabelAllowed("Reset to default")).toBe(false);
    expect(readOnlyMenuLabelAllowed("Move to pending")).toBe(false);
    expect(readOnlyMenuLabelAllowed("")).toBe(true);
  });
});

describe("the Managed by PropLane strip", () => {
  it("renders once, with Message the team (the workspace Team chat) and Get a plan (Billing & plan), and stamps the root", () => {
    ctx.active = owned({ readOnly: true });
    rtlRender(
      <PortalReadOnlyProvider>
        <ManagedReadOnlyStrip />
      </PortalReadOnlyProvider>,
    );
    expect(screen.getByText("Managed by PropLane · View only")).toBeTruthy();
    const message = screen.getByRole("link", { name: "Message the team" }) as HTMLAnchorElement;
    expect(decodeURIComponent(message.getAttribute("href") ?? "")).toBe("/portal/communication/active/team-thread:owner-1:ws:ws-1");
    const plan = screen.getByRole("link", { name: "Get a plan" }) as HTMLAnchorElement;
    expect(plan.getAttribute("href")).toContain("/portal/profile?tab=billing");
    expect(document.documentElement.getAttribute("data-read-only")).toBe("managed");
    expect(document.querySelectorAll('[data-attr="managed-read-only-strip"]')).toHaveLength(1);
  });

  it("renders nothing for a normal workspace or outside a workspace, and stamps nothing", () => {
    ctx.active = owned();
    const { container } = rtlRender(
      <PortalReadOnlyProvider>
        <ManagedReadOnlyStrip />
      </PortalReadOnlyProvider>,
    );
    expect(container).toBeEmptyDOMElement();
    expect(document.documentElement.getAttribute("data-read-only")).toBeNull();
    cleanup();
    ctx.active = null;
    expect(rtlRender(<ManagedReadOnlyStrip />).container).toBeEmptyDOMElement();
  });

  it("is the View-as backstop: the managed stamp keys the same upload and submit dimming in globals.css", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync("src/app/globals.css", "utf8");
    expect(css).toContain('html[data-read-only="managed"] input[type="file"]');
    expect(css).toContain("[data-read-only-allow]");
  });
});

describe("a refused create leaves nothing behind", () => {
  /**
   * The lock is account-wide, so a locked client's create can also be refused by the SERVER after the UI let
   * her through (an unsynced payload, a plan that lapsed mid-session). Add service therefore asks the server
   * FIRST and awaits it: `writeManagerWorkOrderRows`' own mirror is fire-and-forget, so the 403 used to be
   * swallowed and the service sat in the list until a reload.
   */
  it("Add service awaits the server, surfaces its message and never inserts the row optimistically", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("src/components/portal/pro-add-service-modal.tsx", "utf8");
    expect(source).toContain("const saved = await upsertManagerWorkOrderToServer(row);");
    expect(source).toContain("showToast(saved.error);");
    // Nothing enters the local list before that answer, and the row it writes is the saved one.
    expect(source).not.toMatch(/writeManagerWorkOrderRows\(\[row,/);
    expect(source).toContain("writeManagerWorkOrderRows([saved.row, ...readManagerWorkOrderRows()], { mirror: false });");
  });
});

describe("source guards for the strip and the Owner payouts tab", () => {
  it("draws no pill and no subtext sentence, and uses the shared Button without a size prop", async () => {
    const { readFileSync } = await import("node:fs");
    for (const file of ["src/components/portal/managed-read-only-strip.tsx", "src/components/portal/finances/owner-payouts-panel.tsx"]) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/<Badge\b|PortalRowStatusChip/);
      expect(source, file).not.toMatch(/<Button[^>]*\bsize=/);
      expect(source, file).not.toMatch(/<Portal(Settings\w+|ServiceRecordRow|PropertyRecordRow)\b[^>]*?\b(description|meta)=/s);
    }
  });
});
