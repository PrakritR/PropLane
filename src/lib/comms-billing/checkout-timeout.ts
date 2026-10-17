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
  // Race the abort too, so a fetch that ignores its signal still settles.
  const timeout = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(new CheckoutTimeoutError()));
  });
  try {
    const request = (async () => {
      const res = await fetchImpl(input, { ...init, signal: controller.signal });
      const body = (await res.json()) as T;
      return { ok: res.ok, status: res.status, body };
    })();
    request.catch(() => undefined);
    return await Promise.race([request, timeout]);
  } catch (e) {
    if (timedOut) throw new CheckoutTimeoutError();
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
