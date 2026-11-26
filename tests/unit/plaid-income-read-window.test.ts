/**
 * The window the bank is ASKED for is the one window the figure is measured over and the manager's line names.
 *
 * Oracle: docs/agents/plaid.md § Income check — the Transactions request and the deposits counted are the same
 * window, owned by `INCOME_WINDOW_DAYS` in `income-calc.ts`. This file moves that constant (the boundary module is
 * mocked) and asks whether the Plaid request follows it; a read pinned to its own literal does not, which is how a
 * longer measured window would end up divided into a 90-day history and understate every verified figure.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: vi.fn() }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: vi.fn() }));

/** A window deliberately unlike today's 90, so a read pinned to its own literal cannot follow it. */
const { WINDOW_DAYS } = vi.hoisted(() => ({ WINDOW_DAYS: 120 }));

vi.mock("@/lib/plaid/income-calc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/plaid/income-calc")>()),
  INCOME_WINDOW_DAYS: WINDOW_DAYS,
}));

import { computeIncomeFromPublicToken, createIncomeLinkToken } from "@/lib/plaid/income.server";

const NOW = new Date("2026-11-18T12:00:00.000Z");

function fakePlaid() {
  return {
    itemPublicTokenExchange: vi.fn(async () => ({ data: { access_token: "access-sandbox-secret", item_id: "item-1" } })),
    accountsGet: vi.fn(async () => ({ data: { accounts: [], item: { institution_id: "ins_1" } } })),
    institutionsGetById: vi.fn(async () => ({ data: { institution: { name: "First Platypus Bank" } } })),
    transactionsGet: vi.fn(async () => ({ data: { transactions: [], total_transactions: 0 } })),
    itemRemove: vi.fn(async () => ({ data: {} })),
  };
}

describe("the Plaid read follows the one income window", () => {
  it("asks Link and /transactions/get for the window the calculator owns", async () => {
    const linkTokenCreate = vi.fn(async () => ({ data: { link_token: "link-sandbox-1" } }));
    await createIncomeLinkToken("user-1", { linkTokenCreate } as never);
    expect(linkTokenCreate.mock.calls[0]![0]).toMatchObject({ transactions: { days_requested: WINDOW_DAYS } });

    const client = fakePlaid();
    await computeIncomeFromPublicToken({ publicToken: "public-sandbox-x", now: NOW, wait: async () => undefined }, client as never);
    const asked = client.transactionsGet.mock.calls[0]![0] as { start_date: string; end_date: string };
    expect(asked.end_date).toBe("2026-11-18");
    expect((Date.parse(`${asked.end_date}T00:00:00Z`) - Date.parse(`${asked.start_date}T00:00:00Z`)) / 86_400_000).toBe(
      WINDOW_DAYS,
    );
  });
});
