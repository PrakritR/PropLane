import { afterEach, describe, expect, it, vi } from "vitest";
import {
  searchVendorSourcingWeb,
  type VendorSourcingWebSearchInput,
} from "@/lib/vendor-sourcing-search.server";

const input: VendorSourcingWebSearchInput = { category: "Plumbing", city: "Seattle", zip: "98105" };

function providerResult(index: number, overrides: Record<string, unknown> = {}) {
  return {
    title: `Plumber ${index}`,
    url: `https://plumber${index}.example/`,
    description: `Call (206) 555-010${index} for plumbing in Seattle.`,
    ...overrides,
  };
}

function braveResponse(results: unknown[]) {
  return new Response(JSON.stringify({ web: { results } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("searchVendorSourcingWeb", () => {
  it("calls only the fixed Brave host with category and property location, then keeps the first three ranked results", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      requestUrl = String(url);
      requestInit = init;
      return braveResponse([providerResult(1), providerResult(2), providerResult(3), providerResult(4)]);
    }) as typeof fetch;

    const result = await searchVendorSourcingWeb(input, {
      apiKey: "brave-test-key",
      fetchImpl,
      now: () => new Date("2026-10-16T12:00:00.000Z"),
    });

    expect(result.status).toBe("available");
    if (result.status !== "available") return;
    const parsedUrl = new URL(requestUrl);
    expect(parsedUrl.origin).toBe("https://api.search.brave.com");
    expect(parsedUrl.pathname).toBe("/res/v1/web/search");
    expect(parsedUrl.searchParams.get("q")).toBe("Plumbing Seattle 98105");
    expect(parsedUrl.searchParams.get("result_filter")).toBe("web");
    expect(parsedUrl.searchParams.get("count")).toBe("10");
    expect(requestInit?.headers).toEqual({ "X-Subscription-Token": "brave-test-key", Accept: "application/json" });
    expect(result.candidates.map((candidate) => candidate.name)).toEqual(["Plumber 1", "Plumber 2", "Plumber 3"]);
    expect(result.candidates.map((candidate) => candidate.resultRank)).toEqual([1, 2, 3]);
    expect(result.candidates[0]).toMatchObject({
      url: "https://plumber1.example/",
      fetchedAt: "2026-10-16T12:00:00.000Z",
      phoneEvidence: { raw: "(206) 555-0101", source: "snippet" },
      normalizedPhone: "+12065550101",
    });
  });

  it("extracts phone provenance only from an actual structured telephone field", async () => {
    const fetchImpl = vi.fn(async () => braveResponse([
      providerResult(1, {
        description: "Residential repair and maintenance services.",
        schemas: [{ "@type": "LocalBusiness", telephone: "+1-206-555-0199" }],
      }),
    ])) as unknown as typeof fetch;

    const result = await searchVendorSourcingWeb(input, { apiKey: "key", fetchImpl });
    expect(result.status).toBe("available");
    if (result.status !== "available") return;
    expect(result.candidates[0]).toMatchObject({
      phoneEvidence: { raw: "+1-206-555-0199", source: "structured" },
      normalizedPhone: "+12065550199",
    });
  });

  it("withholds a phone when snippets contain multiple distinct numbers", async () => {
    const fetchImpl = vi.fn(async () => braveResponse([
      providerResult(1, { description: "Call 206-555-0101 or 206-555-0102." }),
    ])) as unknown as typeof fetch;

    const result = await searchVendorSourcingWeb(input, { apiKey: "key", fetchImpl });
    expect(result.status).toBe("available");
    if (result.status !== "available") return;
    expect(result.candidates[0]?.phoneEvidence).toBeNull();
    expect(result.candidates[0]?.normalizedPhone).toBeNull();
  });

  it("filters obvious directory and listicle pages while preserving provider rank", async () => {
    const fetchImpl = vi.fn(async () => braveResponse([
      providerResult(1, { title: "Top 10 Plumbers in Seattle", url: "https://localguide.example/top-plumbers", description: "Call 206-555-0101." }),
      providerResult(2, { title: "Plumbing companies near Seattle", url: "https://www.yelp.com/search?find=plumber", description: "Call 206-555-0102." }),
      providerResult(3, { title: "North Seattle Plumbing", url: "https://northseattleplumbing.example/", description: "Call 206-555-0103." }),
    ])) as unknown as typeof fetch;

    const result = await searchVendorSourcingWeb(input, { apiKey: "key", fetchImpl });
    expect(result.status).toBe("available");
    if (result.status !== "available") return;
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      name: "North Seattle Plumbing",
      resultRank: 3,
      phoneEvidence: { raw: "206-555-0103", source: "snippet" },
      normalizedPhone: "+12065550103",
    });
  });

  it("does not search when the provider key or an allowed location is missing", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(searchVendorSourcingWeb(input, { apiKey: "", fetchImpl })).resolves.toMatchObject({
      status: "unavailable", reason: "missing_api_key", candidates: [],
    });
    await expect(searchVendorSourcingWeb({ category: "Plumbing" }, { apiKey: "key", fetchImpl })).resolves.toMatchObject({
      status: "unavailable", reason: "invalid_query", candidates: [],
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects freeform categories and address-like city input", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(searchVendorSourcingWeb({ category: "A toilet is leaking in unit 4", zip: "98105" }, { apiKey: "key", fetchImpl }))
      .resolves.toMatchObject({ status: "unavailable", reason: "invalid_query", candidates: [] });
    await expect(searchVendorSourcingWeb({ category: "Plumbing", city: "123 Main Street" }, { apiKey: "key", fetchImpl }))
      .resolves.toMatchObject({ status: "unavailable", reason: "invalid_query", candidates: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("coalesces and caches normal environment-backed requests for repeat searches", async () => {
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "cache-test-key");
    const fetchImpl = vi.fn(async () => braveResponse([providerResult(1)]));
    vi.stubGlobal("fetch", fetchImpl);
    const cacheInput = { category: "HVAC", city: "Cacheville", zip: "99995" };

    const [first, concurrent] = await Promise.all([
      searchVendorSourcingWeb(cacheInput),
      searchVendorSourcingWeb(cacheInput),
    ]);
    const repeated = await searchVendorSourcingWeb(cacheInput);

    expect(first).toEqual(concurrent);
    expect(repeated).toEqual(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("fails closed on malformed response and provider errors", async () => {
    const malformedFetch = vi.fn(async () => braveResponse([{ title: "Missing URL", description: "Plumber" }])) as unknown as typeof fetch;
    await expect(searchVendorSourcingWeb(input, { apiKey: "key", fetchImpl: malformedFetch })).resolves.toMatchObject({
      status: "unavailable", reason: "invalid_response", candidates: [],
    });

    const providerFetch = vi.fn(async () => new Response("quota exhausted", { status: 429 })) as unknown as typeof fetch;
    await expect(searchVendorSourcingWeb(input, { apiKey: "key", fetchImpl: providerFetch })).resolves.toMatchObject({
      status: "unavailable", reason: "provider_error", candidates: [],
    });
  });

  it("aborts a stalled provider request after the bounded timeout", async () => {
    const fetchImpl = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    })) as typeof fetch;

    await expect(searchVendorSourcingWeb(input, { apiKey: "key", fetchImpl, timeoutMs: 100 })).resolves.toMatchObject({
      status: "unavailable", reason: "timeout", candidates: [],
    });
  });
});
