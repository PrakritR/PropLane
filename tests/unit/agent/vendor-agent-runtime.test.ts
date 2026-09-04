import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  buildAlternatingHistory,
  deliverVendorAgentReply,
  resolveVendorAgentSessionForInbound,
} from "@/lib/agent/vendor-agent.server";
import { buildRegistry, defineTool, defineWriteTool, runReadTool, toAnthropicTools } from "@/lib/tools/registry";
import { buildVendorAgentContext } from "@/lib/tools/context";
import { sendSms } from "@/lib/twilio";

vi.mock("@/lib/twilio", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/twilio")>();
  return { ...actual, sendSms: vi.fn(async () => ({ sent: true })) };
});

describe("buildAlternatingHistory", () => {
  it("merges consecutive same-role rows and drops a leading assistant run", () => {
    const history = buildAlternatingHistory([
      { role: "assistant", content: "opening" },
      { role: "user", content: "hola" },
      { role: "user", content: "cual es el codigo?" },
      { role: "assistant", content: "un momento" },
      { role: "user", content: "gracias" },
    ]);
    expect(history).toEqual([
      { role: "user", content: "hola\ncual es el codigo?" },
      { role: "assistant", content: "un momento" },
      { role: "user", content: "gracias" },
    ]);
  });

  it("drops empty rows", () => {
    expect(buildAlternatingHistory([{ role: "user", content: "  " }])).toEqual([]);
  });
});

describe("vendor inbound work-order reference routing", () => {
  const sessions = [
    {
      id: "newest",
      work_order_id: "opaque-new",
      vendor_phone_e164: "+12065550001",
      status: "active",
    },
    {
      id: "older",
      work_order_id: "opaque-old",
      vendor_phone_e164: "+12065550001",
      status: "active",
    },
  ];

  function referenceDb(rows: Array<{ id: string; row_data: Record<string, unknown> }>) {
    return {
      from(table: string) {
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: () => chain,
          order: () => chain,
          limit: () => chain,
          in: (_column: string, values: string[]) => {
            if (table === "portal_work_order_records") {
              return Promise.resolve({ data: rows.filter((item) => values.includes(item.id)), error: null });
            }
            return chain;
          },
          then: (resolve: (value: unknown) => unknown) =>
            Promise.resolve({ data: table === "agent_sessions" ? sessions : [], error: null }).then(resolve),
        };
        return chain;
      },
    } as never;
  }

  it("routes a reference to an older authorized job instead of the newest session", async () => {
    const result = await resolveVendorAgentSessionForInbound(
      referenceDb([
        { id: "opaque-new", row_data: { id: "opaque-new", reference: "WO-1001", title: "Fan" } },
        { id: "opaque-old", row_data: { id: "opaque-old", reference: "WO-1000", title: "Sink" } },
      ]),
      "+12065550001",
      "status WO-1000",
    );
    expect(result).toMatchObject({
      kind: "session",
      session: { id: "older", work_order_id: "opaque-old" },
      reference: { id: "opaque-old", reference: "WO-1000" },
    });
  });

  it("uses the same generic reply for an unknown or out-of-scope reference", async () => {
    const result = await resolveVendorAgentSessionForInbound(
      referenceDb([{ id: "opaque-new", row_data: { id: "opaque-new", reference: "WO-1001", title: "Fan" } }]),
      "+12065550001",
      "WO-9999",
    );
    expect(result).toMatchObject({ kind: "reply", reply: "We can't find that work order." });
  });
});

describe("write-tool allowlist", () => {
  const readTool = defineTool({
    name: "read_thing",
    description: "read",
    kind: "read",
    inputSchema: z.object({}).strict(),
    handler: async () => ({ ok: true }),
  });
  const writeTool = defineWriteTool({
    name: "write_thing",
    description: "write",
    inputSchema: z.object({}).strict(),
    preview: async () => ({ kind: "write_thing", title: "Write", confirmLabel: "Do it", fields: [] }),
    handler: async () => ({ wrote: true }),
  });
  const registry = buildRegistry([readTool, writeTool]);
  const ctx = buildVendorAgentContext({} as never, {
    landlordId: "mgr-a",
    scope: { sessionId: "s", vendorDirectoryId: "v", vendorUserId: null, workOrderId: "w" },
  });

  it("write tools stay hidden and refused by default", async () => {
    expect(toAnthropicTools(registry, { readOnly: true }).map((t) => t.name)).toEqual(["read_thing"]);
    const refused = await runReadTool(registry, ctx, "write_thing", {});
    expect(refused.ok).toBe(false);
  });

  it("only an explicitly allowlisted write tool becomes callable", async () => {
    expect(toAnthropicTools(registry, { readOnly: true, allowWrite: ["write_thing"] }).map((t) => t.name)).toEqual([
      "read_thing",
      "write_thing",
    ]);
    const allowed = await runReadTool(registry, ctx, "write_thing", {}, { allowWrite: ["write_thing"] });
    expect(allowed).toEqual({ ok: true, data: { wrote: true } });

    // Allowlisting one write never opens another.
    const other = await runReadTool(registry, ctx, "write_thing", {}, { allowWrite: ["different_tool"] });
    expect(other.ok).toBe(false);
  });
});

// The vendor gate must agree with the unified send choke point: a STOP on one
// store followed by a later START on the other re-enables the SMS leg.
describe("vendor SMS gate follows the unified cross-store consent read", () => {
  const EARLIER = "2026-07-24T00:00:00.000Z";
  const LATER = "2026-07-26T00:00:00.000Z";

  type ProfileRow = { phone: string | null; sms_opt_out_at?: string | null; sms_consent_at?: string | null };
  type ConsentRow = { phone: string; opted_in_at?: string | null; opted_out_at?: string | null };

  function makeDb(opts: { profile: ProfileRow | null; consent?: ConsentRow[] }) {
    return {
      from(table: string) {
        if (table === "profiles") {
          let phones: string[] | null = null;
          const chain: Record<string, unknown> = {
            select: () => chain,
            eq: () => chain,
            in: (_col: string, vals: string[]) => {
              phones = vals;
              return chain;
            },
            maybeSingle: async () => ({ data: opts.profile, error: null }),
            then: (resolve: (v: unknown) => unknown) =>
              Promise.resolve({
                data:
                  opts.profile && phones && phones.includes(String(opts.profile.phone ?? ""))
                    ? [opts.profile]
                    : [],
                error: null,
              }).then(resolve),
          };
          return chain;
        }
        if (table === "sms_consent") {
          let key: string | null = null;
          const chain: Record<string, unknown> = {
            select: () => chain,
            eq: (_col: string, val: string) => {
              key = val;
              return chain;
            },
            maybeSingle: async () => ({
              data: (opts.consent ?? []).find((r) => r.phone === key) ?? null,
              error: null,
            }),
          };
          return chain;
        }
        throw new Error(`unexpected table ${table}`);
      },
    } as never;
  }

  const session = {
    id: "sess-1",
    vendor_user_id: "vendor-1",
    vendor_phone_e164: "+15551234567",
    inbox_thread_id: null,
  } as never;

  beforeEach(() => {
    vi.mocked(sendSms).mockClear();
    process.env.AXIS_AGENT_SMS_FROM = "+15550009999";
  });

  it("sends after STOP on profiles then START recorded only on the ledger", async () => {
    const db = makeDb({
      profile: { phone: "(555) 123-4567", sms_opt_out_at: EARLIER, sms_consent_at: null },
      consent: [{ phone: "5551234567", opted_in_at: LATER }],
    });
    await deliverVendorAgentReply(db, session, "hello", "sms");
    expect(vi.mocked(sendSms)).toHaveBeenCalledWith("+15551234567", "hello", "+15550009999");
  });

  it("stays muted when the profiles STOP is newer than the ledger opt-in", async () => {
    const db = makeDb({
      profile: { phone: "(555) 123-4567", sms_opt_out_at: LATER, sms_consent_at: null },
      consent: [{ phone: "5551234567", opted_in_at: EARLIER }],
    });
    await deliverVendorAgentReply(db, session, "hello", "sms");
    expect(vi.mocked(sendSms)).not.toHaveBeenCalled();
  });

  it("stays muted for a legacy user-keyed STOP with an unmatchable profile phone", async () => {
    // Pre-ledger STOP: sms_opt_out_at set, profiles.phone empty, no ledger row.
    const db = makeDb({
      profile: { phone: "", sms_opt_out_at: EARLIER, sms_consent_at: null },
      consent: [],
    });
    await deliverVendorAgentReply(db, session, "hello", "sms");
    expect(vi.mocked(sendSms)).not.toHaveBeenCalled();
  });
});
