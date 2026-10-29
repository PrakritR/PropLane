// @vitest-environment jsdom
/**
 * Accounts > Managers > "Managed by PropLane...": the sheet lists the account's workspaces (read from the server), asks
 * City / fee, and posts one `manage-by-proplane` request - Choose workspaces or Combine all into one. The row action is
 * hidden for an account with nothing left to manage.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const showToast = vi.fn();
vi.mock("@/components/providers/app-ui-provider", () => ({ useAppUi: () => ({ showToast }), useConfirm: () => vi.fn(async () => true) }));
vi.mock("@/components/portal/add-workspace", () => ({
  AddWorkspace: (props: { children: React.ReactNode; sidePanel: React.ReactNode; onFinish: () => void; lastLabel: string; lastDisabled: boolean }) => (
    <div>
      {props.children}
      <aside data-testid="preview">{props.sidePanel}</aside>
      <button type="button" disabled={props.lastDisabled} onClick={props.onFinish}>
        {props.lastLabel}
      </button>
    </div>
  ),
}));
// Native controls for the Radix pickers, so the test can drive them.
vi.mock("@/components/portal/add-workspace/parts", () => ({
  PreviewPanel: ({ name, facts }: { name: React.ReactNode; facts: { label: string; value: React.ReactNode }[] }) => (
    <div>
      <b>{name}</b>
      {facts.map((f) => (
        <span key={f.label}>
          {f.label}: {f.value};
        </span>
      ))}
    </div>
  ),
  WizardSection: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <section>
      <h3>{title}</h3>
      {children}
    </section>
  ),
  WizardField: ({ label, children }: { label: string; children: React.ReactNode }) => (
    <label>
      {label}
      {children}
    </label>
  ),
  WizardLockedField: ({ label, value }: { label: string; value: React.ReactNode }) => (
    <div>
      {label}: {value}
    </div>
  ),
  WizardSelect: ({ label, options, value, onChange }: { label: string; options: { value: string; label: string }[]; value: string; onChange: (v: string) => void }) => (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  ),
  WizardMultiSelect: ({ label, options, selected, onChange }: { label: string; options: { value: string; label: string }[]; selected: string[]; onChange: (v: string[]) => void }) => (
    <fieldset aria-label={label}>
      {options.map((o) => (
        <label key={o.value}>
          <input
            type="checkbox"
            checked={selected.includes(o.value)}
            onChange={(e) => onChange(e.target.checked ? [...selected, o.value] : selected.filter((v) => v !== o.value))}
          />
          {o.label}
        </label>
      ))}
    </fieldset>
  ),
}));

import { ManagedByProplaneSheet } from "@/components/portal/managed-by-proplane-sheet";

const ONE = [{ id: "ws-a", name: "Marc Homes", city: "Tacoma", houseCount: 2, isDefault: true }];
const THREE = [
  { id: "ws-a", name: "Marc Homes", city: "Tacoma", houseCount: 2, isDefault: true },
  { id: "ws-b", name: "Marc Rentals", city: null, houseCount: 1, isDefault: false },
  { id: "ws-c", name: "Marc Lofts", city: null, houseCount: 1, isDefault: false },
];

function stubFetch(workspaces: unknown[], manage: { ok: boolean; body: Record<string, unknown> } = { ok: true, body: { attached: ["ws-a"], archived: [] } }) {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (body.action === "account-workspaces") return { ok: true, json: async () => ({ account: { id: "u", name: "Marc", email: "m@x.co" }, workspaces, managedCount: 0 }) };
    return { ok: manage.ok, json: async () => manage.body };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
const writes = (m: ReturnType<typeof stubFetch>) =>
  m.mock.calls.map((c) => JSON.parse(String((c[1] as RequestInit).body)) as Record<string, unknown>).filter((b) => b.action === "manage-by-proplane");

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  showToast.mockClear();
});

describe("ManagedByProplaneSheet", () => {
  it("one workspace: shows it, asks City / Name / fee, fixes the role at Property owner (view-only) and posts a single pick", async () => {
    const fetchMock = stubFetch(ONE);
    const onDone = vi.fn();
    const onClose = vi.fn();
    render(<ManagedByProplaneSheet open account={{ id: "u", name: "Marc Jackson" }} onClose={onClose} onDone={onDone} />);
    expect(await screen.findByText(/Marc Homes · 2 houses/)).toBeTruthy();
    expect(screen.getByText(/Their role after: Property owner \(view-only\)/)).toBeTruthy();
    expect(screen.queryByLabelText("Which")).toBeNull();
    fireEvent.change(document.querySelector('[data-attr="managed-by-proplane-city"]') as HTMLInputElement, { target: { value: "Seattle" } });
    fireEvent.change(document.querySelector('[data-attr="managed-by-proplane-fee"]') as HTMLInputElement, { target: { value: "8" } });
    fireEvent.click(screen.getByRole("button", { name: "Manage by PropLane" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(writes(fetchMock)[0]).toEqual({
      action: "manage-by-proplane",
      accountUserId: "u",
      mode: "pick",
      workspaceIds: ["ws-a"],
      city: "Seattle",
      label: "Marc Homes",
      feePercent: 8,
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("several: Choose workspaces posts exactly the checked ones", async () => {
    const fetchMock = stubFetch(THREE);
    render(<ManagedByProplaneSheet open account={{ id: "u", name: "Marc" }} onClose={vi.fn()} onDone={vi.fn()} />);
    fireEvent.click(await screen.findByLabelText(/Marc Rentals · 1 house$/));
    fireEvent.click(screen.getByRole("button", { name: "Manage by PropLane" }));
    await waitFor(() => expect(writes(fetchMock)).toHaveLength(1));
    expect(writes(fetchMock)[0]).toMatchObject({ mode: "pick", workspaceIds: ["ws-a", "ws-c"] });
    expect(writes(fetchMock)[0]).not.toHaveProperty("label");
  });

  it("a workspace row's Managed by PropLane… opens preselected to that workspace and posts only it", async () => {
    const fetchMock = stubFetch(THREE);
    render(<ManagedByProplaneSheet open account={{ id: "u", name: "Marc" }} initialWorkspaceId="ws-b" onClose={vi.fn()} onDone={vi.fn()} />);
    expect(((await screen.findByLabelText(/Marc Rentals · 1 house$/)) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText(/Marc Homes · 2 houses$/) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText(/Marc Lofts · 1 house$/) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Manage by PropLane" }));
    await waitFor(() => expect(writes(fetchMock)).toHaveLength(1));
    expect(writes(fetchMock)[0]).toMatchObject({ mode: "pick", workspaceIds: ["ws-b"] });
  });

  it("an initialWorkspaceId that is not among the unmanaged ones (already managed) falls back to all", async () => {
    stubFetch(THREE);
    render(<ManagedByProplaneSheet open account={{ id: "u", name: "Marc" }} initialWorkspaceId="ws-gone" onClose={vi.fn()} onDone={vi.fn()} />);
    expect(((await screen.findByLabelText(/Marc Rentals · 1 house$/)) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText(/Marc Homes · 2 houses$/) as HTMLInputElement).checked).toBe(true);
  });

  it("several: Combine all into one names the workspace that stays and shows what moves and what is archived", async () => {
    const fetchMock = stubFetch(THREE, { ok: true, body: { attached: ["ws-b"], archived: ["ws-c"] } });
    render(<ManagedByProplaneSheet open account={{ id: "u", name: "Marc" }} onClose={vi.fn()} onDone={vi.fn()} />);
    fireEvent.change(await screen.findByLabelText("Which"), { target: { value: "combine" } });
    fireEvent.change(screen.getByLabelText("Keep this workspace"), { target: { value: "ws-b" } });
    expect(screen.getByTestId("preview").textContent).toContain("Houses moved: 3");
    expect(screen.getByTestId("preview").textContent).toContain("Archived: 2");
    fireEvent.click(screen.getByRole("button", { name: "Manage by PropLane" }));
    await waitFor(() => expect(writes(fetchMock)).toHaveLength(1));
    expect(writes(fetchMock)[0]).toMatchObject({ mode: "combine", workspaceIds: ["ws-a", "ws-b", "ws-c"], targetId: "ws-b" });
    await waitFor(() => expect(showToast).toHaveBeenCalledWith("Combined into one workspace managed by PropLane; 1 archived."));
  });

  it("blocks an out-of-range fee, shows a server refusal inline and keeps the sheet open", async () => {
    stubFetch(ONE, { ok: false, body: { error: "Could not record the audit entry, so nothing was changed. Please retry." } });
    const onClose = vi.fn();
    render(<ManagedByProplaneSheet open account={{ id: "u", name: "Marc" }} onClose={onClose} onDone={vi.fn()} />);
    await screen.findByText(/Marc Homes/);
    const fee = document.querySelector('[data-attr="managed-by-proplane-fee"]') as HTMLInputElement;
    fireEvent.change(fee, { target: { value: "55" } });
    expect((screen.getByRole("button", { name: "Manage by PropLane" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(fee, { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "Manage by PropLane" }));
    expect((await screen.findByRole("alert")).textContent).toContain("nothing was changed");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("an unreadable list shows the error and offers nothing to confirm", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({ error: "Could not load the account's workspaces. Please retry." }) })));
    render(<ManagedByProplaneSheet open account={{ id: "u", name: "Marc" }} onClose={vi.fn()} onDone={vi.fn()} />);
    expect((await screen.findByRole("alert")).textContent).toContain("Could not load");
    expect((screen.getByRole("button", { name: "Manage by PropLane" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
