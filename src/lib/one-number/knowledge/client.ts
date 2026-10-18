/**
 * Browser-side calls for the knowledge base and reply modes. Plain fetches (no shared GET cache):
 * a Save / Dismiss must show the next state, never a cached one.
 */
import { fetchWithTimeout, PORTAL_READ_TIMEOUT_MS } from "@/lib/auth/fetch-with-timeout";
import type { TopicReplyMode } from "../contracts";
import type { ReplyTopic } from "./topics";
import type { KnowledgeAudience, KnowledgeEntry } from "./types";

const BASE = "/api/portal/knowledge";
const JSON_HEADERS = { "Content-Type": "application/json" };

async function readJson<T>(res: Response): Promise<T | null> {
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function fetchKnowledge(args: { propertyId?: string; team?: boolean }): Promise<{ entries: KnowledgeEntry[]; canManageTeam: boolean } | null> {
  const query = args.propertyId ? `?propertyId=${encodeURIComponent(args.propertyId)}` : args.team ? "?scope=team" : "";
  try {
    const res = await fetchWithTimeout(`${BASE}${query}`, { credentials: "include" }, PORTAL_READ_TIMEOUT_MS);
    if (!res.ok) return null;
    return await readJson(res);
  } catch {
    return null;
  }
}

export type EntryDraft = {
  question: string;
  answer: string;
  /** null = team-wide. */
  propertyId: string | null;
  audience: KnowledgeAudience;
  topic?: ReplyTopic;
};

export async function createKnowledgeEntry(draft: EntryDraft): Promise<KnowledgeEntry | null> {
  try {
    const res = await fetchWithTimeout(BASE, { method: "POST", credentials: "include", headers: JSON_HEADERS, body: JSON.stringify(draft) }, PORTAL_READ_TIMEOUT_MS);
    if (!res.ok) return null;
    return (await readJson<{ entry: KnowledgeEntry }>(res))?.entry ?? null;
  } catch {
    return null;
  }
}

export async function patchKnowledgeEntry(
  id: string,
  body: { action: "approve" | "dismiss" | "edit"; scope?: "house" | "team"; question?: string; answer?: string; audience?: KnowledgeAudience; topic?: ReplyTopic; propertyId?: string },
): Promise<{ ok: boolean; entry: KnowledgeEntry | null }> {
  try {
    const res = await fetchWithTimeout(`${BASE}/${encodeURIComponent(id)}`, { method: "PATCH", credentials: "include", headers: JSON_HEADERS, body: JSON.stringify(body) }, PORTAL_READ_TIMEOUT_MS);
    if (!res.ok) return { ok: false, entry: null };
    const data = await readJson<{ entry?: KnowledgeEntry }>(res);
    return { ok: true, entry: data?.entry ?? null };
  } catch {
    return { ok: false, entry: null };
  }
}

export async function deleteKnowledgeEntry(id: string): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(`${BASE}/${encodeURIComponent(id)}`, { method: "DELETE", credentials: "include" }, PORTAL_READ_TIMEOUT_MS);
    return res.ok;
  } catch {
    return false;
  }
}

export type ThreadDraftView = { id: string; mode: "draft" | "auto_review"; topic: string; body: string; inboundText: string; createdAt: string };
export type ThreadKnowledgeView = {
  suggestions: Array<KnowledgeEntry & { houseLabel: string | null }>;
  draft: ThreadDraftView | null;
  reviewing: ThreadDraftView | null;
  canManageTeam: boolean;
};

export async function fetchThreadKnowledge(phone: string): Promise<ThreadKnowledgeView | null> {
  try {
    const res = await fetchWithTimeout(`${BASE}/thread?phone=${encodeURIComponent(phone)}`, { credentials: "include" }, PORTAL_READ_TIMEOUT_MS);
    if (!res.ok) return null;
    const data = await readJson<ThreadKnowledgeView>(res);
    // Anything that is not this route's shape (an unrelated response) reads as "nothing to show".
    return data && Array.isArray(data.suggestions) ? data : null;
  } catch {
    return null;
  }
}

export async function actOnDraft(id: string, action: "reject" | "ok" | "corrected"): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(`${BASE}/drafts/${encodeURIComponent(id)}`, { method: "POST", credentials: "include", headers: JSON_HEADERS, body: JSON.stringify({ action }) }, PORTAL_READ_TIMEOUT_MS);
    return res.ok;
  } catch {
    return false;
  }
}

export type ReplyModeRow = { topic: ReplyTopic; mode: TopicReplyMode; ceiling: TopicReplyMode | null; picked: boolean };

export async function fetchReplyModes(): Promise<{ topics: ReplyModeRow[]; canEdit: boolean } | null> {
  try {
    const res = await fetchWithTimeout(`${BASE}/reply-modes`, { credentials: "include" }, PORTAL_READ_TIMEOUT_MS);
    if (!res.ok) return null;
    return await readJson(res);
  } catch {
    return null;
  }
}

export async function saveReplyMode(topic: ReplyTopic, mode: TopicReplyMode): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(`${BASE}/reply-modes`, { method: "PUT", credentials: "include", headers: JSON_HEADERS, body: JSON.stringify({ topic, mode }) }, PORTAL_READ_TIMEOUT_MS);
    return res.ok;
  } catch {
    return false;
  }
}
