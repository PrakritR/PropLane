// @vitest-environment jsdom
//
// `/demo` never writes real rows, so EVERY reminder patch is taken locally there — a cancel and a
// subject/body edit alike. Only the cancel used to have that fallback, and only after the signed-out
// PATCH came back 401, so saving an edit on a demo reminder failed with "Could not update reminder."
// on a card whose Save had nothing wrong with it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ demo: false, merge: vi.fn() }));

vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => state.demo,
}));
vi.mock("@/lib/client-scheduled-message-overrides", () => ({
  CLIENT_SCHEDULED_MESSAGE_OVERRIDES_EVENT: "propplane:client-scheduled-message-overrides",
  applyClientPatchesToMessages: (messages: unknown[]) => messages,
  mergeClientScheduledMessagePatch: state.merge,
}));

const fetchMock = vi.fn();

beforeEach(() => {
  state.demo = false;
  state.merge.mockClear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("patchScheduledMessage under /demo", () => {
  it("applies a subject/body edit locally and never issues a request", async () => {
    state.demo = true;
    const { patchScheduledMessage } = await import("@/components/portal/payment-schedule-ui");
    await expect(
      patchScheduledMessage("msg-1", { customSubject: "New subject", customBody: "New body" }),
    ).resolves.toBeUndefined();
    expect(state.merge).toHaveBeenCalledWith("msg-1", { customSubject: "New subject", customBody: "New body" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("applies a cancel locally and never issues a request", async () => {
    state.demo = true;
    const { patchScheduledMessage } = await import("@/components/portal/payment-schedule-ui");
    await patchScheduledMessage("msg-2", { cancelled: true });
    expect(state.merge).toHaveBeenCalledWith("msg-2", { cancelled: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("outside the demo it still writes, and a refusal still throws", async () => {
    const { patchScheduledMessage } = await import("@/components/portal/payment-schedule-ui");
    fetchMock.mockResolvedValue({ ok: true });
    await patchScheduledMessage("msg-3", { customSubject: "S" });
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/portal/scheduled-messages/"), expect.objectContaining({ method: "PATCH" }));
    expect(state.merge).toHaveBeenCalledWith("msg-3", { customSubject: "S" });

    state.merge.mockClear();
    fetchMock.mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: "Unauthorized" }) });
    await expect(patchScheduledMessage("msg-4", { cancelled: true })).rejects.toThrow();
    expect(state.merge).not.toHaveBeenCalled();
  });
});
