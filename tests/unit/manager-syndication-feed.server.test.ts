// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { getOrCreateManagerSyndicationFeedKey } from "@/lib/listing-syndication/manager-syndication-feed.server";

/**
 * W013: one Zillow feed per WORKSPACE. These tests exercise
 * `getOrCreateManagerSyndicationFeedKey` against an in-memory stand-in for
 * `manager_syndication_feeds`, covering the two guarantees the migration and
 * route depend on:
 *  - routing: two workspaces of the SAME manager never share a feed key.
 *  - the default-workspace migration path: a feed row that already exists
 *    for (manager, workspace) — exactly the shape
 *    `20260927134258_listing_syndication_per_workspace.sql` backfills a
 *    pre-existing single feed into — is returned unchanged rather than
 *    duplicated, so an already-registered Zillow feed URL keeps working.
 */

type Row = { manager_user_id: string; workspace_id: string; feed_key: string };

function fakeDb(rows: Row[]) {
  let nextKey = 0;
  return {
    from(table: string) {
      if (table !== "manager_syndication_feeds") throw new Error(`Unexpected table: ${table}`);
      let filters: Partial<Row> = {};
      const builder = {
        select: () => builder,
        eq(col: keyof Row, value: string) {
          filters = { ...filters, [col]: value };
          return builder;
        },
        maybeSingle: async () => {
          const match = rows.find(
            (r) => (!filters.manager_user_id || r.manager_user_id === filters.manager_user_id)
              && (!filters.workspace_id || r.workspace_id === filters.workspace_id),
          );
          return { data: match ? { feed_key: match.feed_key } : null, error: null };
        },
        insert: (values: { manager_user_id: string; workspace_id: string }) => ({
          select: () => ({
            single: async () => {
              const feed_key = `feed-${values.manager_user_id}-${values.workspace_id}-${nextKey++}`;
              rows.push({ manager_user_id: values.manager_user_id, workspace_id: values.workspace_id, feed_key });
              return { data: { feed_key }, error: null };
            },
          }),
        }),
      };
      return builder;
    },
  };
}

describe("getOrCreateManagerSyndicationFeedKey (W013 per-workspace routing)", () => {
  let rows: Row[];

  beforeEach(() => {
    rows = [];
  });

  it("creates a distinct feed for each workspace of the same manager", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = fakeDb(rows) as any;
    const keyA = await getOrCreateManagerSyndicationFeedKey(db, "mgr-1", "ws-a");
    const keyB = await getOrCreateManagerSyndicationFeedKey(db, "mgr-1", "ws-b");
    expect(keyA).not.toEqual(keyB);
    // Re-reading either workspace returns its own key, never the sibling's.
    await expect(getOrCreateManagerSyndicationFeedKey(db, "mgr-1", "ws-a")).resolves.toBe(keyA);
    await expect(getOrCreateManagerSyndicationFeedKey(db, "mgr-1", "ws-b")).resolves.toBe(keyB);
  });

  it("never lets one manager's workspace read another manager's feed key", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = fakeDb(rows) as any;
    const mineKey = await getOrCreateManagerSyndicationFeedKey(db, "mgr-1", "ws-shared-id");
    const theirsKey = await getOrCreateManagerSyndicationFeedKey(db, "mgr-2", "ws-shared-id");
    expect(mineKey).not.toEqual(theirsKey);
  });

  it("default-workspace migration path: a feed already backfilled onto (manager, defaultWorkspace) is reused, not duplicated", async () => {
    // Simulates the exact post-migration state: an EXISTING single feed row
    // (created before W013) now carries the owner's default workspace id,
    // written by `20260927134258_listing_syndication_per_workspace.sql`'s
    // backfill rather than by this function.
    rows.push({ manager_user_id: "mgr-legacy", workspace_id: "ws-default", feed_key: "feed-already-registered-with-zillow" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = fakeDb(rows) as any;
    const key = await getOrCreateManagerSyndicationFeedKey(db, "mgr-legacy", "ws-default");
    expect(key).toBe("feed-already-registered-with-zillow");
    expect(rows).toHaveLength(1); // no duplicate row created
  });
});
