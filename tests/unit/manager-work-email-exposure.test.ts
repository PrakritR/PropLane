// @vitest-environment node
/**
 * An address we show to somebody else must be able to answer them.
 *
 * The phone has always gone through `resolveActiveManagerSendNumber` — "only a
 * number that can actually receive a text" — because a number that cannot is
 * worse than none: the resident texts it and hears nothing, which reads as
 * being ignored by their manager. The work email was read straight off the row,
 * so a deployment with mail switched off still handed every resident, welcome
 * email and public listing an address that silently swallowed their message.
 *
 * These drive the real functions against a stub database rather than mocking
 * the module's own exports: `resolveActiveManagerWorkEmail` calls
 * `loadManagerAssistantEmail` internally, which a partial module mock never
 * intercepts, and the test would pass while proving nothing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  isAssistantEmailSendingEnabled,
  resolveActiveManagerWorkEmail,
} from "@/lib/manager-assistant-email/manager-assistant-email.server";
import { resolveListingCtaEmail } from "@/lib/listing-cta-email.server";

const ADDRESS = "assist-jane@prop-lane.space";

/** Just enough Supabase for the one `manager_assistant_emails` read. */
function dbWith(row: Record<string, unknown> | null, opts: { throws?: boolean } = {}) {
  let reads = 0;
  const db = {
    reads: () => reads,
    from() {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => {
          reads += 1;
          if (opts.throws) throw new Error("db down");
          return { data: row, error: null };
        },
      };
      return chain;
    },
  };
  return db as unknown as SupabaseClient & { reads: () => number };
}

const ACTIVE_ROW = {
  manager_user_id: "m1",
  inbox_token: "tok123456789",
  mailbox_local: "assist-jane",
  provision_state: "active",
};

afterEach(() => vi.unstubAllEnvs());

describe("resolveActiveManagerWorkEmail", () => {
  it("returns the address when this deployment can send mail", async () => {
    vi.stubEnv("RESEND_API_KEY", "test-key");
    expect(isAssistantEmailSendingEnabled()).toBe(true);
    expect(await resolveActiveManagerWorkEmail(dbWith(ACTIVE_ROW), "m1")).toBe(ADDRESS);
  });

  it("returns null when mail is off, without even reading the row", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    const db = dbWith(ACTIVE_ROW);
    expect(isAssistantEmailSendingEnabled()).toBe(false);
    expect(await resolveActiveManagerWorkEmail(db, "m1")).toBeNull();
    expect(db.reads()).toBe(0);
  });

  it("returns null when the manager has no address", async () => {
    vi.stubEnv("RESEND_API_KEY", "test-key");
    expect(await resolveActiveManagerWorkEmail(dbWith(null), "m1")).toBeNull();
  });

  it("returns null for a released mailbox", async () => {
    vi.stubEnv("RESEND_API_KEY", "test-key");
    const released = { ...ACTIVE_ROW, provision_state: "released" };
    expect(await resolveActiveManagerWorkEmail(dbWith(released), "m1")).toBeNull();
  });
});

describe("resolveListingCtaEmail", () => {
  it("publishes a live work email for that listing's own manager", async () => {
    vi.stubEnv("RESEND_API_KEY", "test-key");
    expect(await resolveListingCtaEmail(dbWith(ACTIVE_ROW), "m1")).toBe(ADDRESS);
  });

  it("publishes nothing when mail is off, so no dead mailto: reaches a listing", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    expect(await resolveListingCtaEmail(dbWith(ACTIVE_ROW), "m1")).toBeNull();
  });

  it.each([null, undefined, "", "  "])("publishes nothing for manager id %s", async (id) => {
    vi.stubEnv("RESEND_API_KEY", "test-key");
    expect(await resolveListingCtaEmail(dbWith(ACTIVE_ROW), id)).toBeNull();
  });

  it("never throws a listing page — an unreadable mailbox is just no button", async () => {
    vi.stubEnv("RESEND_API_KEY", "test-key");
    await expect(resolveListingCtaEmail(dbWith(null, { throws: true }), "m1")).resolves.toBeNull();
  });
});
