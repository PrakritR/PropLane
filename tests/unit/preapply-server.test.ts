import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DemoApplicantRow } from "@/data/demo-portal";
import type { ApplicationBackgroundCheck } from "@/lib/checkr/types";

const h = vi.hoisted(() => ({
  settings: vi.fn(),
  create: vi.fn(),
  refund: vi.fn(),
  captured: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/screening/applicant-screening-settings.server", () => ({ resolveApplicantScreeningSettings: h.settings }));
vi.mock("@/lib/checkr/background-check", () => ({
  loadCheckrProperty: async () => ({ name: "House", street: "1 Pine", city: "Seattle", state: "WA", zipcode: "98101" }),
}));
vi.mock("@/lib/checkr/client", async (orig) => ({
  ...(await orig<typeof import("@/lib/checkr/client")>()),
  createBackgroundCheck: h.create,
  fetchBackgroundCheckReport: async () => null,
}));
vi.mock("@/lib/stripe", () => ({ getStripe: () => ({ refunds: { create: h.refund } }) }));
vi.mock("@/lib/test-workspaces/effects.server", () => ({ captureTestWorkspaceEffectForUser: h.captured }));
vi.mock("@/lib/auth/resident-role-access", () => ({ authorizeResidentRole: async () => true }));

import {
  fulfillPreApplyFromSession,
  preApplyGuestGate,
  preApplySubmitGate,
} from "@/lib/screening/preapply.server";

type TableConfig = { data?: unknown; error?: unknown; insertError?: { code?: string; message?: string } | null };
type Call = { table: string; op: string; payload?: unknown };

function fakeDb(config: Record<string, TableConfig>, calls: Call[] = []): SupabaseClient {
  return {
    from: (table: string) => {
      const cfg = config[table] ?? {};
      let op = "select";
      const chain: Record<string, unknown> = {};
      const settle = () => ({
        data: cfg.data ?? null,
        error: op === "insert" ? (cfg.insertError ?? null) : (cfg.error ?? null),
      });
      for (const name of ["select", "eq", "order", "limit", "filter", "in"]) chain[name] = () => chain;
      for (const name of ["insert", "upsert", "update"]) {
        chain[name] = (payload: unknown) => {
          op = name;
          calls.push({ table, op: name, payload });
          return chain;
        };
      }
      chain.maybeSingle = async () => settle();
      chain.single = async () => settle();
      chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(settle()).then(resolve);
      return chain;
    },
  } as unknown as SupabaseClient;
}

const row = (over: Partial<DemoApplicantRow> = {}): DemoApplicantRow =>
  ({ id: "app-1", propertyId: "prop-1", bucket: "pending", application: { propertyId: "prop-1" }, ...over }) as DemoApplicantRow;

function check(over: Partial<ApplicationBackgroundCheck> = {}): ApplicationBackgroundCheck {
  return {
    provider: "checkr",
    candidateId: "ap_1",
    reportId: "ord_1",
    packageSlug: "starter",
    addOnProducts: ["identity_verification"],
    status: "complete",
    result: "clear",
    reportSnapshot: { identity_verification: { status: "clear" } },
    orderedAt: "2026-11-12T00:00:00Z",
    ...over,
  };
}

const user = { id: "res-1", email: "jane@example.com" };
const property = { manager_property_records: { data: { id: "prop-1", manager_user_id: "mgr-1" } } };

beforeEach(() => {
  process.env.RESIDENT_IDENTITY_ENABLED = "true";
  delete process.env.RESIDENT_IDENTITY_PROVIDER;
  process.env.CHECKR_API_KEY = "ckr_test";
  delete process.env.CHECKR_SIMULATE;
  h.settings.mockReset().mockResolvedValue({ settings: { idCheck: true, backgroundCheck: true, idUnlock: "clear" } });
  h.create.mockReset();
  h.refund.mockReset().mockResolvedValue({});
  h.captured.mockReset().mockResolvedValue({ captured: false });
});

describe("server refusal: the application submit gate", () => {
  it("lets a listing that requires nothing through untouched", async () => {
    h.settings.mockResolvedValue({ settings: { idCheck: false, backgroundCheck: false, idUnlock: "clear" } });
    const r = row();
    const gate = await preApplySubmitGate(fakeDb(property), user, r);
    expect(gate).toEqual({ ok: true, row: r });
  });

  it("refuses a submit when a required step is not satisfied (403, blocked: preapply, names the step)", async () => {
    const gate = await preApplySubmitGate(fakeDb({ ...property, applicant_preapply_checks: { data: null } }), user, row());
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    expect(gate.status).toBe(403);
    expect(gate.body).toMatchObject({ blocked: "preapply", step: "verify_id", href: "/resident/profile?tab=profile#verification" });
  });

  it("refuses while the ID check is still pending (default unlock: when it clears)", async () => {
    const pending = check({ status: "pending", result: null, reportSnapshot: undefined });
    const gate = await preApplySubmitGate(
      fakeDb({ ...property, applicant_preapply_checks: { data: { id: "pc-1", application_id: null, check_data: pending } } }),
      user,
      row(),
    );
    expect(gate).toMatchObject({ ok: false, status: 403, body: { blocked: "preapply", step: "verify_id" } });
  });

  it("allows the submit once the ID is clear and stamps the applicant's Checkr order on the application", async () => {
    const calls: Call[] = [];
    const gate = await preApplySubmitGate(
      fakeDb({ ...property, applicant_preapply_checks: { data: { id: "pc-1", application_id: null, check_data: check() } } }, calls),
      user,
      row(),
    );
    expect(gate.ok).toBe(true);
    if (!gate.ok) return;
    expect(gate.row.backgroundCheck).toMatchObject({ reportId: "ord_1", status: "complete" });
    expect(gate.row.backgroundCheckStatus).toBeTruthy();
    expect(calls.some((c) => c.table === "applicant_preapply_checks" && c.op === "update")).toBe(true);
    expect(calls.some((c) => c.table === "screening_orders" && c.op === "upsert")).toBe(true);
  });

  it("fails closed when the requirement cannot be read", async () => {
    const gate = await preApplySubmitGate(fakeDb({ manager_property_records: { data: null, error: { message: "down" } } }), user, row());
    expect(gate).toMatchObject({ ok: false, status: 503, body: { blocked: "preapply_unavailable" } });
    h.settings.mockRejectedValue(new Error("settings down"));
    const second = await preApplySubmitGate(fakeDb(property), user, row());
    expect(second).toMatchObject({ ok: false, status: 503 });
  });

  it("Verify ID with a misconfigured provider is 'ID check unavailable' and refuses", async () => {
    process.env.RESIDENT_IDENTITY_PROVIDER = "stripe";
    const gate = await preApplySubmitGate(fakeDb({ ...property, applicant_preapply_checks: { data: null } }), user, row());
    expect(gate).toMatchObject({ ok: false, status: 403, body: { blocked: "preapply", error: "ID check unavailable." } });
  });

  it("the master switch off means no ID requirement is enforced", async () => {
    process.env.RESIDENT_IDENTITY_ENABLED = "false";
    h.settings.mockResolvedValue({ settings: { idCheck: true, backgroundCheck: false, idUnlock: "clear" } });
    const r = row();
    expect(await preApplySubmitGate(fakeDb(property), user, r)).toEqual({ ok: true, row: r });
  });

  it("Persona branch: the account's approved identity satisfies Verify ID with no order", async () => {
    process.env.RESIDENT_IDENTITY_PROVIDER = "persona";
    Object.assign(process.env, { PERSONA_API_KEY: "k", PERSONA_TEMPLATE_ID: "t", PERSONA_WEBHOOK_SECRET: "s" });
    h.settings.mockResolvedValue({ settings: { idCheck: true, backgroundCheck: false, idUnlock: "clear" } });
    const subject = (status: string) => ({
      ...property,
      resident_identity_subjects: { data: { status, provider_decision: status, verified_at: "2026-01-01T00:00:00Z" } },
    });
    expect((await preApplySubmitGate(fakeDb(subject("approved")), user, row())).ok).toBe(true);
    const refused = await preApplySubmitGate(fakeDb(subject("pending")), user, row());
    expect(refused).toMatchObject({ ok: false, status: 403, body: { blocked: "preapply", step: "verify_id" } });
    for (const key of ["PERSONA_API_KEY", "PERSONA_TEMPLATE_ID", "PERSONA_WEBHOOK_SECRET", "RESIDENT_IDENTITY_PROVIDER"]) delete process.env[key];
  });
});

describe("a signed-out submit", () => {
  it("is refused when the listing requires something, allowed when it requires nothing", async () => {
    const refused = await preApplyGuestGate(fakeDb(property), row());
    expect(refused).toMatchObject({ ok: false, status: 403, body: { blocked: "preapply" } });
    h.settings.mockResolvedValue({ settings: { idCheck: false, backgroundCheck: false, idUnlock: "clear" } });
    expect(await preApplyGuestGate(fakeDb(property), row())).toEqual({ ok: true });
  });
});

describe("fulfilling a paid pre-apply checkout", () => {
  const session = (over: Record<string, unknown> = {}) =>
    ({
      id: "cs_1",
      payment_status: "paid",
      payment_intent: "pi_1",
      client_reference_id: "res-1",
      customer_email: "jane@example.com",
      metadata: {
        purpose: "application_screening",
        preapply: "1",
        property_id: "prop-1",
        manager_user_id: "mgr-1",
        payer_user_id: "res-1",
        add_on_products: "identity_verification",
        fcra_authorized_at: "2026-11-12T00:00:00Z",
        fcra_disclosure_version: "2026-11-12",
        ...over,
      },
    }) as never;

  it("places ONE Starter + ID order for the applicant (no application exists), keyed on the session", async () => {
    h.create.mockResolvedValue({
      applicantId: "ap_1",
      orderId: "ord_1",
      packageSlug: "starter",
      addOnProducts: ["identity_verification"],
      status: "pending",
      result: null,
      simulated: false,
    });
    const calls: Call[] = [];
    const result = await fulfillPreApplyFromSession(
      fakeDb({ ...property, applicant_preapply_checks: { data: null }, profiles: { data: { full_name: "Jane Doe", email: "jane@example.com" } } }, calls),
      session(),
    );
    expect(result.ok).toBe(true);
    expect(h.create).toHaveBeenCalledTimes(1);
    const [applicant, , options] = h.create.mock.calls[0]!;
    expect(applicant).toMatchObject({ firstName: "Jane", lastName: "Doe", email: "jane@example.com", ssn: "" });
    expect(options).toEqual({ packageSlug: "starter", addOnProducts: ["identity_verification"] });
    const saved = calls.find((c) => c.table === "applicant_preapply_checks" && c.op === "upsert")?.payload as Record<string, unknown>;
    expect(saved).toMatchObject({ resident_user_id: "res-1", property_id: "prop-1", stripe_checkout_session_id: "cs_1", disclosure_version: "2026-11-12" });
    expect(calls.find((c) => c.table === "screening_orders" && c.op === "upsert")?.payload).toMatchObject({
      application_id: "preapply:res-1:prop-1",
      external_order_id: "ord_1",
    });
  });

  it("is idempotent on the session id: a redelivery orders nothing", async () => {
    const result = await fulfillPreApplyFromSession(
      fakeDb({ ...property, applicant_preapply_checks: { data: { id: "pc-1", application_id: null, check_data: check({ stripeCheckoutSessionId: "cs_1" }) } } }),
      session(),
    );
    expect(result).toMatchObject({ ok: true });
    expect(h.create).not.toHaveBeenCalled();
  });

  it("refunds a second payment for what a live order already covers", async () => {
    const result = await fulfillPreApplyFromSession(
      fakeDb({ ...property, applicant_preapply_checks: { data: { id: "pc-1", application_id: null, check_data: check({ stripeCheckoutSessionId: "cs_other" }) } } }),
      session(),
    );
    expect(result).toMatchObject({ ok: false, code: "already_screened" });
    expect(h.refund).toHaveBeenCalledWith(expect.objectContaining({ payment_intent: "pi_1" }));
    expect(h.create).not.toHaveBeenCalled();
  });

  it("refunds when Checkr refuses the order, and never orders without the FCRA authorization", async () => {
    h.create.mockRejectedValue(new Error("Checkr: nope"));
    const failed = await fulfillPreApplyFromSession(
      fakeDb({ ...property, applicant_preapply_checks: { data: null }, profiles: { data: { full_name: "Jane Doe", email: "jane@example.com" } } }),
      session(),
    );
    expect(failed).toMatchObject({ ok: false, code: "provider_error" });
    expect(h.refund).toHaveBeenCalledTimes(1);
    h.create.mockClear();
    const noAuth = await fulfillPreApplyFromSession(fakeDb(property), session({ fcra_authorized_at: "" }));
    expect(noAuth).toMatchObject({ ok: false, status: 400 });
    expect(h.create).not.toHaveBeenCalled();
  });

  it("refuses a session whose manager is not the listing's owner", async () => {
    await expect(fulfillPreApplyFromSession(fakeDb(property), session({ manager_user_id: "someone-else" }))).rejects.toThrow(/ownership/);
  });
});
