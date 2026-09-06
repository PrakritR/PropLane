import { NextResponse } from "next/server";

export type AssistantWirePayload = {
  reply: string;
  attachmentContext?: string;
  toolTrace: { tool: string; ok: boolean }[];
  sessionId?: string | null;
  /** Portal archive persistence is confirmed before a streamed turn completes. */
  archiveSaved?: boolean;
  pendingAction?: unknown;
  /** Langfuse proposal-turn id, when tracing is configured. */
  traceId?: string | null;
};

function event(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * The chat transport accepts both JSON (older callers) and SSE (the shared
 * browser hook). Keeping terminal data in `done` means a proxy can never expose
 * a pending action's server-only input while incremental text stays ergonomic.
 */
export function assistantResponse(req: Request, payload: AssistantWirePayload): Response {
  if (!req.headers.get("accept")?.includes("text/event-stream")) return NextResponse.json(payload);
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(event("meta", { sessionId: payload.sessionId ?? null })));
      if (payload.reply) controller.enqueue(encoder.encode(event("delta", { text: payload.reply })));
      if (payload.pendingAction) controller.enqueue(encoder.encode(event("pending_action", payload.pendingAction)));
      controller.enqueue(
        encoder.encode(
          event("done", {
            toolTrace: payload.toolTrace,
            ...(payload.attachmentContext ? { attachmentContext: payload.attachmentContext } : {}),
            sessionId: payload.sessionId ?? null,
            ...(payload.traceId ? { traceId: payload.traceId } : {}),
            ...(typeof payload.archiveSaved === "boolean" ? { archiveSaved: payload.archiveSaved } : {}),
          }),
        ),
      );
      controller.close();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
