/**
 * MONEY: the waive-code routes behind the inline "Promo codes" row. The client sends only the code text, the fee
 * and a property id; the server decides whose code it is (the session's manager) and refuses a property the
 * manager does not own. Ids in a body are never authorization.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabaseClient, type Row } from "./helpers/fake-supabase-tables";

const MANAGER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

const h = vi.hoisted(() => ({ ctx: null as { db: unknown; userId: string } | null }));
vi.mock("@/lib/manager-route-guard.server", () => ({ requireManagerRouteUser: async () => h.ctx }));

import { POST } from "@/app/api/manager/application-fee-waivers/route";
import { PATCH } from "@/app/api/manager/application-fee-waivers/[id]/route";

let tables: Record<string, Row[]>;

beforeEach(() => {
  tables = {
    manager_property_records: [
      { id: "prop-mine", manager_user_id: MANAGER },
      { id: "prop-theirs", manager_user_id: OTHER },
    ],
    manager_application_fee_waiver_codes: [
      { id: "code-theirs", manager_user_id: OTHER, code: "THEIRS", code_normalized: "THEIRS", status: "active", applies_to: "application", used_count: 0 },
    ],
  };
  h.ctx = { db: fakeSupabaseClient(tables), userId: MANAGER };
});

const post = (body: unknown) =>
  POST(new Request("http://localhost/api/manager/application-fee-waivers", { method: "POST", body: JSON.stringify(body) }));
const patch = (id: string, body: unknown) =>
  PATCH(new Request(`http://localhost/api/manager/application-fee-waivers/${id}`, { method: "PATCH", body: JSON.stringify(body) }), {
    params: Promise.resolve({ id }),
  });
const mine = () => tables.manager_application_fee_waiver_codes!.filter((r) => r.manager_user_id === MANAGER);

describe("POST /api/manager/application-fee-waivers (the inline Promo codes row)", () => {
  it("needs a signed-in manager", async () => {
    h.ctx = null;
    expect((await post({ code: "WELCOME", appliesTo: "lease", propertyIds: ["prop-mine"] })).status).toBe(401);
    expect(mine()).toHaveLength(0);
  });

  it("creates a lease code limited to the manager's own property, owned by the session manager", async () => {
    const res = await post({ code: "welcome", appliesTo: "lease", propertyIds: ["prop-mine"] });
    expect(res.status).toBe(200);
    expect(mine()).toHaveLength(1);
    expect(mine()[0]).toMatchObject({ code: "WELCOME", applies_to: "lease", property_ids: ["prop-mine"], manager_user_id: MANAGER });
  });

  it("ignores a manager id (or any owner field) in the body: the code belongs to the session", async () => {
    const res = await post({ code: "SNEAKY", appliesTo: "application", propertyIds: ["prop-mine"], managerUserId: OTHER, manager_user_id: OTHER });
    expect(res.status).toBe(200);
    const row = tables.manager_application_fee_waiver_codes!.find((r) => r.code === "SNEAKY")!;
    expect(row.manager_user_id).toBe(MANAGER);
  });

  it("refuses another manager's property, writing nothing", async () => {
    const res = await post({ code: "STEAL", appliesTo: "lease", propertyIds: ["prop-theirs"] });
    expect(res.status).toBe(400);
    expect(mine()).toHaveLength(0);
    // A mixed list is refused whole.
    expect((await post({ code: "MIXED", propertyIds: ["prop-mine", "prop-theirs"] })).status).toBe(400);
    expect(mine()).toHaveLength(0);
  });

  it("refuses a property list that is not a list, and ids that are not strings", async () => {
    expect((await post({ code: "NOTLIST", propertyIds: "prop-mine" })).status).toBe(400);
    expect((await post({ code: "NOTSTR", propertyIds: [{ id: "prop-mine" }] })).status).toBe(400);
    expect(mine()).toHaveLength(0);
  });

  it("refuses a malformed code with the existing rule", async () => {
    const res = await post({ code: "ab", appliesTo: "lease", propertyIds: ["prop-mine"] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/4-32/);
  });
});

describe("PATCH /api/manager/application-fee-waivers/[id] (turn a code off)", () => {
  it("turns off the manager's own code", async () => {
    await post({ code: "MINE-ONE", appliesTo: "application", propertyIds: ["prop-mine"] });
    const id = String(mine()[0]!.id);
    expect((await patch(id, { action: "revoke" })).status).toBe(200);
    expect(mine()[0]!.status).toBe("revoked");
  });

  it("cannot reach another manager's code", async () => {
    const res = await patch("code-theirs", { action: "revoke" });
    expect(res.status).toBe(404);
    expect(tables.manager_application_fee_waiver_codes!.find((r) => r.id === "code-theirs")!.status).toBe("active");
  });
});
