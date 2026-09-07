/**
 * EVIDENCE HARNESS — the settings route's answer to a code-less "PropLane covers it".
 *
 * Drives the REAL `PATCH /api/portal/manager-manual-payment-settings` handler and
 * records the request/response transcript. The point of the change is that a
 * code-less `proplane` selection is REFUSED with 400 — it used to be stored as a
 * quietly downgraded `resident` and answered 200, so the manager was told their
 * fees were covered when they were not.
 *
 * Set EVIDENCE_DIR to dump the transcript.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";

const OUT = process.env.EVIDENCE_DIR ?? "";
const transcript: string[] = [];
afterAll(() => {
  if (!OUT || transcript.length === 0) return;
  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}/manual-payment-settings-route.transcript.txt`, transcript.join("\n"), "utf8");
});

const MANAGER_ID = "mgr-evidence-1";

/** The one stored settings row, as `manual_payments` JSON on the manager's record. */
let stored: Record<string, unknown> | null = null;

const db = {
  from(table: string) {
    if (table === "profiles") {
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { role: "manager" }, error: null }) }) }),
      };
    }
    if (table === "profile_roles") {
      return { select: () => ({ eq: async () => ({ data: [{ role: "manager" }], error: null }) }) };
    }
    return {
      select: () => ({
        limit: async () => ({ data: [], error: null }),
        eq: () => ({ maybeSingle: async () => ({ data: stored ? { manual_payments: stored } : null, error: null }) }),
      }),
      upsert: async (row: Record<string, unknown>) => {
        stored = row.manual_payments as Record<string, unknown>;
        return { error: null };
      },
    };
  },
} as never;

vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => db }));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: MANAGER_ID, user_metadata: { role: "manager" } } } }) },
  }),
}));
vi.mock("@/lib/manager-manual-payment-settings.server", () => ({
  applyManagerManualPaymentsToListings: async () => ({ listingsUpdated: 0, chargesUpdated: 0 }),
}));

const { PATCH } = await import("@/app/api/portal/manager-manual-payment-settings/route");

const BASE = {
  axisPaymentsEnabled: true,
  zellePaymentsEnabled: false,
  zelleContact: "",
  venmoPaymentsEnabled: false,
  venmoContact: "",
  receiptAutoMarkEnabled: true,
};

async function patch(label: string, body: Record<string, unknown>) {
  const res = await PATCH(
    new Request("http://localhost/api/portal/manager-manual-payment-settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  const json = (await res.json()) as Record<string, unknown>;
  transcript.push(
    `### ${label}`,
    `PATCH /api/portal/manager-manual-payment-settings`,
    `> ${JSON.stringify(body)}`,
    `< ${res.status} ${JSON.stringify(json)}`,
    `  stored serviceFeePayer = ${JSON.stringify((stored as Record<string, unknown> | null)?.serviceFeePayer ?? null)}`,
    "",
  );
  return { status: res.status, json };
}

beforeEach(() => {
  stored = null;
  transcript.length = 0;
});

describe("evidence · PATCH manager-manual-payment-settings", () => {
  it("refuses a code-less PropLane selection with 400 and stores nothing", async () => {
    const refused = await patch("A new 'PropLane covers it' with NO promo code", {
      ...BASE,
      serviceFeePayer: "proplane",
    });
    expect(refused.status).toBe(400);
    expect(refused.json.error).toContain("promo code");
    // Nothing was written — not even a downgraded `resident`.
    expect(stored).toBeNull();

    const wrong = await patch("…and with a WRONG promo code", {
      ...BASE,
      serviceFeePayer: "proplane",
      serviceFeeWaiverCode: "NOPE123",
    });
    expect(wrong.status).toBe(400);
    expect(stored).toBeNull();

    const ok = await patch("…and with FREE100", {
      ...BASE,
      serviceFeePayer: "proplane",
      serviceFeeWaiverCode: "free100",
    });
    expect(ok.status).toBe(200);
    expect(stored).toMatchObject({ serviceFeePayer: "proplane", serviceFeeWaiverCode: "FREE100" });

    // A legacy account already on `proplane` carries no code. An unrelated re-save
    // must keep it there rather than quietly moving Stripe's cost onto its residents.
    stored = { ...BASE, serviceFeePayer: "proplane" };
    const carried = await patch("A legacy 'proplane' account re-saving something else", {
      ...BASE,
      axisPaymentsEnabled: false,
      serviceFeePayer: "proplane",
    });
    expect(carried.status).toBe(200);
    expect(stored).toMatchObject({ serviceFeePayer: "proplane" });

    if (OUT) {
      mkdirSync(OUT, { recursive: true });
      writeFileSync(`${OUT}/manual-payment-settings-route.transcript.txt`, transcript.join("\n"), "utf8");
    }
  });
});
