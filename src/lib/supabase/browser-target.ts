/** Guard the shipped browser bundle before it creates any database connection. */
export function assertBrowserDatabaseTarget(url: string, hostname: string): void {
  const host = hostname.toLowerCase();
  const staging = host === "staging-prop-lane.space" || host === "staging.prop-lane.space"
    || host.includes("-git-staging-");
  const local = ["localhost", "127.0.0.1", "0.0.0.0"].includes(host);
  const dbHost = new URL(url).hostname;
  if ((staging && dbHost !== "xwszcafaontidfgznlxd.supabase.co")
    || (local && dbHost === "qahnczmilgptcedaqype.supabase.co")) {
    throw new Error("Database environment mismatch. This preview cannot connect to the production database.");
  }
}
