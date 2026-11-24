// An explicit pick lasts 12 hours FROM THE PICK, not from the last text it routed.
//
// Oracle: docs/agents/one-number.md § Who is the sender texting as, order item 5 - "a pick the sender MADE themselves
// ... for 12 hours FROM THAT PICK ... texting all day never renews the window", and item 6, the workspace's own work
// number. The plausible wrong behaviour this rejects is the renewal the state write used to perform: a sender who
// switched to their resident context once and then kept texting a MANAGER workspace's own number would be answered -
// and billed - as a resident of someone else's workspace indefinitely.
//
// This drives the real persistence (`resolveSenderContext`), because the renewal lived in the state write, not in the
// pure decision.
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const loaders = vi.hoisted(() => ({
  memberships: vi.fn(),
  profile: vi.fn(),
  residencies: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/one-number/line-member-status.server", () => ({ listLineMemberships: loaders.memberships }));
vi.mock("@/lib/one-number/router-lookups.server", () => ({
  findVerifiedProfileByPhone: loaders.profile,
  findResidentCandidates: loaders.residencies,
}));
vi.mock("@/lib/sms/service-manager-inbound.server", () => ({
  holdsAdminRole: vi.fn(async () => false),
  listServiceWorkspaceRefs: vi.fn(async () => []),
}));

import { resolveSenderContext } from "@/lib/sms/sender-context.server";

const PHONE = "+12065550142";
const SENDER = "u1";
const T0 = Date.parse("2026-11-24T08:00:00Z");
const hours = (n: number) => n * 60 * 60 * 1000;

type Stored = { pending_candidates: Record<string, unknown>; pending_asked_at: string };

/** Only what this module persists: the two `sms_line_sessions` rows, plus an empty houses read. */
function fakeDb(rows: Map<string, Stored>) {
  return {
    from(table: string) {
      const q: Record<string, unknown> = {};
      let key = "";
      let deleting = false;
      for (const chained of ["select", "in", "limit", "not", "or", "is", "order"]) q[chained] = () => q;
      q.eq = (column: string, value: string) => {
        if (column === "phone_key") key = value;
        return q;
      };
      q.maybeSingle = async () => ({ data: rows.get(key) ?? null, error: null });
      q.upsert = async (row: Record<string, unknown>) => {
        rows.set(String(row.phone_key), {
          pending_candidates: row.pending_candidates as Record<string, unknown>,
          pending_asked_at: String(row.pending_asked_at),
        });
        return { error: null };
      };
      q.delete = () => {
        deleting = true;
        return q;
      };
      q.then = (onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) => {
        if (deleting) rows.delete(key);
        const answer = { data: table === "sms_line_sessions" ? null : [], error: null };
        return Promise.resolve(answer).then(onFulfilled, onRejected);
      };
      return q;
    },
  } as never;
}

const text = (db: never, body: string, messageSid: string) =>
  resolveSenderContext(db, { actorUserId: SENDER, fromPhone: PHONE, body, messageSid, numberWorkspaceId: "ws-mine" });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  loaders.memberships.mockResolvedValue([
    { workspaceId: "ws-mine", workspaceName: "My workspace", ownerUserId: SENDER, isDefault: true, kind: "owner", viewOnly: false, isService: false, teamRole: null },
  ]);
  loaders.profile.mockResolvedValue({ id: SENDER, email: "sender@example.com" });
  loaders.residencies.mockResolvedValue([
    { workspaceId: "ws-res", ownerUserId: "u9", role: "resident", reason: "lease", propertyId: "p9", label: "88 Pine St", generalArea: null },
  ]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("an explicit sender-context pick on a workspace's own work number", () => {
  it("holds for 12 hours from the pick and is never renewed by the texts it routes", async () => {
    const rows = new Map<string, Stored>();
    const db = fakeDb(rows);

    expect(await text(db, "switch to resident", "SM1")).toMatchObject({ kind: "reply" });

    vi.setSystemTime(T0 + hours(6));
    expect(await text(db, "my sink leaks", "SM2")).toMatchObject({
      kind: "run",
      source: "sticky",
      resolved: { context: { key: "resident:ws-res" } },
    });

    vi.setSystemTime(T0 + hours(13));
    expect(await text(db, "the sink is still leaking", "SM3")).toMatchObject({
      kind: "run",
      source: "number",
      resolved: { context: { key: "manager:ws-mine" } },
    });
  });

  it("a context we only inferred never outranks that number at all", async () => {
    const rows = new Map<string, Stored>();
    const db = fakeDb(rows);

    expect(await text(db, "status on 88 Pine St", "SM1")).toMatchObject({
      kind: "run",
      source: "named",
      resolved: { context: { key: "resident:ws-res" } },
    });

    vi.setSystemTime(T0 + hours(1));
    expect(await text(db, "my sink leaks", "SM2")).toMatchObject({
      kind: "run",
      source: "number",
      resolved: { context: { key: "manager:ws-mine" } },
    });
  });
});
