import { processInboundParams } from "@/lib/sms/process-accepted-inbound.server";
import type { PreparedBubble } from "@/lib/sms/inbound-envelope.server";

/** Exercise processing after the separately tested signed, durable webhook envelope. */
export async function processInboundRequest(request: Request): Promise<Response> {
  const params = Object.fromEntries(new URLSearchParams(await request.text()));
  const prepared: PreparedBubble[] = [];
  const response = await processInboundParams(params, prepared, () => undefined, {});
  return prepared.length ? new Response(prepared.map((bubble) => bubble.body).join("\n"), { status: response.status }) : response;
}
