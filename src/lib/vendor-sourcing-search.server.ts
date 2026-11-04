import "server-only";

import { normalizeE164 } from "@/lib/phone-e164";

const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 15_000;
const MAX_RESULTS = 3;
const RESULT_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_RESULT_CACHE_ENTRIES = 100;
const SOURCING_CATEGORIES = new Map<string, string>([
  ["plumbing", "Plumbing"],
  ["electrical", "Electrical"],
  ["hvac", "HVAC"],
  ["appliance", "Appliance"],
  ["access", "Access"],
  ["access / locks", "Access / Locks"],
  ["general", "General"],
  ["cleaning", "Cleaning"],
  ["mold", "Mold"],
]);

const resultCache = new Map<string, { expiresAt: number; result: Extract<VendorSourcingWebSearchResult, { status: "available" }> }>();
const inFlightSearches = new Map<string, Promise<VendorSourcingWebSearchResult>>();

export type VendorSourcingPhoneEvidence = {
  raw: string;
  source: "snippet" | "structured";
};

export type VendorSourcingEmailEvidence = {
  email: string; source: "published_quote_invitation"; sourceUrl: string; invitationText: string; recordedAt: string; scope: "service_quote"; version: 1; followUpAllowed: false;
};

export type VendorSourcingWebCandidate = {
  name: string;
  url: string;
  description: string;
  resultRank: number;
  fetchedAt: string;
  phoneEvidence: VendorSourcingPhoneEvidence | null;
  normalizedPhone: string | null;
  emailEvidence?: VendorSourcingEmailEvidence | null;
};

export type VendorSourcingWebSearchResult =
  | { status: "available"; candidates: VendorSourcingWebCandidate[] }
  | {
      status: "unavailable";
      candidates: [];
      reason: "missing_api_key" | "provider_error" | "timeout" | "invalid_response" | "invalid_query";
    };

export type VendorSourcingWebSearchInput = {
  category: string;
  city?: string | null;
  zip?: string | null;
};

export type VendorSourcingWebSearchOptions = {
  /** Test seam. Production callers should omit this and use BRAVE_SEARCH_API_KEY. */
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
};

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanCity(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim().replace(/\s+/g, " ");
  if (!cleaned || cleaned.length > 80 || cleaned.split(" ").length > 6 || !/^\p{L}[\p{L}\p{M} .,'-]*$/u.test(cleaned)) return null;
  return cleaned;
}

function buildQuery(input: VendorSourcingWebSearchInput): string | null {
  const categoryKey = typeof input.category === "string" ? input.category.trim().replace(/\s+/g, " ").toLowerCase() : "";
  const category = SOURCING_CATEGORIES.get(categoryKey);
  const city = cleanCity(input.city);
  const zip = typeof input.zip === "string" && /^\d{5}(?:-\d{4})?$/.test(input.zip.trim()) ? input.zip.trim() : null;
  if ((input.city && !city) || (input.zip && !zip)) return null;
  if (!category || (!city && !zip)) return null;
  // These are the only fields accepted by this adapter: never pass an issue narrative,
  // address, resident name, unit, or other private service context to the provider.
  return [category, city, zip].filter(Boolean).join(" ");
}

function validResultUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.username || parsed.password) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function isDirectoryOrListicle(title: string, url: string): boolean {
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  const directoryHosts = [
    "yelp.com", "angi.com", "homeadvisor.com", "thumbtack.com", "bbb.org", "yellowpages.com",
    "mapquest.com", "porch.com", "networx.com", "superpages.com", "manta.com", "chamberofcommerce.com",
    "expertise.com", "houzz.com",
  ];
  if (directoryHosts.some((directoryHost) => host === directoryHost || host.endsWith(`.${directoryHost}`))) return true;

  const pathname = parsed.pathname.toLowerCase();
  if (/\/(?:directory|directories|search)(?:\/|$)/.test(pathname)) return true;
  const normalizedTitle = title.trim().toLowerCase();
  return /\b(?:top\s+\d+|\d+\s+best|best\s+(?:plumbers?|plumbing companies|electricians?|hvac companies|contractors|service providers)|directory of|complete list of|list of the best)\b/.test(normalizedTitle);
}

function validateResponse(value: unknown): Array<{ title: string; url: string; description: string; extraSnippets: string[]; schemas: unknown[] }> | null {
  if (!isRecord(value) || !isRecord(value.web) || !Array.isArray(value.web.results)) return null;
  const validated = [];
  for (const result of value.web.results) {
    if (!isRecord(result) || typeof result.title !== "string" || !result.title.trim() || typeof result.url !== "string") return null;
    if (!(typeof result.description === "string" || result.description === null)) return null;
    if (result.extra_snippets !== undefined && result.extra_snippets !== null &&
      (!Array.isArray(result.extra_snippets) || !result.extra_snippets.every((part) => typeof part === "string"))) return null;
    if (result.schemas !== undefined && result.schemas !== null && !Array.isArray(result.schemas)) return null;
    const url = validResultUrl(result.url);
    if (!url) return null;
    validated.push({
      title: result.title.trim(),
      url,
      description: typeof result.description === "string" ? result.description : "",
      extraSnippets: Array.isArray(result.extra_snippets) ? result.extra_snippets as string[] : [],
      schemas: Array.isArray(result.schemas) ? result.schemas : [],
    });
  }
  return validated;
}

function structuredPhoneValues(value: unknown, output: string[], depth = 0): void {
  if (depth > 8 || output.length >= 20) return;
  if (Array.isArray(value)) {
    for (const item of value) structuredPhoneValues(item, output, depth + 1);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (key.toLowerCase() === "telephone") {
      if (typeof child === "string") output.push(child);
      else if (Array.isArray(child)) output.push(...child.filter((part): part is string => typeof part === "string"));
    } else if (Array.isArray(child) || isRecord(child)) {
      structuredPhoneValues(child, output, depth + 1);
    }
  }
}

const PHONE_LIKE_RE = /(?:\+?\d|\(\d)[\d().\s-]{7,}\d/g;

function phoneFromEvidence(
  snippets: readonly string[],
  schemas: readonly unknown[],
): { evidence: VendorSourcingPhoneEvidence; normalizedPhone: string } | null {
  const rawStructured: string[] = [];
  for (const schema of schemas) structuredPhoneValues(schema, rawStructured);

  const candidates: VendorSourcingPhoneEvidence[] = rawStructured.map((raw) => ({ raw: raw.trim(), source: "structured" }));
  for (const snippet of snippets) {
    for (const match of snippet.matchAll(PHONE_LIKE_RE)) {
      candidates.push({ raw: match[0].trim(), source: "snippet" });
    }
  }

  const normalized = new Map<string, VendorSourcingPhoneEvidence>();
  for (const candidate of candidates) {
    const phone = normalizeE164(candidate.raw);
    // The search input is a US city/ZIP. Keep only complete NANP numbers so
    // ZIPs, short extensions, and vaguely phone-like numeric snippets cannot
    // become an SMS destination.
    if (phone?.startsWith("+1") && phone.length === 12 && !normalized.has(phone)) normalized.set(phone, candidate);
  }
  if (normalized.size !== 1) return null;
  const [normalizedPhone, evidence] = [...normalized.entries()][0]!;
  return { evidence, normalizedPhone };
}

/** A public address alone is never permission. Accept only a literal invitation
 * at the business's own domain, in the same bounded search-result sentence. */
export function quoteEmailEvidence(url: string, snippets: string[], recordedAt: string): VendorSourcingEmailEvidence | null {
  let host: string;
  try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return null; }
  if (isDirectoryOrListicle("", url)) return null;
  const text = snippets.join(" ").replace(/<[^>]*>/g, " ");
  const emails = [...new Set((text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? []).map((e) => e.toLowerCase()))];
  if (emails.length !== 1) return null;
  const email = emails[0]!;
  const domain = email.split("@")[1];
  if (domain !== host && !host.endsWith(`.${domain}`)) return null;
  // Keep the email and explicit purchasing invitation together. Generic "contact
  // us" and unrelated quotations on another snippet do not establish permission.
  const sentence = text.split(/[!?]|\.\s+/).find((part) => part.toLowerCase().includes(email) && /\b(?:email|send|submit)\b.{0,90}\b(?:quote|estimate|service request|service inquir)/i.test(part));
  if (!sentence || sentence.length > 600) return null;
  return { email, source: "published_quote_invitation", sourceUrl: url, invitationText: sentence.trim(), recordedAt, scope: "service_quote", version: 1, followUpAllowed: false };
}

function unavailable(reason: Extract<VendorSourcingWebSearchResult, { status: "unavailable" }>['reason']): VendorSourcingWebSearchResult {
  return { status: "unavailable", candidates: [], reason };
}

/** Search Brave using only a service category and authorized property city/ZIP. */
export async function searchVendorSourcingWeb(
  input: VendorSourcingWebSearchInput,
  options: VendorSourcingWebSearchOptions = {},
): Promise<VendorSourcingWebSearchResult> {
  const query = buildQuery(input);
  if (!query) return unavailable("invalid_query");

  const apiKey = options.apiKey ?? process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey?.trim()) return unavailable("missing_api_key");

  // Production requests share a bounded five-minute result cache and in-flight
  // coalescing. Explicit test seams bypass both so provider contracts stay deterministic.
  const useProcessCache = options.apiKey === undefined && options.fetchImpl === undefined &&
    options.now === undefined && options.timeoutMs === undefined;
  if (useProcessCache) {
    const cached = resultCache.get(query);
    if (cached && cached.expiresAt > Date.now()) return cached.result;
    if (cached) resultCache.delete(query);
    const inFlight = inFlightSearches.get(query);
    if (inFlight) return inFlight;
  }

  const requestedTimeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutMs = Number.isFinite(requestedTimeout)
    ? Math.min(MAX_TIMEOUT_MS, Math.max(100, Math.floor(requestedTimeout)))
    : DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const performSearch = async (): Promise<VendorSourcingWebSearchResult> => {
    try {
      const url = new URL(BRAVE_SEARCH_ENDPOINT);
      url.searchParams.set("q", query);
      url.searchParams.set("count", "10");
      url.searchParams.set("result_filter", "web");
      url.searchParams.set("extra_snippets", "true");
      const response = await (options.fetchImpl ?? fetch)(url, {
        method: "GET",
        headers: { "X-Subscription-Token": apiKey.trim(), Accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) return unavailable("provider_error");

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        return unavailable("invalid_response");
      }
      const results = validateResponse(payload);
      if (!results) return unavailable("invalid_response");

      const fetchedAt = (options.now?.() ?? new Date()).toISOString();
      const candidates: VendorSourcingWebCandidate[] = results.flatMap((result, index) => {
        if (isDirectoryOrListicle(result.title, result.url)) return [];
        const phone = phoneFromEvidence([result.description, ...result.extraSnippets], result.schemas);
        return [{
          name: result.title,
          url: result.url,
          description: result.description,
          resultRank: index + 1,
          fetchedAt,
          phoneEvidence: phone?.evidence ?? null,
          normalizedPhone: phone?.normalizedPhone ?? null,
          emailEvidence: quoteEmailEvidence(result.url, [result.description, ...result.extraSnippets], fetchedAt),
        }];
      }).slice(0, MAX_RESULTS);
      return { status: "available", candidates };
    } catch (error) {
      return unavailable(error instanceof Error && error.name === "AbortError" ? "timeout" : "provider_error");
    } finally {
      clearTimeout(timer);
    }
  };

  const pending = performSearch();
  if (!useProcessCache) return pending;
  inFlightSearches.set(query, pending);
  try {
    const result = await pending;
    if (result.status === "available") {
      resultCache.set(query, { result, expiresAt: Date.now() + RESULT_CACHE_TTL_MS });
      while (resultCache.size > MAX_RESULT_CACHE_ENTRIES) {
        const oldestKey = resultCache.keys().next().value;
        if (oldestKey === undefined) break;
        resultCache.delete(oldestKey);
      }
    }
    return result;
  } finally {
    if (inFlightSearches.get(query) === pending) inFlightSearches.delete(query);
  }
}
