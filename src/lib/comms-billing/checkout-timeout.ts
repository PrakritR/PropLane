/**
 * A request must never spin forever. `fetchJsonWithTimeout` aborts the
 * request (headers and body) after `timeoutMs` and rejects with a plain,
 * retryable message; the caller shows it next to a Retry button.
 *
 * The message is the CALLER's: a non-checkout route (Settings -> Add-ons) must not
 * tell the manager a checkout timed out, so it passes its own `timeoutMessage`.
 */
export const CHECKOUT_TIMEOUT_MS = 15_000;
export const CHECKOUT_TIMEOUT_MESSAGE = "Checkout is taking too long. Check your connection and try again.";

export class CheckoutTimeoutError extends Error {
  constructor(message: string = CHECKOUT_TIMEOUT_MESSAGE) {
    super(message);
    this.name = "CheckoutTimeoutError";
  }
}

export type FetchJsonTimeoutOptions = {
  timeoutMs?: number;
  /** Shown verbatim by the caller when the request times out. */
  timeoutMessage?: string;
};

export async function fetchJsonWithTimeout<T>(
  input: string,
  init: RequestInit = {},
  timeoutOrOptions: number | FetchJsonTimeoutOptions = CHECKOUT_TIMEOUT_MS,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; status: number; body: T }> {
  const timeoutMs =
    typeof timeoutOrOptions === "number" ? timeoutOrOptions : timeoutOrOptions.timeoutMs ?? CHECKOUT_TIMEOUT_MS;
  const timeoutMessage =
    typeof timeoutOrOptions === "number"
      ? CHECKOUT_TIMEOUT_MESSAGE
      : timeoutOrOptions.timeoutMessage ?? CHECKOUT_TIMEOUT_MESSAGE;
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
          : new CheckoutTimeoutError(timeoutMessage),
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
    if (timedOut) throw new CheckoutTimeoutError(timeoutMessage);
    throw e;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
}
