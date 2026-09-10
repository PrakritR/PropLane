import { describe, expect, it } from "vitest";
import { closeRelayThreadsForUser } from "@/lib/sms-relay.server";

describe("account deletion relay cleanup", () => {
  it("rediscovers phone-only bindings on retry after cooldown fails", async () => {
    type Row = Record<string, unknown>;
    const rows: Record<string, Row[]> = {
      profiles: [{ id: "user", phone: "+12065550123", phone_verified_at: "2026-09-01" }],
      sms_relay_bindings: [{ id: "binding", user_id: null, participant_phone: "+12065550123", thread_id: "thread", active: true }],
      sms_relay_threads: [{ id: "thread", manager_user_id: "another-manager", proxy_number_id: "number", state: "open" }],
      sms_relay_numbers: [{ id: "number", status: "assigned" }],
    };
    let failCooldown = true;
    const db = {
      from(table: string) {
        const filters: ((row: Row) => boolean)[] = [];
        let patch: Row | undefined;
        const run = () => {
          if (table === "sms_relay_numbers" && patch && failCooldown) {
            failCooldown = false;
            return { data: null, error: { code: "57014", message: "cooldown failed" } };
          }
          const found = rows[table].filter(row => filters.every(filter => filter(row)));
          if (patch) for (const row of found) Object.assign(row, patch);
          return { data: found, error: null };
        };
        const query = {
          select: () => query,
          update(value: Row) { patch = value; return query; },
          eq(key: string, value: unknown) { filters.push(row => row[key] === value); return query; },
          order: () => query,
          range: () => query,
          maybeSingle: async () => { const result = run(); return { ...result, data: result.data?.[0] }; },
          then(resolve: (result: ReturnType<typeof run>) => void) { resolve(run()); },
        };
        return query;
      },
    };

    await expect(closeRelayThreadsForUser(db as never, "user")).rejects.toThrow("cooldown failed");
    expect(rows.sms_relay_bindings[0].active).toBe(false);
    expect(rows.sms_relay_threads[0].state).toBe("open");
    await closeRelayThreadsForUser(db as never, "user");
    expect(rows.sms_relay_numbers[0].status).toBe("cooldown");
    expect(rows.sms_relay_threads[0].state).toBe("closed");
  });
});
