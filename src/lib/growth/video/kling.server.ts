import "server-only";

import { MissingKeyError, type ClipAspect, type ClipResult } from "./driver-types";

// fal.ai queue API. Verified: POST https://queue.fal.run/{model} with `Authorization: Key $FAL_KEY`, response {request_id,status_url,response_url};
// status IN_QUEUE|IN_PROGRESS|COMPLETED; result JSON at response_url; output { video: { url } }; input { prompt, duration: "5"|"10", aspect_ratio }.
// TODO(inferred): per-second price; fal.ai model page did not list it. USD 0.07/s is the published Kling 2.5 Turbo Pro rate at time of writing.
export const KLING_MODEL = process.env.GROWTH_KLING_MODEL?.trim() || "fal-ai/kling-video/v2.5-turbo/pro/text-to-video";
const QUEUE = "https://queue.fal.run";
const POLL_MS = 5_000;
const CAP_MS = 6 * 60_000;

export function estimateClipCostUsd(durationS: number): number {
  return Math.round(0.07 * durationS * 100) / 100;
}

export type KlingDeps = { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; pollMs?: number; capMs?: number };

export async function generateClip(
  prompt: string,
  opts: { durationMs: number; aspect: ClipAspect },
  deps: KlingDeps = {},
): Promise<ClipResult> {
  const key = process.env.FAL_KEY?.trim();
  if (!key) throw new MissingKeyError("FAL_KEY");
  const f = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = deps.pollMs ?? POLL_MS;
  const capMs = deps.capMs ?? CAP_MS;
  const headers = { Authorization: `Key ${key}`, "Content-Type": "application/json" };
  const duration = opts.durationMs > 6000 ? "10" : "5";

  const sub = await f(`${QUEUE}/${KLING_MODEL}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ prompt, duration, aspect_ratio: opts.aspect }),
  });
  if (!sub.ok) throw new Error(`Kling submit failed (${sub.status}): ${(await sub.text().catch(() => "")).slice(0, 300)}`);
  const job = (await sub.json()) as { request_id?: string; status_url?: string; response_url?: string };
  if (!job.request_id) throw new Error("Kling submit returned no request_id");
  const statusUrl = job.status_url ?? `${QUEUE}/${KLING_MODEL}/requests/${job.request_id}/status`;
  const resultUrl = job.response_url ?? `${QUEUE}/${KLING_MODEL}/requests/${job.request_id}`;

  let waited = 0;
  for (;;) {
    const res = await f(statusUrl, { headers: { Authorization: `Key ${key}` } });
    if (!res.ok) throw new Error(`Kling status failed (${res.status})`);
    const st = (await res.json()) as { status?: string; error?: string };
    if (st.error) throw new Error(`Kling failed: ${st.error}`);
    if (st.status === "COMPLETED") break;
    if (waited >= capMs) throw new Error("Kling timed out after 6 minutes");
    await sleep(pollMs);
    waited += pollMs;
  }
  const out = await f(resultUrl, { headers: { Authorization: `Key ${key}` } });
  if (!out.ok) throw new Error(`Kling result failed (${out.status})`);
  const result = (await out.json()) as { video?: { url?: string } };
  const url = result.video?.url;
  if (!url) throw new Error("Kling returned no video url");
  const dl = await f(url);
  if (!dl.ok) throw new Error(`Kling download failed (${dl.status})`);
  return { buffer: Buffer.from(await dl.arrayBuffer()), durationMs: Number(duration) * 1000, meta: { model: KLING_MODEL, requestId: job.request_id } };
}
