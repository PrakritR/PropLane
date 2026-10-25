// @vitest-environment jsdom
/**
 * The fee split card on Settings > Balance & payouts of a PropLane Service workspace. A platform admin edits it (the
 * server says so through `canEdit`); the owner and other seats read one line. The write is the existing admin route's
 * `action: "fee"`, and Save is a labeled data-commit that stays off until the value differs from the saved one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ServiceFeeSplitCard } from "@/components/portal/service-fee-split-card";
import { managementFeeSplitCents } from "@/lib/owner-management/fee-percent";

type View = {
  split: { feePercent: number; version: number; since: string } | null;
  canEdit: boolean;
  viewerIsOwnerOfRecord: boolean;
};

const WS = "11111111-1111-4111-8111-111111111111";
const fetchMock = vi.fn();
let view: View;

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
}

beforeEach(() => {
  view = { split: { feePercent: 10, version: 2, since: "2026-10-20" }, canEdit: true, viewerIsOwnerOfRecord: false };
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (typeof url === "string" && url.startsWith("/api/workspaces/service-fee")) return json(view);
    if (url === "/api/admin/service-workspaces" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { percent: number };
      view = { ...view, split: { feePercent: body.percent, version: 3, since: "2026-10-25" } };
      return json({ ok: true, feePercent: body.percent, changed: true });
    }
    return json({ error: "unexpected" }, 500);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const percentInput = () => screen.getByLabelText("PropLane percent") as HTMLInputElement;
const saveButton = () => screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;

describe("fee split card, platform admin", () => {
  it("shows the version, the owner share, the bar and the example, with Save off until the value moves", async () => {
    render(<ServiceFeeSplitCard workspaceId={WS} />);
    await waitFor(() => expect(percentInput().value).toBe("10"));
    expect(screen.getByText("Version 2 · since Oct 20, 2026")).toBeTruthy();
    expect(screen.getByText("90%")).toBeTruthy();
    expect(screen.getByText("On $1,000 rent: PropLane $100 · Owner $900")).toBeTruthy();
    expect(screen.getByRole("img", { name: "PropLane 10%, Owner 90%" })).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
  });

  it("Save posts action fee with the workspace id and the new percent, then shows the new version", async () => {
    render(<ServiceFeeSplitCard workspaceId={WS} />);
    await waitFor(() => expect(percentInput().value).toBe("10"));
    fireEvent.click(screen.getByLabelText("Increase PropLane percent"));
    fireEvent.click(screen.getByLabelText("Increase PropLane percent"));
    expect(percentInput().value).toBe("12");
    expect(screen.getByText("88%")).toBeTruthy();
    expect(screen.getByText("On $1,000 rent: PropLane $120 · Owner $880")).toBeTruthy();
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());
    await waitFor(() => expect(screen.getByText("Version 3 · since Oct 25, 2026")).toBeTruthy());
    const post = fetchMock.mock.calls.find(([url]) => url === "/api/admin/service-workspaces");
    expect(post).toBeTruthy();
    expect(JSON.parse(String((post![1] as RequestInit).body))).toEqual({ action: "fee", id: WS, percent: 12 });
    await waitFor(() => expect(saveButton().disabled).toBe(true));
  });

  it("clamps the stepper at 0 and at 30", async () => {
    view.split = { feePercent: 1, version: 1, since: "2026-10-20" };
    render(<ServiceFeeSplitCard workspaceId={WS} />);
    await waitFor(() => expect(percentInput().value).toBe("1"));
    fireEvent.click(screen.getByLabelText("Decrease PropLane percent"));
    expect(percentInput().value).toBe("0");
    expect((screen.getByLabelText("Decrease PropLane percent") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(percentInput(), { target: { value: "99" } });
    expect(percentInput().value).toBe("30");
    expect((screen.getByLabelText("Increase PropLane percent") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(percentInput(), { target: { value: "-4" } });
    expect(percentInput().value).toBe("0");
  });

  it("stepping back to the saved value turns Save off again", async () => {
    render(<ServiceFeeSplitCard workspaceId={WS} />);
    await waitFor(() => expect(percentInput().value).toBe("10"));
    fireEvent.click(screen.getByLabelText("Decrease PropLane percent"));
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(screen.getByLabelText("Increase PropLane percent"));
    expect(saveButton().disabled).toBe(true);
  });

  it("shows the server's refusal and keeps Save available", async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/admin/service-workspaces" && init?.method === "POST") return json({ error: "Forbidden." }, 403);
      return json(view);
    });
    render(<ServiceFeeSplitCard workspaceId={WS} />);
    await waitFor(() => expect(percentInput().value).toBe("10"));
    fireEvent.click(screen.getByLabelText("Increase PropLane percent"));
    fireEvent.click(saveButton());
    await waitFor(() => expect(screen.getByText("Forbidden.")).toBeTruthy());
    expect(saveButton().disabled).toBe(false);
  });
});

describe("fee split card, read only", () => {
  it("the owner of record reads one line, no stepper and no Save", async () => {
    view = { split: { feePercent: 10, version: 2, since: "2026-10-20" }, canEdit: false, viewerIsOwnerOfRecord: true };
    render(<ServiceFeeSplitCard workspaceId={WS} />);
    await waitFor(() => expect(screen.getByText("PropLane 10% · You 90%")).toBeTruthy());
    expect(screen.queryByLabelText("PropLane percent")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("another seat reads the same split with Owner in place of You", async () => {
    view = { split: { feePercent: 15, version: 1, since: "2026-10-20" }, canEdit: false, viewerIsOwnerOfRecord: false };
    render(<ServiceFeeSplitCard workspaceId={WS} />);
    await waitFor(() => expect(screen.getByText("PropLane 15% · Owner 85%")).toBeTruthy());
    expect(screen.queryByLabelText("PropLane percent")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("a viewer the server refuses sees nothing", async () => {
    fetchMock.mockImplementation(() => json({ error: "Service workspace not found." }, 404));
    const { container } = render(<ServiceFeeSplitCard workspaceId={WS} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("a client-side flag cannot make a read-only viewer editable: canEdit comes only from the server answer", async () => {
    view = { split: { feePercent: 10, version: 2, since: "2026-10-20" }, canEdit: false, viewerIsOwnerOfRecord: true };
    render(<ServiceFeeSplitCard workspaceId={WS} />);
    await waitFor(() => expect(screen.getByText("PropLane 10% · You 90%")).toBeTruthy());
    expect(fetchMock.mock.calls.every(([url]) => url !== "/api/admin/service-workspaces")).toBe(true);
  });
});

describe("fee split example math", () => {
  it("rounds PropLane's fee down to the cent and gives the owner the remainder", () => {
    expect(managementFeeSplitCents(100_000, 10)).toEqual({ feeCents: 10_000, ownerCents: 90_000 });
    expect(managementFeeSplitCents(100_000, 0)).toEqual({ feeCents: 0, ownerCents: 100_000 });
    expect(managementFeeSplitCents(100_000, 30)).toEqual({ feeCents: 30_000, ownerCents: 70_000 });
    expect(managementFeeSplitCents(99_999, 7.5)).toEqual({ feeCents: 7_499, ownerCents: 92_500 });
  });
});
