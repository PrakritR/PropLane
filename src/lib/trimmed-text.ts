/**
 * Trim a value only when it is actually a string.
 *
 * `value?.trim()` does **not** protect against numbers, objects, arrays, or
 * booleans — optional chaining only skips null/undefined. A stored phone like
 * `18559168031` or a JSON email that landed as an object therefore throws
 * `x.trim is not a function` (minifiers rename the local: first `b`, then `x`).
 * That is why Communication settings crashed for some accounts and not others:
 * only rows whose persisted field is a non-string hit the throw, and the same
 * account reproduces in every browser.
 */
export function trimmedText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
