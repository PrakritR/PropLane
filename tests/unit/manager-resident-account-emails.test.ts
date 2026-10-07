// @vitest-environment jsdom
//
// Residents page: the household-charges / applications / property ticks of ONE page load used to each
// POST the same email list to /api/manager/resident-account-emails (5 posts per load). One read per
// distinct list is shared and reused; a failed read is retried by the next tick.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("loadResidentAccountEmails", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function stubFetch(impl: () => Promise<Response>) {
    const fetchMock = vi.fn(impl);
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("sends one request for concurrent ticks and for later ticks inside the TTL", async () => {
    const fetchMock = stubFetch(async () => Response.json({ emails: ["A@x.com"] }));
    const { loadResidentAccountEmails } = await import("@/lib/manager-resident-account-emails");
    const list = ["a@x.com", "b@x.com"];
    const [one, two, three] = await Promise.all([
      loadResidentAccountEmails(list),
      loadResidentAccountEmails([...list].reverse()),
      loadResidentAccountEmails(list),
    ]);
    expect(one).toEqual(["a@x.com"]);
    expect(two).toEqual(one);
    expect(three).toEqual(one);
    await loadResidentAccountEmails(list);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("asks again for a different list, after the TTL, and when forced", async () => {
    const fetchMock = stubFetch(async () => Response.json({ emails: [] }));
    const { loadResidentAccountEmails, RESIDENT_ACCOUNT_EMAILS_TTL_MS } = await import("@/lib/manager-resident-account-emails");
    await loadResidentAccountEmails(["a@x.com"]);
    await loadResidentAccountEmails(["a@x.com", "c@x.com"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(RESIDENT_ACCOUNT_EMAILS_TTL_MS + 1);
    await loadResidentAccountEmails(["a@x.com"]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await loadResidentAccountEmails(["a@x.com"], { force: true });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("never keeps a failed read: null now, a real request on the next tick", async () => {
    let ok = false;
    const fetchMock = stubFetch(async () => (ok ? Response.json({ emails: ["a@x.com"] }) : new Response("{}", { status: 500 })));
    const { loadResidentAccountEmails } = await import("@/lib/manager-resident-account-emails");
    await expect(loadResidentAccountEmails(["a@x.com"])).resolves.toBeNull();
    ok = true;
    await expect(loadResidentAccountEmails(["a@x.com"])).resolves.toEqual(["a@x.com"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("drops every answer when the viewer changes", async () => {
    const fetchMock = stubFetch(async () => Response.json({ emails: [] }));
    const { loadResidentAccountEmails } = await import("@/lib/manager-resident-account-emails");
    const session = await import("@/lib/auth/portal-session-gate");
    session.setPortalSessionViewer("manager-a");
    await loadResidentAccountEmails(["a@x.com"]);
    session.setPortalSessionViewer("manager-b");
    await loadResidentAccountEmails(["a@x.com"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("Residents page uses the shared loader", () => {
  it("does not POST /api/manager/resident-account-emails directly", () => {
    const src = readFileSync(join(process.cwd(), "src/components/portal/pro-residents.tsx"), "utf8");
    expect(src).not.toContain('fetch("/api/manager/resident-account-emails"');
    expect(src).toContain("loadResidentAccountEmails(");
  });
});

describe("document library vendor roster", () => {
  it("does not force a server read from the vendors-changed event (it looped on a non-stable response)", () => {
    const src = readFileSync(join(process.cwd(), "src/components/portal/pro-document-library.tsx"), "utf8");
    const handler = src.split("const onVendors = ")[1]?.split("\n")[0] ?? "";
    expect(handler).not.toContain("force");
    expect(handler).not.toContain("syncManagerVendorsFromServer");
  });
});
