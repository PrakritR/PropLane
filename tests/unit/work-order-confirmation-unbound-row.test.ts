import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const events = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => undefined));
vi.mock("@/lib/work-order-events.server", () => ({ workOrderEvent: events }));
vi.mock("@/lib/co-manager-notification-recipients.server", () => ({ resolvePropertyScopedManagerRecipientIds: async () => ["manager"] }));
import { resolveResidentConfirmation } from "@/lib/work-order-resident-confirmation.server";

const TOKEN = "old-token";

/** A row with a payload residentEmail but (optionally) no stored resident subject. */
function fixture(residentUserId: string | null) {
  const row = {
    id: "job", manager_user_id: "manager", vendor_user_id: null, resident_user_id: residentUserId,
    row_revision: 1, updated_at: "2026-01-01T00:00:00.123456+00:00",
    row_data: {
      title: "Leak", residentEmail: "payload@example.test",
      residentConfirmation: { tokenId: createHash("sha256").update(TOKEN, "utf8").digest("hex"), requestedAt: new Date().toISOString() },
    },
  };
  const db = { from(table: string) {
    const filters: Array<(r: typeof row) => boolean> = []; let patch: Record<string, unknown> | null = null;
    const q = {
      select: () => q, contains: () => q, limit: () => q,
      eq: (key: string, value: unknown) => { filters.push((r) => (r as unknown as Record<string, unknown>)[key] === value); return q; },
      update: (value: Record<string, unknown>) => { patch = value; return q; },
      maybeSingle: async () => {
        if (table === "profiles") return { data: null, error: null };
        if (patch) {
          if (!filters.every((f) => f(row))) return { data: null, error: null };
          Object.assign(row, patch);
          return { data: { id: row.id }, error: null };
        }
        return { data: { ...row }, error: null };
      },
    };
    return q;
  } };
  return db;
}

type Recipient = { audience: string; userId?: string; email?: string };
const recipientsOf = () => (events.mock.calls[0]?.[1] as { recipients: Recipient[] }).recipients;

it("old-token response on an unbound row records the manager event and notifies no resident", async () => {
  events.mockClear();
  const result = await resolveResidentConfirmation(fixture(null) as never, { token: TOKEN, verdict: "fixed" });
  expect(result).toMatchObject({ ok: true });
  expect(events).toHaveBeenCalledTimes(1);
  const recipients = recipientsOf();
  expect(recipients.filter((r) => r.audience === "resident")).toEqual([]);
  expect(recipients.some((r) => r.email === "payload@example.test")).toBe(false);
  expect(recipients).toContainEqual({ audience: "manager", userId: "manager" });
});

it("a row bound to a resident still notifies exactly that subject", async () => {
  events.mockClear();
  const result = await resolveResidentConfirmation(fixture("resident-1") as never, { token: TOKEN, verdict: "fixed" });
  expect(result).toMatchObject({ ok: true });
  expect(recipientsOf().filter((r) => r.audience === "resident")).toEqual([{ audience: "resident", userId: "resident-1" }]);
});
