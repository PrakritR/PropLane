/** Bounded fetch for auth/signup — an unresponsive route must not spin forever. */
export const AUTH_FETCH_TIMEOUT_MS = 15_000;

/** A portal read that gates a screen's readiness (Bookings sources) gives up after this long. */
export const PORTAL_READ_TIMEOUT_MS = 12_000;

export class FetchTimeoutError extends Error {
  constructor(message = "That took too long. Please try again.") {
    super(message);
    this.name = "FetchTimeoutError";
  }
}

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs: number = AUTH_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new FetchTimeoutError();
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Races a promise against a clock for work that is not a plain `fetch` (a store
 * sync that owns its own request). Rejects with `FetchTimeoutError`; the work
 * itself keeps running, only the caller stops waiting.
 */
export function withTimeout<T>(work: Promise<T>, timeoutMs: number = AUTH_FETCH_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => reject(new FetchTimeoutError()), timeoutMs);
    work.then(
      (value) => {
        clearTimeout(timeoutId);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeoutId);
        reject(error);
      },
    );
  });
}
