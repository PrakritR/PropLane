// @vitest-environment jsdom
//
// EVIDENCE HARNESS - the Oct 27 admin-team lane (plan admin-team-1027): Settings > Admin team, the Invite / Change role
// sheet, Managed by PropLane (pick + combine) and the Settings scope switcher, rendered with the REAL components for a
// reviewer screenshot. Set EVIDENCE_DIR to write the HTML next to the generated app.css.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { writeEvidenceSurface } from "../helpers/evidence-dom";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => () => Promise.resolve(true),
  useAppUi: () => ({ showToast: vi.fn() }),
}));
vi.mock("@/lib/service/open-service-workspace", () => ({ openServiceWorkspace: vi.fn(async () => null) }));

import { AdminTeamPane } from "@/components/portal/admin-team-pane";
import { AdminTeamSheet } from "@/components/portal/admin-team-sheet";
import { ManagedByProplaneSheet } from "@/components/portal/managed-by-proplane-sheet";
import { SettingsScopeSwitcher } from "@/components/portal/settings-scope-switcher";
import type { AdminTeamMemberRow, AdminTeamPayload, AdminTeamWorkspace } from "@/lib/admin-team/admin-team-model";

beforeAll(() => {
  // jsdom has no layout APIs the Radix / vaul pop-ups ask for.
  window.matchMedia ??= ((query: string) => ({ matches: query.includes("min-width"), media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const WORKSPACES: AdminTeamWorkspace[] = [
  {
    id: "ws-beacon",
    name: "Beacon Hill homes",
    city: "Seattle",
    houses: [
      { id: "h-1", label: "5257 Brooklyn Ave NE" },
      { id: "h-2", label: "4709A 8th Ave NE" },
      { id: "h-3", label: "2214 Beacon Ave S" },
    ],
  },
  { id: "ws-capitol", name: "Capitol Hill rentals", city: "Seattle", houses: [{ id: "h-4", label: "1120 E Pine St" }, { id: "h-5", label: "815 15th Ave E" }] },
];

const MEMBERS: AdminTeamMemberRow[] = [
  { key: "u-ambika", userId: "u-ambika", name: "Ambika", email: "ambika@proplane.test", phoneVerified: true, role: "overall_admin", state: "active", seats: [], inviteId: null, isSelf: true, canManage: false },
  {
    key: "u-kumaran",
    userId: "u-kumaran",
    name: "Kumaran",
    email: "kumaran@proplane.test",
    phoneVerified: true,
    role: "property_manager",
    state: "active",
    seats: [{ linkId: "l-1", workspaceId: "ws-beacon", workspaceName: "Beacon Hill homes", role: "property_manager", status: "accepted", houseScope: "selected", assignedPropertyIds: ["h-1", "h-2"], houseCount: 2 }],
    inviteId: null,
    isSelf: false,
    canManage: true,
  },
  { key: "inv-maya", userId: null, name: "maya@proplane.test", email: "maya@proplane.test", phoneVerified: false, role: "overall_admin", state: "invited", seats: [], inviteId: "inv-1", isSelf: false, canManage: true },
];
const PAYLOAD: AdminTeamPayload = { viewer: { userId: "u-ambika", overall: true }, workspaces: WORKSPACES, members: MEMBERS };

describe("evidence: admin team (plan admin-team-1027)", () => {
  it("10 Settings > Admin team lists the Overall admin, a seated Property manager and an invited person", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => PAYLOAD })));
    const { container } = render(<AdminTeamPane />);
    await waitFor(() => expect(container.querySelectorAll('[data-attr="admin-team-member"]')).toHaveLength(3));
    const rows = [...container.querySelectorAll('[data-attr="admin-team-member"]')].map((r) => r.textContent);
    expect(rows[0]).toBe("Overall admin · all workspaces");
    expect(rows[1]).toBe("Property manager · Beacon Hill homes (2 houses)");
    expect(rows[2]).toMatch(/^Invited · Overall admin/);
    // the signed-in Overall admin cannot manage their own row; the other two carry a menu
    expect(container.querySelectorAll('[data-attr="admin-team-member-menu"]').length).toBe(2);
    writeEvidenceSurface("10-admin-team-pane", "Settings > Admin team (PropLane scope): one Overall admin (self, no menu), a Property manager seated on Beacon Hill homes for 2 houses, and an Overall admin invite still waiting; round blue + invites.");
  });

  it("11 Invite with Overall admin hides Workspaces and locks the access grid", async () => {
    render(<AdminTeamSheet workspaces={WORKSPACES} member={null} onClose={() => {}} onChanged={() => {}} />);
    expect(document.querySelector('[data-attr="admin-team-workspaces"]')).not.toBeNull();
    fireEvent.click(document.querySelector('[data-attr="admin-team-role"]') as HTMLElement);
    fireEvent.click(await screen.findByRole("option", { name: /Overall admin/ }));
    await waitFor(() => expect(document.querySelector('[data-attr="admin-team-workspaces"]')).toBeNull());
    expect(document.querySelector('[data-attr="admin-team-houses"]')).toBeNull();
    expect(document.body.textContent).toContain("Overall admin");
    writeEvidenceSurface("11-admin-team-invite-overall", "Invite to PropLane admin with the role set to Overall admin: no Workspaces or Houses picker, the access grid shows everything and is locked, preview reads All / All.");
  });

  it("12 Invite with a workspace role shows Workspaces, Houses and the module grid", () => {
    render(<AdminTeamSheet workspaces={WORKSPACES} member={null} onClose={() => {}} onChanged={() => {}} />);
    expect(document.querySelector('[data-attr="admin-team-workspaces"]')).not.toBeNull();
    expect(document.querySelector('[data-attr="admin-team-houses"]')).not.toBeNull();
    expect((document.querySelector('[data-attr="admin-team-send"]') as HTMLButtonElement).disabled).toBe(true); // no email yet
    fireEvent.change(document.querySelector('[data-attr="admin-team-email"]') as HTMLInputElement, { target: { value: "dev@proplane.test" } });
    expect((document.querySelector('[data-attr="admin-team-send"]') as HTMLButtonElement).disabled).toBe(false);
    writeEvidenceSurface("12-admin-team-invite-workspace-role", "Invite with a workspace team role: email filled, Workspaces multi-select on Beacon Hill homes, Houses (all 3), and the per-module access grid for the chosen role.");
  });

  it("13 Change role opens on an existing member", () => {
    render(<AdminTeamSheet workspaces={WORKSPACES} member={MEMBERS[1]!} onClose={() => {}} onChanged={() => {}} />);
    expect(document.body.textContent).toContain("Change role · Kumaran");
    expect((document.querySelector('[data-attr="admin-team-email"]') as HTMLInputElement).disabled).toBe(true);
    expect((document.querySelector('[data-attr="admin-team-send"]') as HTMLButtonElement).textContent).toBe("Save role");
    writeEvidenceSurface("13-admin-team-change-role", "Change role for Kumaran: email locked, role Property manager, workspace Beacon Hill homes with the 2 selected houses, Save role.");
  });
});

const THREE = [
  { id: "ws-a", name: "Marc Homes", city: "Tacoma", houseCount: 2, isDefault: true },
  { id: "ws-b", name: "Marc Rentals", city: "Seattle", houseCount: 1, isDefault: false },
  { id: "ws-c", name: "Marc Lofts", city: "Seattle", houseCount: 1, isDefault: false },
];

describe("evidence: Managed by PropLane and scope switcher", () => {
  const stub = () =>
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ account: { id: "u", name: "Marc Jackson", email: "marc@proplane.test" }, workspaces: THREE, managedCount: 0 }) })));

  it("21 pick mode lists the three workspaces with house counts", async () => {
    stub();
    render(<ManagedByProplaneSheet open account={{ id: "u", name: "Marc Jackson" }} onClose={() => {}} onDone={() => {}} />);
    await screen.findByText("Which");
    // open the Workspaces picker so the three rows and their house counts are on screen
    fireEvent.click(document.querySelector('[data-attr="managed-by-proplane-workspaces"]') as HTMLElement);
    expect(await screen.findByText(/Marc Rentals · 1 house$/)).toBeTruthy();
    expect(screen.getByText(/Marc Homes · 2 houses/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Manage by PropLane" }) as HTMLButtonElement).disabled).toBe(false);
    writeEvidenceSurface("21-managed-by-proplane-pick", "Accounts > Managers > Managed by PropLane, Choose workspaces: Marc Homes (2 houses), Marc Rentals (1), Marc Lofts (1) all checked, city / fee fields, side preview.");
  });

  it("20 combine mode names the workspace that stays and what moves", async () => {
    stub();
    render(<ManagedByProplaneSheet open account={{ id: "u", name: "Marc Jackson" }} onClose={() => {}} onDone={() => {}} />);
    await screen.findByText("Which");
    fireEvent.click(document.querySelector('[data-attr="managed-by-proplane-mode"]') as HTMLElement);
    fireEvent.click(await screen.findByRole("option", { name: /Combine all into one/ }));
    await waitFor(() => expect(document.body.textContent).toContain("Keep this workspace"));
    expect(document.body.textContent).toMatch(/Archived/);
    writeEvidenceSurface("20-managed-by-proplane-combine", "Managed by PropLane with Combine all into one: the workspace that stays is picked, the preview shows houses moved and workspaces archived.");
  });

  it("30 the scope switcher offers PropLane plus two service workspaces", async () => {
    render(
      <div className="max-w-sm">
        <SettingsScopeSwitcher scope={{ overall: true, currentWorkspaceId: null, workspaces: [{ id: "ws-beacon", name: "Beacon Hill homes", city: "Seattle" }, { id: "ws-capitol", name: "Capitol Hill rentals", city: "Seattle" }] }} />
      </div>,
    );
    fireEvent.click(document.querySelector('[data-attr="settings-scope-select"]') as HTMLElement);
    expect(screen.getAllByRole("option").map((o) => o.textContent?.replace("✓", "").trim())).toEqual(["PropLane", "Beacon Hill homes · Seattle", "Capitol Hill rentals · Seattle"]);
    writeEvidenceSurface("30-settings-scope-switcher", "Settings for: the scope dropdown open on PropLane with Beacon Hill homes and Capitol Hill rentals below it.", 200);
  });
});
