import "server-only";

import { getNearbyTransit } from "@/lib/nearby-transit.server";
import { recordPropertyResearchDisposition, recordPropertyResearchGeneration } from "@/lib/observability/langfuse";
import { reservePropertyResearchAttempt } from "@/lib/property-research-budget.server";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { toString } from "mdast-util-to-string";
import { gfm } from "micromark-extension-gfm";
import { untrustedText } from "@/lib/tools/domains/resident/load-resident-rows";

export type PropertyResearchTopic = "schools" | "schools_dual_language" | "parks" | "groceries" | "transit_stops" | "transit_service" | "nearby_amenities";
type ResearchInput = { scopeKey: string; propertyId: string; location: Record<string, unknown>; topic: PropertyResearchTopic };
type Source = { title: string; url: string };

const POSITIVE_TTL_MS = 6 * 60 * 60 * 1000;
const FAILURE_TTL_MS = 45 * 1000;
const TRANSIT_SERVICE_TTL_MS = 5 * 60 * 1000;
const BRAVE_REQUEST_USD = 0.005;
const MAX_CACHE_ENTRIES = 200;
const cache = new Map<string, { expiresAt: number; result: ResearchResult }>();
const inflight = new Map<string, Promise<ResearchResult>>();

export type ResearchResult = {
  kind: "property_location_research";
  verified: boolean;
  topic: PropertyResearchTopic;
  propertyId: string;
  fetchedAt: string;
  summary: { untrustedContent: string } | null;
  sources: Source[];
  limitation: string | null;
  provider: "brave_llm_context" | "openstreetmap";
  usage: { inputTokens: number; cachedInputTokens: number; cacheWriteTokens: number; outputTokens: number; searchCalls: number; estimatedUsd: number | null };
  cacheHit: boolean;
  coalesced: boolean;
  currentRequestEstimatedUsd: number | null;
  billingOutcome: "confirmed_estimate" | "unknown" | "no_attempt";
  mappedTransit?: Awaited<ReturnType<typeof getNearbyTransit>>;
};

function publicField(location: Record<string, unknown>, key: string): string {
  const value = location[key];
  return typeof value === "string" ? value.trim().slice(0, 120).replace(/[\r\n\t]+/g, " ") : "";
}

function normalizedLocation(location: Record<string, unknown>): string | null {
  const street = publicField(location, "address");
  const city = publicField(location, "city");
  const state = publicField(location, "state");
  const zip = publicField(location, "zip");
  if (!street || !(zip || (city && state))) return null;
  return [street, city, state, zip].filter(Boolean).join(", ");
}

function validSource(value: unknown): Source | null {
  if (!value || typeof value !== "object") return null;
  const annotation = value as { type?: unknown; title?: unknown; url?: unknown };
  if (annotation.type !== "url_citation" || typeof annotation.url !== "string") return null;
  try {
    const url = new URL(annotation.url);
    if (url.protocol !== "https:" || url.username || url.password || url.hostname === "localhost" || url.hostname.endsWith(".local")) return null;
    for (const name of [...url.searchParams.keys()]) if (name.toLowerCase().startsWith("utm_")) url.searchParams.delete(name);
    return { title: typeof annotation.title === "string" ? plainExternalText(annotation.title).slice(0, 160) || url.hostname : url.hostname, url: url.toString() };
  } catch { return null; }
}

/** Keep source prose as text; only citation annotations may contribute links. */
function plainExternalText(value: string): string {
  const markdownText = toString(fromMarkdown(value, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }));
  return markdownText
    .replace(/<[^>]*>/g, " ")
    .replace(/(?:https?:)?\/\/[^\s<>"']+/gi, " ")
    .replace(/\b(?:javascript|data|vbscript|file):[^\s<>"']+/gi, " ")
    .replace(/(?<![\w:/])\/[A-Za-z][^\s<>"']*/g, " ")
    .replace(/[\\[\]<>]/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function empty(input: ResearchInput, limitation: string, mappedTransit?: ResearchResult["mappedTransit"]): ResearchResult {
  return { kind: "property_location_research", verified: false, topic: input.topic, propertyId: input.propertyId, fetchedAt: new Date().toISOString(), summary: null, sources: [], limitation,
    provider: "brave_llm_context", usage: { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, searchCalls: 0, estimatedUsd: 0 },
    cacheHit: false, coalesced: false, currentRequestEstimatedUsd: 0, billingOutcome: "no_attempt",
    ...(mappedTransit ? { mappedTransit } : {}) };
}

const queryByTopic: Record<PropertyResearchTopic, string> = {
  schools: "nearby public schools grades current official school district",
  schools_dual_language: "nearby public schools dual language immersion current school year official district program address",
  parks: "nearby public parks official addresses",
  groceries: "nearby grocery stores published addresses operator",
  transit_stops: "mapped transit stops",
  transit_service: "official transit operator service status accessibility elevators today",
  nearby_amenities: "nearby public amenities official published addresses",
};

function candidates(body: unknown): Array<{ title: string; url: string; snippets: string[]; age: string }> {
  if (!body || typeof body !== "object") return [];
  const payload = body as { grounding?: { generic?: unknown; map?: unknown }; sources?: Record<string, { age?: unknown }> };
  const rows = [...(Array.isArray(payload.grounding?.generic) ? payload.grounding.generic : []),
    ...(Array.isArray(payload.grounding?.map) ? payload.grounding.map : [])];
  return rows.filter((row): row is { title?: unknown; url?: unknown; snippets?: unknown } => !!row && typeof row === "object")
    .map(row => {
      const citation = validSource({ type: "url_citation", url: row.url, title: row.title });
      if (!citation) return null;
      const snippets = Array.isArray(row.snippets) ? row.snippets.filter((part): part is string => typeof part === "string") : [];
      const originalUrl = typeof row.url === "string" ? row.url : "";
      const sourceAge = (payload.sources?.[originalUrl] ?? payload.sources?.[citation.url])?.age;
      const age = Array.isArray(sourceAge) && typeof sourceAge[1] === "string"
        ? plainExternalText(sourceAge[1]).slice(0, 80)
        : "";
      return { ...citation, snippets, age };
    }).filter((row): row is { title: string; url: string; snippets: string[]; age: string } => row !== null);
}

async function search(input: ResearchInput, address: string, key: string): Promise<ResearchResult> {
  const startedAt = Date.now();
  const finish = (result: ResearchResult, outcome: "verified" | "unverified" | "unavailable") => {
    recordPropertyResearchGeneration({ topic: input.topic, propertyId: input.propertyId,
      outcome, latencyMs: Date.now() - startedAt, attempt: true,
      billingOutcome: result.billingOutcome, estimatedCostUsd: result.currentRequestEstimatedUsd });
    return result;
  };
  const failure = (limitation: string, billingOutcome: "unknown" | "confirmed_estimate" = "unknown") => {
    const estimate = billingOutcome === "confirmed_estimate" ? BRAVE_REQUEST_USD : null;
    return finish({ ...empty(input, limitation), billingOutcome, currentRequestEstimatedUsd: estimate,
      usage: { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, searchCalls: 1, estimatedUsd: estimate } }, "unavailable");
  };
  const url = new URL("https://api.search.brave.com/res/v1/llm/context");
  url.searchParams.set("q", `${address} ${queryByTopic[input.topic]}`);
  url.searchParams.set("maximum_number_of_tokens", "2000");
  url.searchParams.set("maximum_number_of_urls", "6");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 18_000);
  let response: Response;
  let body: unknown;
  let accepted = false;
  try {
    response = await fetch(url, { method: "GET", signal: controller.signal,
      headers: { Accept: "application/json", "X-Subscription-Token": key } });
    if (!response.ok) return failure(response.status === 429 ? "Search is temporarily rate limited. Try again shortly." : "Search provider unavailable.");
    accepted = true;
    const length = Number(response.headers.get("content-length"));
    if (length > 128_000) return failure("Search provider returned an oversized response.", "confirmed_estimate");
    const reader = response.body?.getReader();
    if (!reader) return failure("Search provider returned an invalid response.", "confirmed_estimate");
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 128_000) { await reader.cancel(); return failure("Search provider returned an oversized response.", "confirmed_estimate"); }
      chunks.push(value);
    }
    const all = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength; }
    body = JSON.parse(new TextDecoder().decode(all));
  } catch {
    return failure("Search provider unavailable or timed out.", accepted ? "confirmed_estimate" : "unknown");
  } finally { clearTimeout(timeout); }
  const rows = candidates(body);
  const sources: Source[] = [];
  const snippets: string[] = [];
  for (const row of rows) {
    if (sources.length >= 6) break;
    if (sources.some(source => source.url === row.url)) continue;
    const text = row.snippets.slice(0, 2).map(part => plainExternalText(part).slice(0, 500)).filter(Boolean).join(" ");
    if (!text) continue;
    sources.push({ title: row.title, url: row.url });
    snippets.push(`${row.title}${row.age ? ` (source date ${row.age})` : ""}: ${text}`);
  }
  const usage = { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, searchCalls: 1, estimatedUsd: BRAVE_REQUEST_USD };
  if (!sources.length) return failure("No source-backed result was found.", "confirmed_estimate");
  return finish({ kind: "property_location_research", verified: true, topic: input.topic,
    propertyId: input.propertyId, fetchedAt: new Date().toISOString(),
    summary: untrustedText("public web search results", snippets.join("\n").slice(0, 2200)), sources,
    limitation: "Retrieved excerpts are source-attributed, not independently verified. Check enrollment, routes, hours and current service with the operator.",
    provider: "brave_llm_context", usage, cacheHit: false, coalesced: false,
    currentRequestEstimatedUsd: BRAVE_REQUEST_USD, billingOutcome: "confirmed_estimate" }, "verified");
}

export async function researchPropertyLocation(input: ResearchInput): Promise<ResearchResult> {
  if (input.topic === "transit_stops") {
    const mappedTransit = await getNearbyTransit(input.location, "public_transit");
    return { ...empty(input, mappedTransit.verified ? "Mapped stop locations are approximate straight-line distances, not walking times or service status." : "Nearby mapped stops could not be verified.", mappedTransit),
      verified: mappedTransit.verified, provider: "openstreetmap", sources: mappedTransit.verified ? [{ title: "OpenStreetMap", url: mappedTransit.sourceUrl }] : [] };
  }
  const address = normalizedLocation(input.location);
  if (!address) return empty(input, "A complete property address is needed for location research.");
  const fingerprint = address.toLowerCase().replace(/\s+/g, " ");
  const cacheKey = `${input.scopeKey}:${input.propertyId}:${fingerprint}:${input.topic}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    recordPropertyResearchDisposition({ topic: input.topic, propertyId: input.propertyId, status: "cache_hit" });
    return { ...cached.result, usage: { ...cached.result.usage, searchCalls: 0, estimatedUsd: 0 }, cacheHit: true, coalesced: false, currentRequestEstimatedUsd: 0, billingOutcome: "no_attempt" };
  }
  const pending = inflight.get(cacheKey);
  if (pending) {
    recordPropertyResearchDisposition({ topic: input.topic, propertyId: input.propertyId, status: "coalesced" });
    return pending.then(result => ({ ...result, usage: { ...result.usage, searchCalls: 0, estimatedUsd: 0 }, cacheHit: false, coalesced: true, currentRequestEstimatedUsd: 0, billingOutcome: "no_attempt" }));
  }
  const key = process.env.BRAVE_SEARCH_API_KEY?.trim();
  if (!key) return empty(input, "Search provider unavailable: no API key is configured.");
  const task = Promise.resolve().then(async () => {
      if (!reservePropertyResearchAttempt()) {
        recordPropertyResearchDisposition({ topic: input.topic, propertyId: input.propertyId, status: "budget_blocked" });
        return empty(input, "Search budget reached for this assistant turn. Use existing facts or try in a new turn.");
      }
      const result = await search(input, address, key);
      if (input.topic === "transit_service") result.mappedTransit = await getNearbyTransit(input.location, "public_transit");
      const ttl = result.verified ? (input.topic === "transit_service" ? TRANSIT_SERVICE_TTL_MS : POSITIVE_TTL_MS) : result.usage.searchCalls ? FAILURE_TTL_MS : 0;
      if (ttl) {
        cache.delete(cacheKey);
        cache.set(cacheKey, { result, expiresAt: Date.now() + ttl });
        if (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
      }
      return result;
  }).finally(() => inflight.delete(cacheKey));
  inflight.set(cacheKey, task);
  return task;
}

export function __resetPropertyResearchCache() { cache.clear(); inflight.clear(); }
