// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { setPortalSessionViewer } from "@/lib/auth/portal-session-gate";
const state = vi.hoisted(() => ({ row: { id: "app", managerUserId: "owner", name: "Before", application: {} } }));
const publish = vi.hoisted(() => vi.fn());
vi.mock("@/lib/manager-applications-storage", () => ({ readManagerApplicationRows: () => [state.row], replaceManagerApplicationRowInCache: publish, normalizeApplicationAxisId: (id: string) => id }));
vi.mock("@/lib/demo/demo-session", async (original) => ({ ...(await original<typeof import("@/lib/demo/demo-session")>()), isDemoModeActive: () => false }));
import { persistFrozenSignedLeaseTerms } from "@/lib/lease-signed-terms";
beforeEach(() => { state.row = { id: "app", managerUserId: "owner", name: "Before", application: {} }; publish.mockClear(); setPortalSessionViewer("first"); });
it.each(["edit", "viewer"])("refuses publication after a concurrent %s change", async (change) => {
  let finish!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
  const pending = persistFrozenSignedLeaseTerms([state.row as never], "lease");
  await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
  if (change === "edit") state.row = { ...state.row, name: "Newer" }; else setPortalSessionViewer("second");
  finish(new Response(JSON.stringify({ ok: true, row: { ...state.row, signedMonthlyRent: 1000 } }), { status: 200 }));
  expect((await pending).ok).toBe(false);
  expect(publish).not.toHaveBeenCalled();
});
