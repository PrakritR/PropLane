import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
vi.mock("server-only", () => ({}));
import { loadAutomatedMessageSettings } from "@/lib/automated-messages-settings.server";
import { LISTING_SHARED_TEMPLATE_KEY } from "@/lib/listing-shared-template";

describe("manual listing template exception", () => {
  it("reads the saved listing intro while other automated notices remain fixed", async () => {
    const template = { enabled: true, template: { subject: "", body: "Hi {first_name}, view {homes}" } };
    const db = {
      from: (table: string) => {
        expect(table).toBe("manager_automation_settings");
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  row_data: {
                    automatedMessages: {
                      [LISTING_SHARED_TEMPLATE_KEY]: template,
                      "lease:signed:resident": { enabled: false, template: { subject: "Changed", body: "Changed" } },
                    },
                  },
                },
                error: null,
              }),
            }),
          }),
        };
      },
    } as unknown as SupabaseClient;
    const loaded = await loadAutomatedMessageSettings(db, "manager");
    expect(loaded[LISTING_SHARED_TEMPLATE_KEY]).toEqual(template);
    expect(loaded["lease:signed:resident"]).toEqual({
      enabled: false,
      template: { subject: "Changed", body: "Changed" },
    });
  });
});
