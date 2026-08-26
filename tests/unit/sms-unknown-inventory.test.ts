import { describe, expect, it } from "vitest";
import { loadUnknownSmsInventory } from "@/lib/sms/owner-sms-dispatcher.server";

function dbResult(input: {
  rows?: Array<{ id: string }>;
  count?: number | null;
  error?: { message: string } | null;
}) {
  const builder: Record<string, unknown> = {};
  builder.select = () => builder;
  builder.eq = () => builder;
  builder.order = () => builder;
  builder.limit = async () => ({
    data: input.rows ?? [],
    count: input.count ?? null,
    error: input.error ?? null,
  });
  return { from: () => builder };
}

describe("unknown SMS operator inventory", () => {
  it("returns a durable backlog count with bounded non-PII outbox ids", async () => {
    const result = await loadUnknownSmsInventory(
      dbResult({
        rows: [{ id: "outbox-1" }, { id: "outbox-2" }],
        count: 7,
      }) as never,
    );

    expect(result).toEqual({
      ok: true,
      count: 7,
      outboxIds: ["outbox-1", "outbox-2"],
    });
  });

  it("fails visibly when the operator inventory cannot be read", async () => {
    await expect(
      loadUnknownSmsInventory(
        dbResult({ error: { message: "database unavailable" } }) as never,
      ),
    ).resolves.toEqual({ ok: false, error: "database unavailable" });
  });
});
