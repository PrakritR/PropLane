/**
 * `collectLinkedPropertyPermissionsForUser({ strict: true })` is what lets a caller act on the
 * ABSENCE of a grant (the orphan-housing sweep deletes rows the live set does not cover). A read
 * that failed to answer must therefore throw, not read as "no linked properties" — and the table
 * name appearing in the message is NOT evidence the table is missing: a permission error, a
 * dropped column and a schema-cache mismatch all name it too.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

let RESULT: { data: unknown; error: unknown } = { data: [], error: null };

const db = {
  from() {
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: () => builder,
      then: (resolve: (v: typeof RESULT) => unknown) => Promise.resolve(RESULT).then(resolve),
    };
    return builder;
  },
} as unknown as Parameters<typeof import("@/lib/auth/manager-lease-scope").collectLinkedPropertyPermissionsForUser>[0];

async function collect(options?: { strict?: boolean }) {
  const { collectLinkedPropertyPermissionsForUser } = await import("@/lib/auth/manager-lease-scope");
  return collectLinkedPropertyPermissionsForUser(db, "mgr-1", options);
}

beforeEach(() => {
  RESULT = { data: [], error: null };
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("collectLinkedPropertyPermissionsForUser strict", () => {
  it("throws on a permission error that merely names the table", async () => {
    RESULT = { data: null, error: { code: "42501", message: 'permission denied for table account_link_invites' } };
    await expect(collect({ strict: true })).rejects.toThrow(/lookup failed/i);
  });

  it("throws on a column error on that table", async () => {
    RESULT = { data: null, error: { code: "42703", message: 'column account_link_invites.team_role is ambiguous' } };
    await expect(collect({ strict: true })).rejects.toThrow(/lookup failed/i);
  });

  it("still reads a genuinely missing table as no links", async () => {
    RESULT = { data: null, error: { code: "PGRST205", message: "Could not find the table 'public.account_link_invites' in the schema cache" } };
    expect((await collect({ strict: true })).size).toBe(0);
    RESULT = { data: null, error: { code: "42P01", message: 'relation "account_link_invites" does not exist' } };
    expect((await collect({ strict: true })).size).toBe(0);
  });

  it("degrades to an empty map for a non-strict list read", async () => {
    RESULT = { data: null, error: { code: "42501", message: 'permission denied for table account_link_invites' } };
    expect((await collect()).size).toBe(0);
  });
});
