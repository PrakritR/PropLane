const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", hour12: false });

export function pacificHour(date) {
  const h = Number(fmt.formatToParts(date).find((p) => p.type === "hour")?.value ?? 0);
  return h === 24 ? 0 : h;
}

/** The first moment at or after `date` that falls in Pacific daytime (09:00-19:59), in 15-minute steps. */
export function nextPacificDaytime(date, { from = 9, until = 20 } = {}) {
  let t = new Date(date);
  for (let i = 0; i < 96 * 2; i += 1) {
    const h = pacificHour(t);
    if (h >= from && h < until) return t;
    t = new Date(t.getTime() + 15 * 60 * 1000);
  }
  return t;
}
