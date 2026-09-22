/** posthog-js / analytics shim + node:crypto shim for the browser bundle. */
const analytics = { capture: () => {}, captureException: () => {}, identify: () => {}, init: () => {}, register: () => {} };
export default analytics;
export const trackClient = () => {};
export const track = () => {};
export const randomBytes = (n: number) => {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return { toString: () => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("") };
};
export const randomUUID = () => crypto.randomUUID();
export const createHash = () => ({ update() { return this; }, digest: () => "" });
