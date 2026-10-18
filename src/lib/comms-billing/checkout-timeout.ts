/**
 * A checkout request must never spin forever. `fetchJsonWithTimeout` aborts the
 * request (headers and body) after `timeoutMs` and rejects with a plain,
 * retryable message; the caller shows it next to a Retry button.
 */
export const CHECKOUT_TIMEOUT_MS = 15_000;
export const CHECKOUT_TIMEOUT_MESSAGE = "Checkout is taking too long. Check your connection and try again.";

export class CheckoutTimeoutError extends Error {
  constructor() {
    super(CHECKOUT_TIMEOUT_MESSAGE);
    this.name = "CheckoutTimeoutError";
  }
}

export async function fetchJsonWithTimeout<T>(
  input: string,
  init: RequestInit = {},
  timeoutMs: number = CHECKOUT_TIMEOUT_MS,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; status: number; body: T }> {
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
          : new CheckoutTimeoutError(),
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
    if (timedOut) throw new CheckoutTimeoutError();
    throw e;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
}
