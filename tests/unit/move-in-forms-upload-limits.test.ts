import { describe, expect, it, vi } from "vitest";
import { BodyTooLargeError, readBodyText, readFormDataLimited } from "@/lib/move-in-forms/read-body";
import { fitImageForUpload, IMAGE_TOO_LARGE_MESSAGE } from "@/lib/move-in-forms/fit-image";
import { MAX_CLIENT_IMAGE_BYTES, MAX_UPLOAD_REQUEST_BYTES } from "@/lib/move-in-forms/limits";

/** A body that streams `chunks` of `size` bytes and records how many it was asked for; it declares no length. */
function streamingRequest(chunkSize: number, count: number) {
  let pulled = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel() { cancelled = true; },
    pull(controller) {
      if (cancelled) return;
      try {
        if (pulled >= count) return controller.close();
        pulled++;
        controller.enqueue(new Uint8Array(chunkSize).fill(97));
      } catch {
        // The reader cancelled between the check and the call.
      }
    },
  });
  return { req: { body, headers: new Headers() }, pulls: () => pulled };
}

describe("readBodyText", () => {
  it("reads a small body whole", async () => {
    const req = new Request("https://x.test", { method: "POST", body: JSON.stringify({ ok: 1 }) });
    await expect(readBodyText(req, 1000)).resolves.toBe('{"ok":1}');
  });

  it("stops at the limit when no content-length is declared, without reading the rest", async () => {
    const { req, pulls } = streamingRequest(1000, 10_000);
    await expect(readBodyText(req, 5_000)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(pulls()).toBeLessThan(20);
  });

  it("does not believe a content-length that understates the body", async () => {
    const { req } = streamingRequest(1000, 10);
    req.headers.set("content-length", "10");
    await expect(readBodyText(req, 5_000)).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it("refuses a declared oversize body before reading it", async () => {
    const { req, pulls } = streamingRequest(1000, 10);
    req.headers.set("content-length", "999999");
    await expect(readBodyText(req, 5_000)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(pulls()).toBe(0);
  });
});

describe("readFormDataLimited", () => {
  it("parses an upload under the ceiling", async () => {
    const data = new FormData();
    data.set("questionKey", "room_photos");
    data.set("file", new Blob([new Uint8Array(100)], { type: "image/jpeg" }), "a.jpg");
    const request = new Request("https://x.test", { method: "POST", body: data });
    const parsed = await readFormDataLimited(request, MAX_UPLOAD_REQUEST_BYTES);
    expect(parsed.get("questionKey")).toBe("room_photos");
    expect((parsed.get("file") as File).size).toBe(100);
  });

  it("refuses an upload past the ceiling", async () => {
    const data = new FormData();
    data.set("file", new Blob([new Uint8Array(6_000)]), "a.jpg");
    const encoded = new Response(data);
    const bytes = new Uint8Array(await encoded.arrayBuffer());
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
    const headers = new Headers({ "content-type": encoded.headers.get("content-type") ?? "" });
    await expect(readFormDataLimited({ body, headers }, 5_000)).rejects.toBeInstanceOf(BodyTooLargeError);
  });
});

describe("fitImageForUpload", () => {
  const big = new Blob([new Uint8Array(MAX_CLIENT_IMAGE_BYTES + 1)], { type: "image/jpeg" });

  it("sends a file under the cap untouched", async () => {
    const render = vi.fn();
    const small = new Blob([new Uint8Array(10)]);
    const out = await fitImageForUpload(small, { render });
    expect(out).toEqual({ blob: small, resized: false });
    expect(render).not.toHaveBeenCalled();
  });

  it("shrinks a big photo in steps until it fits", async () => {
    const sizes = [MAX_CLIENT_IMAGE_BYTES + 5, 1_000];
    const render = vi.fn(async () => new Blob([new Uint8Array(sizes.shift()!)]));
    const out = await fitImageForUpload(big, { render });
    expect(out.resized).toBe(true);
    expect(out.blob.size).toBe(1_000);
    expect(render.mock.calls.map(([, edge]) => edge)).toEqual([2400, 1800]);
  });

  it("refuses with a clear message when it cannot be made to fit, or cannot be decoded", async () => {
    await expect(fitImageForUpload(big, { render: async () => new Blob([new Uint8Array(MAX_CLIENT_IMAGE_BYTES + 1)]) })).rejects.toThrow(IMAGE_TOO_LARGE_MESSAGE);
    await expect(fitImageForUpload(big, { render: async () => null })).rejects.toThrow(IMAGE_TOO_LARGE_MESSAGE);
  });

  it("keeps the client cap under the host's 4.5 MB body limit", () => {
    expect(MAX_CLIENT_IMAGE_BYTES).toBeLessThan(MAX_UPLOAD_REQUEST_BYTES);
  });
});
