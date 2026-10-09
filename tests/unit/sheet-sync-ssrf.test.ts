import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));

import { fetchPublishedCsv } from "@/lib/sheet-sync/fetch-sheet";
import { isPrivateAddress } from "@/lib/sheet-sync/public-host.server";

const PUBLIC = [{ address: "93.184.216.34", family: 4 }];

function csvResponse(body = "a,b\n1,2\n") {
  return new Response(body, { status: 200, headers: { "content-type": "text/csv" } });
}

describe("isPrivateAddress", () => {
  it.each([
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254",
    "100.64.0.1", "100.127.255.255", "0.0.0.0", "224.0.0.1", "255.255.255.255",
    "::", "::1", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "::ffff:a9fe:a9fe", "64:ff9b::7f00:1", "not-an-ip",
  ])("blocks %s", (ip) => expect(isPrivateAddress(ip)).toBe(true));

  it.each(["93.184.216.34", "8.8.8.8", "172.32.0.1", "100.63.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"])(
    "allows %s", (ip) => expect(isPrivateAddress(ip)).toBe(false),
  );
});

describe("fetchPublishedCsv SSRF guard", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("refuses a public name that resolves to a private address, without fetching", async () => {
    mocks.lookup.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
    const result = await fetchPublishedCsv("https://evil.example.com/data.csv");
    expect(result).toEqual({ rows: null, error: "Could not read the CSV." });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses when any one resolved address is private", async () => {
    mocks.lookup.mockResolvedValue([...PUBLIC, { address: "::1", family: 6 }]);
    const result = await fetchPublishedCsv("https://mixed.example.com/data.csv");
    expect(result.rows).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("re-checks each redirect hop's resolution", async () => {
    mocks.lookup.mockImplementation(async (host: string) =>
      host === "hop.example.com" ? [{ address: "10.0.0.5", family: 4 }] : PUBLIC,
    );
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://hop.example.com/x.csv" } }));
    const result = await fetchPublishedCsv("https://ok.example.com/data.csv");
    expect(result).toEqual({ rows: null, error: "Could not read the CSV." });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ redirect: "manual" });
  });

  it("follows a redirect to another public host", async () => {
    mocks.lookup.mockResolvedValue(PUBLIC);
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 301, headers: { location: "https://cdn.example.com/data.csv" } }))
      .mockResolvedValueOnce(csvResponse());
    const result = await fetchPublishedCsv("https://ok.example.com/data.csv");
    expect(result.error).toBeNull();
    expect(result.rows).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("stops after the redirect limit", async () => {
    mocks.lookup.mockResolvedValue(PUBLIC);
    fetchMock.mockImplementation(async () => new Response(null, { status: 302, headers: { location: "https://ok.example.com/loop.csv" } }));
    const result = await fetchPublishedCsv("https://ok.example.com/data.csv");
    expect(result.rows).toBeNull();
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it("returns a generic error and hides the detail when the fetch or lookup throws", async () => {
    mocks.lookup.mockRejectedValue(new Error("getaddrinfo ENOTFOUND internal-detail"));
    const result = await fetchPublishedCsv("https://nope.example.com/data.csv");
    expect(result).toEqual({ rows: null, error: "Could not read the CSV." });
  });
});
