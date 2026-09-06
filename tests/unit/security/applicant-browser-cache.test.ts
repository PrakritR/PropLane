// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DemoApplicantRow } from "@/data/demo-portal";
vi.mock("@/lib/demo/demo-session", () => ({ isDemoModeActive: () => false }));

function row(id: string): DemoApplicantRow {
  return { id, name: "Synthetic", property: "Test", stage: "In progress", bucket: "pending", detail: "",
    application: { ssn: "123-45-6789", dateOfBirth: "1990-01-01", driversLicense: "SYNTHETIC" } } as DemoApplicantRow;
}
async function modules() {
  const cache = await import("@/lib/manager-applications-storage");
  const session = await import("@/lib/auth/portal-session-gate");
  session.setPortalSessionViewer("manager-a");
  session.markPortalSessionActive();
  return { cache, session };
}
beforeEach(() => { vi.resetModules(); sessionStorage.clear(); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("applicant browser confidentiality", () => {
  it("purges old row mirrors without hydrating identity answers or persisting new ones", async () => {
    sessionStorage.setItem("axis:manager-applications:v2:manager-a", JSON.stringify([row("PROPLANE-OLD")]));
    sessionStorage.setItem("axis:manager-applications:v2:shared", JSON.stringify([row("PROPLANE-SHARED")]));
    const { cache } = await modules();
    expect(cache.readManagerApplicationRows()).toEqual([]);
    cache.replaceManagerApplicationRowInCache(row("PROPLANE-NEW"));
    expect(cache.readManagerApplicationRows()).toHaveLength(1);
    expect(sessionStorage.length).toBe(0);
  });
  it.each([401, 403])("clears memory when the current account receives %i", async (status) => {
    const { cache } = await modules();
    cache.replaceManagerApplicationRowInCache(row("PROPLANE-A"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status })));
    expect(await cache.syncManagerApplicationsFromServer({ managerUserId: "manager-a", force: true })).toEqual([]);
    expect(cache.readManagerApplicationRows()).toEqual([]);
  });
  it.each([200, 401])("discards a previous account's late %i response", async (status) => {
    const { cache, session } = await modules();
    let finish!: (response: Response) => void;
    const oldResponse = new Promise<Response>((resolve) => { finish = resolve; });
    vi.stubGlobal("fetch", vi.fn().mockReturnValueOnce(oldResponse)
      .mockResolvedValueOnce(Response.json({ rows: [row("PROPLANE-B")] })));
    const old = cache.syncManagerApplicationsFromServer({ managerUserId: "manager-a", force: true });
    session.setPortalSessionViewer("manager-b");
    expect(cache.readManagerApplicationRows()).toEqual([]);
    await cache.syncManagerApplicationsFromServer({ managerUserId: "manager-b", force: true });
    finish(status === 200 ? Response.json({ rows: [row("PROPLANE-A")] }) : new Response(null, { status }));
    expect(await old).toEqual([]);
    expect(cache.readManagerApplicationRows().map((item) => item.id)).toEqual(["PROPLANE-B"]);
    expect(session.portalSessionEnded()).toBe(false);
  });
  it("clears the first render after logout", async () => {
    const { cache, session } = await modules();
    cache.replaceManagerApplicationRowInCache(row("PROPLANE-A"));
    session.setPortalSessionViewer(null);
    expect(cache.readManagerApplicationRows()).toEqual([]);
  });
  it("cancels prior-account autosaves and erases its setup credentials", async () => {
    vi.useFakeTimers();
    const { cache, session } = await modules();
    const fetcher = vi.fn().mockResolvedValue(Response.json({}));
    vi.stubGlobal("fetch", fetcher);
    cache.rememberApplicationSetupToken("PROPLANE-A", "synthetic-token");
    cache.upsertApplicationRowToServer(row("PROPLANE-A"));
    session.setPortalSessionViewer("manager-b");
    await vi.advanceTimersByTimeAsync(500);
    expect(fetcher).not.toHaveBeenCalled();
    expect(cache.getApplicationSetupToken("PROPLANE-A")).toBeNull();
  });
  it("ignores a prior-account save response carrying a token and identity row", async () => {
    const { cache, session } = await modules();
    let finish!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise<Response>((resolve) => { finish = resolve; })));
    const saving = cache.upsertApplicationRowToServerAwait(row("PROPLANE-A"));
    session.setPortalSessionViewer("manager-b");
    finish(Response.json({ setupToken: "synthetic-old-token", row: row("PROPLANE-A") }));
    expect((await saving).ok).toBe(false);
    expect(cache.readManagerApplicationRows()).toEqual([]);
    expect(cache.getApplicationSetupToken("PROPLANE-A")).toBeNull();
  });
  it("lets a new public guest draft work after the prior authenticated session ended", async () => {
    const { cache, session } = await modules();
    session.markPortalSessionEnded();
    session.setPortalSessionViewer(null);
    cache.replaceManagerApplicationRowInCache(row("PROPLANE-GUEST"));
    expect(cache.readManagerApplicationRows().map((item) => item.id)).toEqual(["PROPLANE-GUEST"]);
  });
});
