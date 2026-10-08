import "server-only";

import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import type {
  GrowthAccount,
  GrowthAsset,
  GrowthIdea,
  GrowthLearned,
  GrowthMetric,
  GrowthPost,
  GrowthPublication,
} from "./types";

/** Service-role client for growth_* tables (RLS denies anon/authenticated; admin check happens in callers). */
export function growthDb() {
  return createSupabaseServiceRoleClient();
}
export type GrowthDb = ReturnType<typeof growthDb>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

export function mapIdea(r: Row): GrowthIdea {
  return {
    id: r.id,
    title: r.title,
    angle: r.angle,
    format: r.format,
    notes: r.notes ?? null,
    weight: Number(r.weight ?? 1),
    source: r.source,
    usedCount: Number(r.used_count ?? 0),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function mapPost(r: Row): GrowthPost {
  return {
    id: r.id,
    ideaId: r.idea_id ?? null,
    status: r.status,
    format: r.format,
    title: r.title,
    hook: r.hook ?? null,
    script: r.script ?? null,
    scenes: Array.isArray(r.scenes) ? r.scenes : [],
    captions: r.captions && typeof r.captions === "object" ? r.captions : {},
    platforms: Array.isArray(r.platforms) ? r.platforms : [],
    scheduledFor: r.scheduled_for ?? null,
    approvedAt: r.approved_at ?? null,
    approvedBy: r.approved_by ?? null,
    publishedAt: r.published_at ?? null,
    createdBy: r.created_by,
    reviewNote: r.review_note ?? null,
    learnedFrom: r.learned_from ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function mapAsset(r: Row): GrowthAsset {
  return {
    id: r.id,
    postId: r.post_id,
    kind: r.kind,
    storagePath: r.storage_path,
    publicUrl: r.public_url,
    width: r.width ?? null,
    height: r.height ?? null,
    durationMs: r.duration_ms ?? null,
    meta: r.meta ?? {},
    createdAt: r.created_at,
  };
}

export function mapAccount(r: Row): GrowthAccount {
  return {
    id: r.id,
    platform: r.platform,
    handle: r.handle,
    publisher: r.publisher,
    vendorAccountId: r.vendor_account_id ?? null,
    status: r.status,
    tokenExpiresAt: r.token_expires_at ?? null,
    meta: r.meta ?? {},
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function mapPublication(r: Row): GrowthPublication {
  return {
    id: r.id,
    postId: r.post_id,
    platform: r.platform,
    accountId: r.account_id ?? null,
    status: r.status,
    publisher: r.publisher,
    vendorPostId: r.vendor_post_id ?? null,
    platformPostId: r.platform_post_id ?? null,
    platformUrl: r.platform_url ?? null,
    error: r.error ?? null,
    attempts: Number(r.attempts ?? 0),
    lastAttemptAt: r.last_attempt_at ?? null,
    publishedAt: r.published_at ?? null,
  };
}

export function mapMetric(r: Row): GrowthMetric {
  return {
    id: r.id,
    publicationId: r.publication_id,
    capturedAt: r.captured_at,
    views: r.views ?? null,
    likes: r.likes ?? null,
    comments: r.comments ?? null,
    shares: r.shares ?? null,
    saves: r.saves ?? null,
    followersSnapshot: r.followers_snapshot ?? null,
    raw: r.raw ?? {},
  };
}

export function mapLearned(r: Row): GrowthLearned {
  return { id: r.id, line: r.line, evidence: r.evidence ?? {}, createdAt: r.created_at };
}

/** Throws a readable Error from a PostgREST error object; returns the (untyped) data. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function must(res: { data: unknown; error: { message: string } | null }, what: string): any {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res.data;
}
