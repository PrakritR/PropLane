// The tour-slot page is the first 40 slots from today; a prospect who names "Thursday" is only served when the
// model passes the date. Found by the end-to-end harness (the agent said "no slots this Thursday" with slots open).
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: vi.fn() }));

import { listOpenTourSlotsTool } from "@/lib/tools/domains/tours";

describe("list_open_tour_slots guidance", () => {
  it("tells the model to pass the day a person names", () => {
    expect(listOpenTourSlotsTool.description).toMatch(/fromDate\/toDate/);
    expect(listOpenTourSlotsTool.description).toMatch(/at most 40 slots/);
  });
});
