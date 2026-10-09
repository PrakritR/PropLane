/** Browser shims for the Node built-ins a few shared libs import at module scope. */
export const randomBytes = (n: number) => {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return { toString: () => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("") };
};
export const randomUUID = () => crypto.randomUUID();
export const createHash = () => ({ update: () => ({ digest: () => "0".repeat(64) }) });
