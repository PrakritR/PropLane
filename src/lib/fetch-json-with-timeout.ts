/**
 * A request must never spin forever. `fetchJsonWithTimeout` aborts the request
 * (headers and body) after `timeoutMs` and rejects with a plain, retryable
 * message; the caller shows it next to a Retry button.
 *
 * `timeoutMessage` is REQUIRED and belongs to the caller, because this message
 * is rendered verbatim: the route the caller is reading is the only thing that
 * knows what took too long. There is deliberately no default — a shared one is
 * how Settings → Add-ons came to tell a manager that a checkout timed out.
 */
export const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

export class FetchTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FetchTimeoutError";
  }
}

export type FetchJsonTimeoutOptions = {
  /** Shown verbatim by the caller when the request times out. */
  timeoutMessage: string;
  timeoutMs?: number;
};

export async function fetchJsonWithTimeout<T>(
  input: string,
  init: RequestInit,
  options: FetchJsonTimeoutOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; status: number; body: T }> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const timeoutMessage = options.timeoutMessage;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  // A caller's own signal is honoured, not silently replaced by ours: its abort cancels the
  // request too, and rejects with the caller's reason rather than a timeout the caller did not hit.
  const callerSignal = init.signal ?? null;
  let callerAborted = false;
  const abortFromCaller = () => {
    callerAborted = true;
    controller.abort();
  };
  // Race the abort too, so a fetch that ignores its signal still settles.
  const timeout = new Promise<never>((_, reject) => {
    const fail = () =>
      reject(
        callerAborted
          ? (callerSignal?.reason ?? new DOMException("Aborted", "AbortError"))
          : new FetchTimeoutError(timeoutMessage),
      );
    if (controller.signal.aborted) fail();
    else controller.signal.addEventListener("abort", fail, { once: true });
  });
  if (callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  try {
    const request = (async () => {
      const res = await fetchImpl(input, { ...init, signal: controller.signal });
      const body = (await res.json()) as T;
      return { ok: res.ok, status: res.status, body };
    })();
    request.catch(() => undefined);
    return await Promise.race([request, timeout]);
  } catch (e) {
    if (callerAborted) throw callerSignal?.reason ?? e;
    if (timedOut) throw new FetchTimeoutError(timeoutMessage);
    throw e;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
}
