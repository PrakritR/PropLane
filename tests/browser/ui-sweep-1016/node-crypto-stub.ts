/**
 * The record-header fixture pulls in `src/lib/manager-id.ts`, which imports node's `crypto` for an
 * id it never generates in this fixture. esbuild cannot bundle a node builtin for the browser, so
 * the one function it needs is stubbed here. Nothing about the header's measurement touches it.
 */
export function randomBytes(size: number): { toString: (encoding: string) => string } {
  const bytes = Array.from({ length: size }, (_, i) => (i * 37 + 11) % 256);
  return { toString: () => bytes.map((b) => b.toString(16).padStart(2, "0")).join("") };
}
export default { randomBytes };
