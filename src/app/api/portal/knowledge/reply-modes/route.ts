import { NextResponse } from "next/server";
import type { TopicReplyMode } from "@/lib/one-number/contracts";
import { requireKnowledgeActor } from "@/lib/one-number/knowledge/route-auth.server";
import { loadTopicModes, setTopicCeiling } from "@/lib/one-number/knowledge/reply-modes.server";
import { isReplyTopic, REPLY_TOPICS } from "@/lib/one-number/knowledge/topics";

export const runtime = "nodejs";

const MODES: readonly TopicReplyMode[] = ["draft", "auto_review", "full_auto"];

/** Every topic with the mode it runs in and the ceiling the manager picked (null = not picked: full auto, as before). */
export async function GET() {
  const auth = await requireKnowledgeActor("read");
  if (!auth.ok) return auth.response;
  const rows = await loadTopicModes(auth.actor.db, auth.actor.workspaceId);
  return NextResponse.json({
    topics: REPLY_TOPICS.map((topic) => {
      const row = rows.find((r) => r.topic === topic);
      return { topic, mode: row?.mode ?? "full_auto", ceiling: row?.ceiling ?? null, picked: Boolean(row) };
    }),
    canEdit: auth.actor.isOwner,
  });
}

/** Body: `{ topic, mode }`. The mode is the CEILING; the nightly job never moves a topic above it. */
export async function PUT(req: Request) {
  const auth = await requireKnowledgeActor();
  if (!auth.ok) return auth.response;
  if (!auth.actor.isOwner) return NextResponse.json({ error: "Only the workspace owner can change reply modes." }, { status: 403 });
  let body: { topic?: unknown; mode?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  if (!isReplyTopic(body.topic) || !MODES.includes(body.mode as TopicReplyMode)) {
    return NextResponse.json({ error: "Choose a topic and a mode." }, { status: 400 });
  }
  const row = await setTopicCeiling(auth.actor.db, { workspaceId: auth.actor.workspaceId, topic: body.topic, pick: body.mode as TopicReplyMode });
  return row ? NextResponse.json({ topic: row.topic, mode: row.mode, ceiling: row.ceiling }) : NextResponse.json({ error: "Could not save." }, { status: 503 });
}
