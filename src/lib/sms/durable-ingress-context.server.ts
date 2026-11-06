import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";

export type SmsIngressCheckpoint = { stage: "unstarted" | "safe" | "control" | "effect" | "delegated"; controlKeyword?: string; delegatedSid?: string };
type Context = { current: SmsIngressCheckpoint; save: (checkpoint: SmsIngressCheckpoint) => Promise<void> };
const execution = new AsyncLocalStorage<Context>();
export function runWithDurableSmsIngress<T>(context: Context, run: () => Promise<T>): Promise<T> { return execution.run(context, run); }
export function isDurableSmsIngress(): boolean { return execution.getStore() !== undefined; }
export function getDurableSmsCheckpoint(): SmsIngressCheckpoint | undefined { return execution.getStore()?.current; }
export async function durableSmsCheckpoint(checkpoint: SmsIngressCheckpoint): Promise<void> {
 const context = execution.getStore();
 if (!context) return;
 await context.save(checkpoint);
 context.current = checkpoint;
}
/** Only throw for a known pre-effect failure or an idempotent control RPC. */
export class SafeSmsIngressRetry extends Error {
 constructor(reason: string) { super(reason); this.name = "SafeSmsIngressRetry"; }
}
