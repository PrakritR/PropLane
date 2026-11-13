/**
 * Phase timing for a server request: names and millisecond numbers only (never an id, email or row content).
 *
 * `timed(name, work)` adds the wall time of `work` to `name`, so overlapping phases are each measured on their
 * own. `header()` is the `Server-Timing` value (phases, then `total`); `logInDevelopment(label)` prints one
 * line, and only when `NODE_ENV === "development"`, so production output is unchanged.
 */
export type PhaseTimer = {
  phases: Record<string, number>;
  timed: <T>(name: string, work: () => Promise<T>) => Promise<T>;
  total: () => number;
  header: () => string;
  logInDevelopment: (label: string) => void;
};

export function createPhaseTimer(): PhaseTimer {
  const startedAt = performance.now();
  const phases: Record<string, number> = {};
  const round = (ms: number) => Math.round(ms * 10) / 10;
  const total = () => round(performance.now() - startedAt);
  const header = () =>
    [
      ...Object.entries(phases)
        .filter(([name]) => /^[a-z][a-z0-9_-]*$/i.test(name))
        .map(([name, ms]) => `${name};dur=${ms}`),
      `total;dur=${total()}`,
    ].join(", ");
  return {
    phases,
    async timed(name, work) {
      const at = performance.now();
      try {
        return await work();
      } finally {
        phases[name] = round((phases[name] ?? 0) + (performance.now() - at));
      }
    },
    total,
    header,
    logInDevelopment(label) {
      if (process.env.NODE_ENV !== "development") return;
      console.info(`[timing] ${label} ${header()}`);
    },
  };
}
