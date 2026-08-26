// Admin oversight must never BUY a phone number.
//
// `fetchAdminSmsConversations` threads the whole mapped-manager cohort and
// passes `managerIds[0]` as the "viewer". That anchor is not the person at the
// keyboard, and `resolveManagerWorkNumber` falls through to
// `ensureManagerSmsNumber` — a paid Twilio purchase. So merely LOADING the
// admin SMS tab could provision a number on an arbitrary manager's behalf,
// spending real money as a side effect of a GET. (Masked in production only
// while the shared-line bridge short-circuits first; it goes live the moment
// the bridge env is turned off.)
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveManagerWorkNumber = vi.fn(async () => "+12065550999");
const ensureManagerSmsNumber = vi.fn(async () => ({ ok: true as const, number: "+12065550111" }));

vi.mock("@/lib/auth/co-manager-module-scope", () => ({
  linkedOwnerScopeForModule: vi.fn(async () => ({ ownerIds: [] as string[] })),
}));
vi.mock("@/lib/twilio-provisioning", () => ({
  resolveManagerWorkNumber: (...args: unknown[]) => resolveManagerWorkNumber(...(args as [])),
  ensureManagerSmsNumber: (...args: unknown[]) => ensureManagerSmsNumber(...(args as [])),
}));
vi.mock("@/lib/claw-resident-messaging.server", () => ({
  resolveMappedManagerContacts: vi.fn(async () => [{ userId: "mgr-anchor" }, { userId: "mgr-2" }]),
}));
// The shared-line bridge is what masks the bug in production — force it off so
// the provisioning fall-through is reachable, which is the state this guards.
vi.mock("@/lib/claw-leasing-links", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/claw-leasing-links")>()),
  isClawSharedLineBridgeEnabled: () => false,
}));

import {
  fetchAdminSmsConversations,
  fetchManagerSmsConversations,
} from "@/lib/manager-sms-messages.server";

function makeDb(profiles: Record<string, string | null> = {}) {
  const builder = (table: string) => {
    const state = { maybeSingle: false };
    const chain: Record<string, unknown> = {};
    const result = () => {
      if (table !== "profiles") return { data: [], error: null };
      if (state.maybeSingle) {
        return { data: { phone: null, phone_verified_at: null, sms_forward_inbound: true }, error: null };
      }
      return {
        data: Object.entries(profiles).map(([id, sms_from_number]) => ({ id, sms_from_number })),
        error: null,
      };
    };
    for (const m of ["select", "in", "order", "limit", "eq", "is", "range", "delete", "or"]) {
      chain[m] = () => chain;
    }
    chain.maybeSingle = async () => {
      state.maybeSingle = true;
      return result();
    };
    chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result()).then(resolve);
    return chain;
  };
  return { from: (table: string) => builder(table) } as never;
}

beforeEach(() => {
  resolveManagerWorkNumber.mockClear();
  ensureManagerSmsNumber.mockClear();
});

describe("admin SMS oversight work-number resolution", () => {
  it("never calls the provisioning-capable resolver", async () => {
    const payload = await fetchAdminSmsConversations(makeDb({ "mgr-anchor": "+12064440777" }));
    expect(resolveManagerWorkNumber).not.toHaveBeenCalled();
    expect(ensureManagerSmsNumber).not.toHaveBeenCalled();
    // It still shows the number already on file.
    expect(payload.workNumber).toBe("+12064440777");
  });

  it("falls back to another cohort number on file rather than buying one", async () => {
    const payload = await fetchAdminSmsConversations(
      makeDb({ "mgr-anchor": "", "mgr-2": "+12064440888" }),
    );
    expect(ensureManagerSmsNumber).not.toHaveBeenCalled();
    expect(payload.workNumber).toBe("+12064440888");
  });

  it("keeps a manager's own inbox read side-effect-free", async () => {
    await fetchManagerSmsConversations(makeDb(), "mgr-self");
    expect(resolveManagerWorkNumber).not.toHaveBeenCalled();
  });
});
