// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { workspaceListedNumbers, type ManagerMessagingNumberStatus } from "@/lib/sms/manager-messaging-number";

const showToast = vi.hoisted(() => vi.fn());
vi.mock("@/components/providers/app-ui-provider", () => ({ useAppUi: () => ({ showToast }) }));

import { ManagerSecurityDepositsPanel } from "@/components/portal/pro-security-deposits-panel";

const read = (file: string) => readFileSync(file, "utf8");
type Workspace = NonNullable<ManagerMessagingNumberStatus["workspaces"]>[number];
const base: Workspace = {
  workspaceId: "w1", workspaceName: "My workspace", owned: true, isDefault: true, ownerName: "T",
  phoneNumber: null, provisionState: null, numbers: [],
};

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("M4: Settings reads the same work number as the inbox card", () => {
  it("lists the workspace's live home line when the held-numbers list is empty", () => {
    const rows = workspaceListedNumbers({ ...base, phoneNumber: "+15550009253", provisionState: "active" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ phoneNumber: "+15550009253", isPrimary: true, provisionState: "active" });
  });
  it("prefers the held numbers, and lists nothing for a workspace with no line", () => {
    const held = [{ numberId: "n1", phoneNumber: "+15550001111", isPrimary: true, provisionState: "active", sharedWithWorkspaceIds: [], sharedWithWorkspaceNames: [] }];
    expect(workspaceListedNumbers({ ...base, phoneNumber: "+15550009253", numbers: held })).toBe(held);
    expect(workspaceListedNumbers(base)).toEqual([]);
    expect(workspaceListedNumbers({ ...base, owned: false, phoneNumber: "+15550009253" })).toEqual([]);
  });
});

describe("M2: Deposits report rows", () => {
  it("formats money with thousands separators, keeps the email on one line, and puts Dispose in the row menu", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ deposits: [{
      id: "d1", residentEmail: "marcus.chen.workflow@test.proplane.local", receivedDate: "2026-09-10",
      amountHeldCents: 240000, status: "held", dispositionType: null,
    }] })));
    render(<ManagerSecurityDepositsPanel />);
    expect(await screen.findByText("$2,400.00")).toBeTruthy();
    const email = screen.getByText("marcus.chen.workflow@test.proplane.local");
    expect(email.className).toContain("truncate");
    expect(screen.queryByRole("button", { name: "Dispose" })).toBeNull();
    await waitFor(() => expect(screen.getByRole("button", { name: /deposit actions/ })).toBeTruthy());
  });
});

describe("M3: one deposits truth", () => {
  it("the deposits list is narrowed by the active workspace like the financial-activity report", () => {
    expect(read("src/app/api/security-deposits/route.ts")).toContain("activeWorkspacePropertyScope");
  });
});

describe("M6 / M10 sources", () => {
  it("the shared listing sections load the .ps tokens themselves, so the portal preview's bar has a background", () => {
    expect(read("src/components/marketing/listing-detail-sections.tsx")).toContain('import "@/components/public-site/public-site.css"');
  });
  it("identity boxes fill their grid cell and the status line wraps instead of truncating", () => {
    const card = read("src/components/portal/portal-inbox-contact-card.tsx");
    expect(card).toContain("h-full min-w-0 rounded-lg border");
    expect(card).not.toMatch(/mt-0\.5 truncate text-\[11px\] leading-tight text-\[var\(--status-pending-fg\)\]/);
  });
});
