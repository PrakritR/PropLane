// @vitest-environment jsdom
//
// Declining an application that has a Checkr report asks "Is this decision based in whole or part on the background
// check?" first. No report: no question. No: the normal decline goes on. Yes: the pre-adverse notice goes out and the
// decline does NOT proceed (it waits for the final notice).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DemoApplicantRow } from "@/data/demo-portal";

const h = vi.hoisted(() => ({ toast: vi.fn(), demo: false }));
vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast: h.toast }),
  useConfirm: () => () => Promise.resolve(true),
  useOptionalAppUi: () => null,
}));
vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => h.demo,
}));
if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

import { useAdverseActionDecline } from "@/components/portal/adverse-action-decline";

const reportRow = {
  id: "app-1",
  name: "Jane Doe",
  email: "jane@example.com",
  bucket: "pending",
  backgroundCheck: { provider: "checkr", candidateId: "a", reportId: "ord_1", packageSlug: "starter", status: "complete", result: "consider", orderedAt: "x" },
} as unknown as DemoApplicantRow;
const noReportRow = { ...reportRow, backgroundCheck: undefined } as DemoApplicantRow;

let outcome: boolean | null = null;
function Harness({ row }: { row: DemoApplicantRow }) {
  const { confirmDecline, dialog } = useAdverseActionDecline();
  return (
    <>
      <button type="button" data-testid="decline" onClick={() => void confirmDecline(row).then((proceed) => { outcome = proceed; })}>
        Decline
      </button>
      {dialog}
    </>
  );
}

function stubApi(status: Record<string, unknown>, postResult: Record<string, unknown> = { ok: true, status: {} }) {
  const calls: Array<{ url: string; body?: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const payload = init?.method === "POST" ? postResult : { status };
      return { ok: true, status: 200, json: async () => payload } as Response;
    }),
  );
  return calls;
}

const baseStatus = { required: true, stage: "none", basedOnReport: null, preAdverseSentAt: null, finalDueAt: null, declineAllowed: false, canFinalize: false };

beforeEach(() => {
  outcome = null;
  h.demo = false;
  h.toast.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useAdverseActionDecline", () => {
  it("an application with no completed report is declined with no question and no request", async () => {
    const calls = stubApi(baseStatus);
    render(<Harness row={noReportRow} />);
    await act(async () => fireEvent.click(screen.getByTestId("decline")));
    await waitFor(() => expect(outcome).toBe(true));
    expect(calls).toHaveLength(0);
  });

  it("with a report it asks the question and will not continue without an answer", async () => {
    stubApi(baseStatus);
    render(<Harness row={reportRow} />);
    fireEvent.click(screen.getByTestId("decline"));
    await waitFor(() => expect(document.querySelector('[data-attr="adverse-action-question"]')).not.toBeNull());
    expect(document.body.textContent).toContain("Is this decision based in whole or part on the background check?");
    const submit = document.querySelector('[data-attr="adverse-action-submit"]') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(outcome).toBeNull();
  });

  it("an answer of No is recorded and the normal decline goes on", async () => {
    const calls = stubApi(baseStatus);
    render(<Harness row={reportRow} />);
    fireEvent.click(screen.getByTestId("decline"));
    await waitFor(() => expect(document.querySelector('[data-attr="adverse-action-answer"]')).not.toBeNull());
    fireEvent.click(document.querySelector('[data-attr="adverse-action-answer"]') as HTMLElement);
    fireEvent.click(await screen.findByRole("option", { name: "No" }));
    fireEvent.click(document.querySelector('[data-attr="adverse-action-submit"]') as HTMLButtonElement);
    await waitFor(() => expect(outcome).toBe(true));
    expect(calls.find((c) => c.body)?.body).toEqual({ action: "decide", applicationId: "app-1", basedOnReport: false });
  });

  it("an answer of Yes sends the pre-adverse notice and does NOT proceed with the decline", async () => {
    const calls = stubApi(baseStatus, { ok: true, status: { finalDueAt: "2026-11-19T17:00:00.000Z" } });
    render(<Harness row={reportRow} />);
    fireEvent.click(screen.getByTestId("decline"));
    await waitFor(() => expect(document.querySelector('[data-attr="adverse-action-answer"]')).not.toBeNull());
    fireEvent.click(document.querySelector('[data-attr="adverse-action-answer"]') as HTMLElement);
    fireEvent.click(await screen.findByRole("option", { name: "Yes" }));
    fireEvent.click(document.querySelector('[data-attr="adverse-action-submit"]') as HTMLButtonElement);
    await waitFor(() => expect(outcome).toBe(false));
    expect(calls.find((c) => c.body)?.body).toEqual({ action: "decide", applicationId: "app-1", basedOnReport: true });
    expect(h.toast.mock.calls[0]![0]).toContain("Pre-adverse notice sent");
  });

  it("inside the waiting period it shows when the final notice is available and does not decline", async () => {
    stubApi({ ...baseStatus, stage: "pre_adverse_sent", preAdverseSentAt: "2026-11-12T17:00:00.000Z", finalDueAt: "2026-11-19T17:00:00.000Z" });
    render(<Harness row={reportRow} />);
    fireEvent.click(screen.getByTestId("decline"));
    await waitFor(() => expect(document.querySelector('[data-attr="adverse-action-waiting"]')).not.toBeNull());
    expect(document.body.textContent).toContain("November 19, 2026");
    expect(outcome).toBeNull();
  });

  it("once the window has passed, Finalize sends the final notice and lets the decline proceed", async () => {
    const calls = stubApi({ ...baseStatus, stage: "pre_adverse_sent", canFinalize: true, preAdverseSentAt: "2026-11-01T17:00:00.000Z", finalDueAt: "2026-11-09T17:00:00.000Z" });
    render(<Harness row={reportRow} />);
    fireEvent.click(screen.getByTestId("decline"));
    await waitFor(() => expect(document.querySelector('[data-attr="adverse-action-finalize"]')).not.toBeNull());
    fireEvent.click(document.querySelector('[data-attr="adverse-action-finalize-submit"]') as HTMLButtonElement);
    await waitFor(() => expect(outcome).toBe(true));
    expect(calls.find((c) => c.body)?.body).toEqual({ action: "finalize", applicationId: "app-1" });
  });

  it("an answer already on record (not based, or finalized) goes straight to the decline", async () => {
    stubApi({ ...baseStatus, stage: "not_based", declineAllowed: true });
    render(<Harness row={reportRow} />);
    await act(async () => fireEvent.click(screen.getByTestId("decline")));
    await waitFor(() => expect(outcome).toBe(true));
  });

  it("a state it cannot read stops the decline with a message, never a silent pass", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response));
    render(<Harness row={reportRow} />);
    await act(async () => fireEvent.click(screen.getByTestId("decline")));
    await waitFor(() => expect(outcome).toBe(false));
    expect(h.toast).toHaveBeenCalled();
  });
});
