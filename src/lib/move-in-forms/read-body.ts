/**
 * Reads a request body with a hard byte ceiling. `content-length` is a claim, not a measurement
 * (chunked bodies carry none, and a client can lie), so the stream is counted and cancelled the moment
 * it passes the limit.
 */
export class BodyTooLargeError extends Error {
  constructor() {
    super("The request is too large.");
    this.name = "BodyTooLargeError";
  }
}

export async function readBodyBytes(req: Pick<Request, "body" | "headers">, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await req.body?.cancel().catch(() => undefined);
    throw new BodyTooLargeError();
  }
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLargeError();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(received);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

export async function readBodyText(req: Pick<Request, "body" | "headers">, maxBytes: number): Promise<string> {
  return new TextDecoder().decode(await readBodyBytes(req, maxBytes));
}

/** Multipart form data, parsed only after the bytes have been counted under the ceiling. */
export async function readFormDataLimited(req: Pick<Request, "body" | "headers">, maxBytes: number): Promise<FormData> {
  const bytes = await readBodyBytes(req, maxBytes);
  const contentType = req.headers.get("content-type") ?? "";
  return new Response(bytes as BodyInit, { headers: { "content-type": contentType } }).formData();
}
