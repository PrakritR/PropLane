// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, expect, it, vi, type Mocked } from "vitest";
import type { WorkspaceContextValue } from "@/components/portal/workspace-provider";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const mocks = vi.hoisted(() => ({ context: {} as Mocked<WorkspaceContextValue>, confirm: vi.fn(), refresh: vi.fn(), push: vi.fn() }));
vi.mock("@/components/portal/workspace-provider", () => ({ useWorkspaces: () => mocks.context }));
vi.mock("@/components/providers/app-ui-provider", () => ({ useConfirm: () => mocks.confirm, useAppUi: () => ({ showToast: vi.fn() }) }));
vi.mock("next/navigation", () => ({ usePathname: () => "/portal/profile", useSearchParams: () => new URLSearchParams(), useRouter: () => ({ refresh: mocks.refresh, push: mocks.push }) }));
vi.mock("@/lib/manager-portfolio-access", () => ({ resolvePropertyLabelForId: () => "Test house" }));
vi.mock("@/lib/analytics/track-client", () => ({ track: vi.fn() }));
vi.mock("@/components/portal/modal-assistant-strip", () => ({ ModalAssistantStrip: () => null }));
vi.mock("@/hooks/use-manager-user-id", () => ({ useManagerUserId: () => ({ userId: "owner" }) }));
// The team panel hands each card its own section; the stub renders one marker per workspace so the test can prove the team lives inside the cards.
vi.mock("@/components/portal/pro-account-links-panel", () => ({
  ProAccountLinksPanel: ({ renderWorkspaces }: { renderWorkspaces: (team: { section: (w: { id: string }) => React.ReactNode }) => React.ReactNode }) => (
    <div data-attr="workspace-team-panel">{renderWorkspaces({ section: (w) => <div data-attr="workspace-team" data-workspace-id={w.id}>Managers &amp; permissions · {w.id}</div> })}</div>
  ),
}));
import { WorkspaceSettings } from "@/components/portal/workspace-settings";
const workspace = (id: string, propertyIds: string[] = [], isDefault = false) => ({ id, name: id, ownerUserId: "owner", propertyPermissions: {}, propertyIds, owned: true, isDefault, members: [] });
function mount(workspaces = [workspace("Original", [], true), workspace("Second")]) {
  mocks.context = { workspaces, active: workspaces[0] ?? null, loading: false, plan: null, error: null, refresh: vi.fn<WorkspaceContextValue["refresh"]>().mockResolvedValue(undefined), mutate: vi.fn<WorkspaceContextValue["mutate"]>().mockResolvedValue(undefined), select: vi.fn<WorkspaceContextValue["select"]>().mockResolvedValue(undefined) };
  return render(<WorkspaceSettings />);
}
function evidence(name: string) {
  const dir = process.env.WORKSPACE_UI_EVIDENCE_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  const css = readFileSync(join(dir, "workspace.css"), "utf8");
  writeFileSync(join(dir, `${name}.html`), `<!doctype html><html data-theme="light"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Workspace settings component evidence</title><style>${css}</style></head><body style="padding:24px;max-width:1000px;margin:auto"><aside style="padding:12px;border:1px solid #aaa;margin-bottom:20px">Component test evidence: actual WorkspaceSettings with fixture data and mocked workspace API/context. This is not authenticated end-to-end evidence.</aside>${document.body.innerHTML}</body></html>`);
}
beforeEach(() => { vi.clearAllMocks(); mocks.confirm.mockResolvedValue(true); });
afterEach(cleanup);
it("offers one trash action for each owned card, including default; confirms and selects next after deleting active", async () => {
  mount();
  expect(document.querySelectorAll('[data-attr="workspace-delete"]')).toHaveLength(2);
  expect(screen.queryByText("Delete this workspace")).toBeNull();
  evidence("01-workspace-cards");
  fireEvent.click(screen.getByRole("button", { name: "Delete Original" }));
  await waitFor(() => expect(mocks.context.select).toHaveBeenCalledWith("Second", { href: false }));
  expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Delete workspace?" }));
  expect(mocks.context.mutate).toHaveBeenCalledWith({ action: "delete", id: "Original", moveTo: undefined });
});
it("keeps an empty workspace when confirmation is cancelled", async () => {
  mocks.confirm.mockResolvedValue(false); mount();
  fireEvent.click(screen.getByRole("button", { name: "Delete Original" }));
  await waitFor(() => expect(mocks.confirm).toHaveBeenCalled());
  expect(mocks.context.mutate).not.toHaveBeenCalled();
});
it("moves houses and deletes through one request to the selected owned destination", async () => {
  mount([workspace("Original", ["house-1"], true), workspace("Second"), workspace("Third")]);
  fireEvent.click(screen.getByRole("button", { name: "Delete Original" }));
  const select = await screen.findByRole("button", { name: "Destination workspace" });
  fireEvent.click(select);
  const options = await screen.findAllByRole("option");
  expect(options.map(o => o.textContent?.replace(/^✓/, ""))).toEqual(["Second · 0 / 10", "Third · 0 / 10"]);
  fireEvent.pointerDown(screen.getByRole("option", { name: "Third · 0 / 10" }), { button: 0, pointerType: "mouse", pointerId: 1, clientX: 10, clientY: 10 });
  fireEvent.pointerUp(screen.getByRole("option", { name: "Third · 0 / 10" }), { button: 0, pointerType: "mouse", pointerId: 1, clientX: 10, clientY: 10 });
  evidence("02-move-and-delete");
  fireEvent.click(screen.getByRole("button", { name: "Move and delete" }));
  await waitFor(() => expect(mocks.context.mutate).toHaveBeenCalledWith({ action: "delete", id: "Original", moveTo: "Third" }));
  expect(mocks.context.mutate).toHaveBeenCalledTimes(1);
  expect(mocks.confirm).not.toHaveBeenCalled();
});
it("explains the only populated workspace and opens add without deleting houses", async () => {
  mount([workspace("Original", ["house-1"], true)]);
  fireEvent.click(screen.getByRole("button", { name: "Delete Original" }));
  await screen.findByText(/this is your only workspace/);
  expect(screen.queryByRole("button", { name: "Move and delete" })).toBeNull();
  evidence("03-only-populated-workspace");
  fireEvent.click(screen.getByRole("button", { name: "Add a workspace" }));
  expect(mocks.context.mutate).not.toHaveBeenCalled();
  await screen.findByLabelText("Workspace name");
});
it("refreshes after removing the last active empty workspace and renders first-workspace state", async () => {
  const view = mount([workspace("Original", [], true)]);
  fireEvent.click(screen.getByRole("button", { name: "Delete Original" }));
  await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
  mocks.context.workspaces = []; mocks.context.active = null;
  view.rerender(<WorkspaceSettings />);
  expect(screen.getByText(/Create your first workspace/)).toBeInTheDocument();
  evidence("04-no-workspaces");
});
it("shows failed deletion and preserves the move dialog for retry", async () => {
  mount([workspace("Original", ["house-1"], true), workspace("Second")]);
  mocks.context.mutate.mockRejectedValue(new Error("Move the properties out"));
  fireEvent.click(screen.getByRole("button", { name: "Delete Original" }));
  fireEvent.click(await screen.findByRole("button", { name: "Move and delete" }));
  await waitFor(() => expect(screen.getAllByRole("alert")[0]).toHaveTextContent("Move the properties out"));
  expect(mocks.context.select).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Move and delete" })).toBeInTheDocument();
  evidence("05-delete-refused");
});

it("creates one named workspace from a single Save", async () => {
  mount([]);
  fireEvent.click(screen.getByRole("button", { name: "Add workspace" }));
  fireEvent.change(await screen.findByLabelText("Workspace name"), { target: { value: "North homes" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(mocks.context.mutate).toHaveBeenCalledWith({ action: "create", id: undefined, name: "North homes" }));
  expect(mocks.context.mutate).toHaveBeenCalledTimes(1);
});
it("renders the team inside every owned card and never as a separate Team section", () => {
  mount([workspace("Original", ["house-1"], true), workspace("Second"), { ...workspace("Shared"), owned: false }]);
  const sections = Array.from(document.querySelectorAll('[data-attr="workspace-team"]'));
  expect(sections.map((el) => el.getAttribute("data-workspace-id"))).toEqual(["Original", "Second"]);
  for (const el of sections) expect(el.closest('[data-attr="workspace-card"]')).not.toBeNull();
  expect(screen.queryByRole("heading", { name: "Team" })).toBeNull();
  expect(screen.queryByText("Team on this workspace")).toBeNull();
  expect(document.querySelector('[data-attr="workspace-manage-team"]')).toBeNull();
  expect(document.querySelector('[data-attr="workspace-shared-access"]')).not.toBeNull();
  evidence("05-team-inside-cards");
});
