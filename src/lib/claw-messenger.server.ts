/**
 * Retired Claw Messenger client retained only for legacy parsing and cleanup.
 * Runtime configuration can no longer activate the shared agent line.
 *
 * Outbound: pooled WebSocket send via sendClawMessengerText.
 * Inbound: persistent gateway (`scripts/claw-messenger-gateway.mjs`) keeps a
 * WebSocket open and POSTs messages to `/api/webhooks/claw-messenger`.
 */

import { randomUUID } from "node:crypto";
import { normalizeE164 } from "@/lib/phone-e164";
import WebSocket from "ws";

export const CLAW_DEFAULT_AGENT_PHONE = "+12053690702";
export const CLAW_DEFAULT_WS_URL = "wss://claw-messenger.onrender.com/ws";
export const CLAW_DEFAULT_HTTP_BASE = "https://claw-messenger.onrender.com";

export function clawMessengerApiKey(): string | null {
  return process.env.CLAW_MESSENGER_API_KEY?.trim() || null;
}

export function clawMessengerWsUrl(): string {
  return process.env.CLAW_MESSENGER_WS_URL?.trim() || CLAW_DEFAULT_WS_URL;
}

export function clawMessengerHttpBase(): string {
  return process.env.CLAW_MESSENGER_HTTP_BASE?.trim() || CLAW_DEFAULT_HTTP_BASE;
}

/** Shared leasing/contact phone shown on listings (Claw agent line). */
export function clawLeasingAgentPhoneE164(): string {
  const raw = process.env.CLAW_MESSENGER_AGENT_PHONE?.trim() || CLAW_DEFAULT_AGENT_PHONE;
  return normalizeE164Us(raw) ?? CLAW_DEFAULT_AGENT_PHONE;
}

/** The shared Claw transport is retired; environment flags cannot reactivate it. */
export function isClawMessengerConfigured(): boolean {
  return false;
}

export function normalizeE164Us(raw: string): string | null {
  return normalizeE164(raw);
}

export type ClawSendResult = {
  ok: boolean;
  status?: string;
  messageId?: string;
  chatId?: string;
  error?: string;
  raw?: unknown;
};

type WsFrame = Record<string, unknown>;

function waitForSendResult(ws: WebSocket, correlationId: string, timeoutMs: number): Promise<ClawSendResult> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve({ ok: false, error: "Timed out waiting for Claw Messenger send.result." });
    }, timeoutMs);

    const onMessage = (data: WebSocket.RawData) => {
      let frame: WsFrame;
      try {
        frame = JSON.parse(String(data)) as WsFrame;
      } catch {
        return;
      }
      if (frame.type !== "send.result" || frame.id !== correlationId) return;
      cleanup();
      resolve({
        ok: frame.ok === true,
        status: typeof frame.status === "string" ? frame.status : undefined,
        messageId: typeof frame.messageId === "string" ? frame.messageId : undefined,
        chatId: typeof frame.chatId === "string" ? frame.chatId : undefined,
        error: typeof frame.error === "string" ? frame.error : undefined,
        raw: frame,
      });
    };

    const onError = (err: Error) => {
      cleanup();
      resolve({ ok: false, error: err.message || "WebSocket error." });
    };

    const onClose = () => {
      cleanup();
      resolve({ ok: false, error: "WebSocket closed before send.result." });
    };

    const cleanup = () => {
      clearTimeout(timer);
      ws.off("message", onMessage);
      ws.off("error", onError);
      ws.off("close", onClose);
    };

    ws.on("message", onMessage);
    ws.on("error", onError);
    ws.on("close", onClose);
  });
}

/* ── Pooled WebSocket ─────────────────────────────────────────────────────
 * Reply latency was dominated by a fresh WS handshake to the Render relay per
 * send (multiple sends per inbound → serial handshakes, plus cold starts).
 * Keep one socket open per warm process and multiplex sends over it by
 * correlation id; an idle timer closes it so dev servers don't hold sockets. */
let pooledWs: WebSocket | null = null;
let pooledUrl = "";
let pooledIdleTimer: ReturnType<typeof setTimeout> | null = null;
let pooledOpen: { url: string; promise: Promise<WebSocket> } | null = null;

function evictPooled(ws: WebSocket): void {
  if (pooledWs === ws) pooledWs = null;
  try {
    ws.close();
  } catch {
    /* ignore */
  }
}

function touchPooledIdle(): void {
  if (pooledIdleTimer) clearTimeout(pooledIdleTimer);
  pooledIdleTimer = setTimeout(() => {
    try {
      pooledWs?.close();
    } catch {
      /* ignore */
    }
    pooledWs = null;
  }, 60_000);
  pooledIdleTimer.unref?.();
}

function openSocket(url: string, timeoutMs: number): Promise<WebSocket> {
  return new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      reject(new Error("Timed out opening Claw Messenger WebSocket."));
    }, timeoutMs);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once("error", (err) => {
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error("WebSocket error."));
    });
  });
}

async function getPooledSocket(url: string, timeoutMs: number): Promise<WebSocket> {
  if (pooledWs && pooledUrl === url && pooledWs.readyState === WebSocket.OPEN) {
    touchPooledIdle();
    return pooledWs;
  }
  // Serialize concurrent opens: piggyback on an in-flight open for the same URL
  // so two simultaneous sends don't each open (and leak) a socket.
  if (pooledOpen && pooledOpen.url === url) {
    const ws = await pooledOpen.promise;
    if (ws.readyState === WebSocket.OPEN) {
      touchPooledIdle();
      return ws;
    }
  }
  try {
    pooledWs?.close();
  } catch {
    /* ignore */
  }
  pooledWs = null;
  const promise = openSocket(url, timeoutMs).then((ws) => {
    pooledWs = ws;
    pooledUrl = url;
    const evict = () => {
      if (pooledWs === ws) pooledWs = null;
    };
    ws.on("close", evict);
    ws.on("error", evict);
    touchPooledIdle();
    return ws;
  });
  pooledOpen = { url, promise };
  try {
    return await promise;
  } finally {
    if (pooledOpen?.promise === promise) pooledOpen = null;
  }
}

/**
 * Send one text via Claw Messenger over the pooled WebSocket (fresh socket
 * retry once on transport failure). Preferred service defaults to iMessage
 * with automatic SMS/RCS fallback.
 */
export async function sendClawMessengerText(args: {
  to: string;
  text: string;
  service?: "iMessage" | "SMS" | "RCS";
  timeoutMs?: number;
}): Promise<ClawSendResult> {
  const apiKey = clawMessengerApiKey();
  if (!apiKey) return { ok: false, error: "CLAW_MESSENGER_API_KEY is not set." };

  const to = normalizeE164Us(args.to);
  if (!to) return { ok: false, error: "Recipient phone must be a valid US number." };
  const text = args.text.trim();
  if (!text) return { ok: false, error: "Message text is required." };

  const url = `${clawMessengerWsUrl()}?key=${encodeURIComponent(apiKey)}`;
  const openTimeoutMs = args.timeoutMs ?? 10_000;
  const resultTimeoutMs = args.timeoutMs ?? 20_000;

  const attempt = async (fresh: boolean): Promise<ClawSendResult> => {
    let ws: WebSocket;
    try {
      ws = fresh ? await openSocket(url, openTimeoutMs) : await getPooledSocket(url, openTimeoutMs);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "WebSocket open failed." };
    }
    const correlationId = `axis-${randomUUID()}`;
    const payload: Record<string, unknown> = {
      type: "send",
      id: correlationId,
      to,
      parts: [{ type: "text", value: text }],
    };
    if (args.service) payload.service = args.service;
    const wait = waitForSendResult(ws, correlationId, resultTimeoutMs);
    try {
      ws.send(JSON.stringify(payload));
    } catch (err) {
      if (!fresh) evictPooled(ws);
      return { ok: false, error: err instanceof Error ? err.message : "WebSocket send failed." };
    }
    const result = await wait;
    if (fresh) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    } else if (!result.ok) {
      // A pooled socket that timed out / closed mid-send is likely half-open;
      // drop it so the retry (and later sends) start from a fresh handshake.
      evictPooled(ws);
    }
    return result;
  };

  const first = await attempt(false);
  if (first.ok || !/websocket|timed out/i.test(first.error ?? "")) return first;
  return await attempt(true);
}

/* Registration is idempotent server-side; skip the HTTP roundtrip for phones
 * this warm process already registered recently. */
const registeredRoutes = new Map<string, number>();
const ROUTE_REGISTER_TTL_MS = 6 * 60 * 60 * 1000;

/** Register a human phone so inbound texts from them reach the WebSocket gateway. */
export async function registerClawMessengerRoute(phone: string): Promise<{ ok: boolean; error?: string }> {
  const apiKey = clawMessengerApiKey();
  if (!apiKey) return { ok: false, error: "CLAW_MESSENGER_API_KEY is not set." };
  const phoneNumber = normalizeE164Us(phone);
  if (!phoneNumber) return { ok: false, error: "Invalid phone number." };

  const registeredAt = registeredRoutes.get(phoneNumber);
  if (registeredAt && Date.now() - registeredAt < ROUTE_REGISTER_TTL_MS) return { ok: true };

  try {
    const res = await fetch(`${clawMessengerHttpBase()}/api/routes`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ phone_number: phoneNumber }),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; detail?: string; error?: string };
    if (!res.ok) {
      return { ok: false, error: body.detail || body.error || `HTTP ${res.status}` };
    }
    registeredRoutes.set(phoneNumber, Date.now());
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error." };
  }
}
