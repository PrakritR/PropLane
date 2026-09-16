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

// The workspace rule is its own module with its own coverage; here the account
// is an owner, so the workspace address IS their own row.
vi.mock("@/lib/sms/manager-workspace-role.server", () => ({
  isPureCoManagerWorkspace: async () => false,
  listWorkspaceOwnersForCoManager: async () => [],
  readSelectedWorkspaceIdSafely: async () => undefined,
}));
// An owner acting in their own default workspace; the address is that workspace's row.
vi.mock("@/lib/workspaces/active.server", () => ({
  resolveActiveWorkspace: async (_db: unknown, viewerUserId: string) => ({
    id: `ws-${viewerUserId}`,
    name: "My workspace",
    ownerUserId: viewerUserId,
    owned: true,
    isDefault: true,
    propertyIds: [],
  }),
  listViewerWorkspaces: async (_db: unknown, viewerUserId: string) => [
    { id: `ws-${viewerUserId}`, name: "My workspace", ownerUserId: viewerUserId, owned: true, isDefault: true, propertyIds: [] },
  ],
  ensureDefaultWorkspaceId: async (_db: unknown, ownerUserId: string) => `ws-${ownerUserId}`,
  loadWorkspaceById: async () => null,
}));

import {
  isAssistantEmailReceivingEnabled,
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
        // The legacy-row fallback filters on `workspace_id is null`.
        is: () => chain,
        // The profiles read the workspace resolver makes for owner names.
        in: async () => ({ data: [], error: null }),
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
  workspace_id: "ws-m1",
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

  /**
   * "Can answer" is both directions. On Vercel the inbound webhook rejects
   * everything until the signing secret is set, so an address there can send
   * and never hear a reply — production advertised exactly that for weeks.
   */
  it("returns null on Vercel until the inbound webhook secret is set, without reading the row", async () => {
    vi.stubEnv("RESEND_API_KEY", "test-key");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("RESEND_INBOUND_WEBHOOK_SECRET", "");
    const db = dbWith(ACTIVE_ROW);
    expect(isAssistantEmailReceivingEnabled()).toBe(false);
    expect(await resolveActiveManagerWorkEmail(db, "m1")).toBeNull();
    expect(db.reads()).toBe(0);
  });

  it("returns the address on Vercel once the inbound webhook secret is set", async () => {
    vi.stubEnv("RESEND_API_KEY", "test-key");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("RESEND_INBOUND_WEBHOOK_SECRET", "whsec_test");
    expect(await resolveActiveManagerWorkEmail(dbWith(ACTIVE_ROW), "m1")).toBe(ADDRESS);
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
