/**
 * Tiny argv parser for the one-number migration scripts. No defaults that touch a database:
 * every script names its target explicitly (see target.mjs).
 *
 *   parseArgs(argv, { booleans: ["apply"], strings: ["target", "reason"] })
 *     -> { flags: { apply: true, target: "dev" }, rest: [] }
 */
export class UsageError extends Error {}

export function parseArgs(argv, spec) {
  const booleans = new Set(spec.booleans ?? []);
  const strings = new Set(spec.strings ?? []);
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      rest.push(token);
      continue;
    }
    const eq = token.indexOf("=");
    const name = token.slice(2, eq === -1 ? undefined : eq);
    if (booleans.has(name)) {
      flags[name] = eq === -1 ? true : token.slice(eq + 1) !== "false";
    } else if (strings.has(name)) {
      let value;
      if (eq !== -1) value = token.slice(eq + 1);
      else {
        value = argv[i + 1];
        i += 1;
      }
      if (value === undefined || (eq === -1 && value.startsWith("--"))) throw new UsageError(`--${name} needs a value`);
      flags[name] = value;
    } else {
      throw new UsageError(`Unknown option --${name}`);
    }
  }
  return { flags, rest };
}
