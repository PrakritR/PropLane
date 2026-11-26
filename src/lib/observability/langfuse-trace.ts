/**
 * Trace handle over the Langfuse v5 OpenTelemetry SDK (`@langfuse/tracing`).
 *
 * Langfuse Cloud shut the v3 ingestion API (`POST /api/public/ingestion`) down
 * on 2026-11-16 except for score events: every trace/generation/span the old
 * `langfuse` SDK sent answered HTTP 410 `LANGFUSE_V3_API_REMOVED`, so no agent
 * turn was traced. Traces now travel as OTel spans (the span processor is
 * registered in `src/instrumentation.ts`). This file keeps the old
 * `trace.update / generation / span` surface so `langfuse.ts` and its callers
 * (`TraceLike`) are unchanged: one root observation per turn, children for
 * generations and spans, trace id = the OTel trace id.
 *
 * Fail-open: every call is wrapped by the caller's `safe()`; nothing here may
 * throw into a turn. Scores go through `POST /api/public/scores`, which is a
 * plain REST call (the only v3 ingestion path Langfuse keeps alive).
 */
import { propagateAttributes, startObservation } from "@langfuse/tracing";

type Attrs = Record<string, unknown>;

export type LangfuseTraceInit = {
  name: string;
  userId?: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
  input?: unknown;
};

export type OtelTrace = {
  id: string;
  update(args: Attrs): void;
  generation(args: Attrs): { end(): unknown };
  span(args: Attrs): { end(): unknown };
  /** Ends the root observation. Call once, after the last update. */
  end(): void;
};

/** Propagated trace attributes must be short strings; the full metadata rides on each observation. */
function propagatedMetadata(metadata: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key] = String(value).slice(0, 200);
    }
  }
  return out;
}

/** v3 `usage` ({input, output, unit}) is dropped: `usageDetails` carries the same numbers. */
function toObservationAttrs(args: Attrs): Attrs {
  const { usage: _usage, ...rest } = args;
  return rest;
}

export function createOtelTrace(init: LangfuseTraceInit, environment: string): OtelTrace {
  const propagated = {
    ...(init.userId ? { userId: init.userId } : {}),
    ...(init.sessionId ? { sessionId: init.sessionId } : {}),
    traceName: init.name,
    environment,
    metadata: propagatedMetadata(init.metadata),
  };
  const root = propagateAttributes(propagated, () =>
    startObservation(
      init.name,
      { input: init.input, metadata: init.metadata, environment },
      { asType: "span" },
    ),
  );
  if (init.input !== undefined) root.setTraceIO({ input: init.input });

  const mergedMetadata: Attrs = { ...(init.metadata ?? {}) };
  const child = (name: unknown, asType: "generation" | "span", args: Attrs) =>
    propagateAttributes(propagated, () =>
      root.startObservation(
        typeof name === "string" ? name : asType,
        { ...toObservationAttrs(args), environment } as never,
        { asType } as never,
      ),
    ) as unknown as { end(): unknown };

  return {
    id: root.traceId,
    update(args) {
      const { metadata, ...rest } = args;
      if (metadata && typeof metadata === "object") Object.assign(mergedMetadata, metadata);
      root.update({ ...rest, metadata: mergedMetadata } as never);
      if ("output" in args) root.setTraceIO({ output: args.output });
    },
    generation: (args) => child(args.name, "generation", args),
    span: (args) => child(args.name, "span", args),
    end: () => root.end(),
  };
}

/**
 * Score a trace through the REST API. Returns whether Langfuse accepted it.
 * An explicit `id` makes a retry idempotent (upsert).
 */
export async function postTraceScore(opts: {
  publicKey: string;
  secretKey: string;
  baseUrl: string;
  traceId: string;
  name: string;
  value: number;
  id?: string;
  comment?: string;
  environment?: string;
}): Promise<boolean> {
  const res = await fetch(`${opts.baseUrl.replace(/\/$/, "")}/api/public/scores`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${opts.publicKey}:${opts.secretKey}`).toString("base64")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      traceId: opts.traceId,
      name: opts.name,
      value: opts.value,
      dataType: "NUMERIC",
      ...(opts.id ? { id: opts.id } : {}),
      ...(opts.comment ? { comment: opts.comment } : {}),
      ...(opts.environment ? { environment: opts.environment } : {}),
    }),
    signal: AbortSignal.timeout(8000),
  });
  return res.ok;
}
