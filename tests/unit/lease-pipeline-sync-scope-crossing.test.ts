// @vitest-environment jsdom
/**
 * Two callers sync the lease pipeline at page load: the sidebar prefetch before
 * the session resolves (scope null) and the page hook right after (scope = the
 * manager). Reusing one in-flight promise across those scopes let the
 * null-scoped completion reset the active scope and wipe the manager's rows —
 * Bookings drew zero stays on a fresh route load.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// jsdom's default location is "/" which counts as the public demo surface.
vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
}));

const MANAGER = "mgr-1";
const serverRows = [
  {
    id: "lease-1",
    managerUserId: MANAGER,
    residentName: "Ada",
    residentEmail: "ada@example.com",
    propertyId: "house-1",
    status: "Fully Signed",
    fullySignedAt: "2026-08-01T00:00:00Z",
    application: { leaseStart: "2026-09-20" },
  },
];

const pending: Array<() => void> = [];
const release = () => {
  for (const resolve of pending.splice(0)) resolve();
};

beforeEach(() => {
  vi.resetModules();
  pending.length = 0;
  window.sessionStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          pending.push(() =>
            resolve(
              new Response(JSON.stringify({ rows: serverRows }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
              }),
            ),
          );
        }),
    ),
  );
});

describe("syncLeasePipelineFromServer across scopes", () => {
  it("a manager-scoped call never adopts the null-scoped request in flight, and keeps its rows", async () => {
    const mod = await import("@/lib/lease-pipeline-storage");
    const nullScoped = mod.syncLeasePipelineFromServer(null);
    const managerScoped = mod.syncLeasePipelineFromServer(MANAGER);
    expect(fetch).toHaveBeenCalledTimes(2);

    release();
    await Promise.resolve();
    const [, mine] = await Promise.all([nullScoped, managerScoped]);

    expect(mine.map((row) => row.id)).toEqual(["lease-1"]);
    expect(mod.readLeasePipeline(MANAGER).map((row) => row.id)).toEqual(["lease-1"]);
  });

  it("still shares one request between two calls for the same scope", async () => {
    const mod = await import("@/lib/lease-pipeline-storage");
    const a = mod.syncLeasePipelineFromServer(MANAGER);
    const b = mod.syncLeasePipelineFromServer(MANAGER);
    expect(fetch).toHaveBeenCalledTimes(1);
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toEqual(rb);
  });
});
