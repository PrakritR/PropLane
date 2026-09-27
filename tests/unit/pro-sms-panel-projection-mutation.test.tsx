// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { ManagerSmsPanel } from "@/components/portal/pro-sms-panel";
import { applySmsProjectionListMutation } from "@/lib/sms-projection-list-reconciliation";
import type { ManagerSmsResidentConversation } from "@/lib/manager-sms-messages";

const showToast = vi.fn();
vi.mock("@/hooks/use-portal-session", () => ({ usePortalSession: () => ({ userId: "manager-1", ready: true }) }));
vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => () => Promise.resolve(true), useAppUi: () => ({ showToast }),
}));
vi.mock("@/components/portal/pro-sms-compose-modal", () => ({ ManagerSmsComposeModal: () => null }));

const projectionId = "22222222-2222-4222-8222-222222222222";
const row = (id: string, version = 1, archived = false, phone: string | null = "+12065550100") => ({
  projectionId: id, stateVersion: version, archived, name: `Conversation ${id.slice(0, 4)}`,
  phone, ownerManagerUserId: "manager-1", counterpartyRole: "prospect", conversationKey: null,
  messages: [{ id: `${id}-message`, direction: "inbound", body: "retained text", fromPhone: "+12065550100",
    toPhone: "+12065550999", createdAt: "2026-09-02T20:20:41.259580Z", source: "work_number" }],
} as ManagerSmsResidentConversation);

const first = row("11111111-1111-4111-8111-111111111111");
const second = row(projectionId, 1, false, null);
const neighbor = row("33333333-3333-4333-8333-333333333333");
const payload = (residents: ManagerSmsResidentConversation[]) => ({ workNumber: "+12065550999", personalPhone: null,
  phoneVerified: false, forwardInbound: true, smsConfigured: true, residents, nextCursor: null });

let parentRows: ManagerSmsResidentConversation[];
let mutationReports: unknown[];
let version: number;
let archived: boolean;
let patchStatus: number;
let deleteStatus: number;
let sentDelete: unknown;

function Fixture({ folder = "active" }: { folder?: "active" | "archived" }) {
  const [activeId, setActiveId] = useState<string | null>(projectionId);
  return <ManagerSmsPanel suppressListPane listSegment={folder} controlledActiveId={activeId}
    onControlledActiveIdChange={setActiveId}
    onProjectionMutationStart={() => (mutation) => {
      mutationReports.push(mutation);
      parentRows = applySmsProjectionListMutation(parentRows, mutation);
    }} />;
}

beforeEach(() => {
  const values = new Map<string, string>();
  Object.defineProperty(window, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  } });
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  parentRows = [first, second, neighbor]; mutationReports = []; version = 1; archived = false;
  patchStatus = 200; deleteStatus = 200; sentDelete = null;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "PATCH") {
      if (patchStatus !== 200) return Response.json({}, { status: patchStatus });
      version += 1; archived = JSON.parse(String(init.body)).action === "archive";
      return Response.json({ version });
    }
    if (init?.method === "DELETE") {
      sentDelete = JSON.parse(String(init.body));
      return Response.json(deleteStatus === 200 ? { ok: true, deleted: 1 } : { error: "Denied" }, { status: deleteStatus });
    }
    if (url.includes(projectionId)) return Response.json({ resident: row(projectionId, version, archived, null),
      messages: second.messages, nextCursor: null });
    return Response.json(payload([first]));
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); showToast.mockClear(); });

describe("direct panel projection mutations", () => {
  it("archives a second-page retained row with its confirmed version and keeps loaded neighbors", async () => {
    render(<Fixture />);
    fireEvent.click(await screen.findByText("Archive"));
    await waitFor(() => expect(parentRows.find((item) => item.projectionId === projectionId)?.stateVersion).toBe(2));
    expect(parentRows.find((item) => item.projectionId === projectionId)?.archived).toBe(true);
    expect(parentRows.map((item) => item.projectionId)).toEqual([first.projectionId, projectionId, neighbor.projectionId]);
    expect(mutationReports).toContainEqual({ updated: [{ projectionId, archived: true, version: 2 }], deleted: [], reconcile: [] });
  });

  it("restores and deletes the null-phone row, reporting exact parent changes", async () => {
    archived = true; version = 2; parentRows = [first, row(projectionId, 2, true, null), neighbor];
    const view = render(<Fixture folder="archived" />);
    fireEvent.click(await screen.findByLabelText("Restore conversation"));
    await waitFor(() => expect(parentRows.find((item) => item.projectionId === projectionId)?.stateVersion).toBe(3));
    expect(parentRows.find((item) => item.projectionId === projectionId)?.archived).toBe(false);
    view.unmount();
    render(<Fixture />);
    fireEvent.click(await screen.findByLabelText("Delete conversation"));
    await waitFor(() => expect(parentRows.map((item) => item.projectionId)).toEqual([first.projectionId, neighbor.projectionId]));
    expect(sentDelete).toMatchObject({ projectionId });
    expect((sentDelete as Record<string, unknown>).phone).toBeUndefined();
  });

  it("keeps a failed second-page mutation and reports its exact reconciliation ID", async () => {
    patchStatus = 409;
    render(<Fixture />);
    fireEvent.click(await screen.findByText("Archive"));
    await waitFor(() => expect(mutationReports).toContainEqual({ updated: [], deleted: [], reconcile: [projectionId] }));
    expect(parentRows).toEqual([first, second, neighbor]);
  });
});
