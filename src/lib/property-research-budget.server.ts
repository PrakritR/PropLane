import { AsyncLocalStorage } from "node:async_hooks";

const perTurnAttempts = new AsyncLocalStorage<{ count: number }>();
const MAX_BRAVE_ATTEMPTS_PER_TURN = 2;

/** Each agent turn owns one counter, even when tracing is disabled. */
export function withPropertyResearchBudget<T>(run: () => Promise<T>): Promise<T> {
  return perTurnAttempts.run({ count: 0 }, run);
}

/** Synchronous reservation makes parallel tool calls share an atomic limit. */
export function reservePropertyResearchAttempt(): boolean {
  const budget = perTurnAttempts.getStore();
  if (!budget) return true; // Standalone authorized service calls have no agent turn.
  if (budget.count >= MAX_BRAVE_ATTEMPTS_PER_TURN) return false;
  budget.count += 1;
  return true;
}
