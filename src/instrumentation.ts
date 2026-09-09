export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Before the Langfuse block: that one returns early when tracing is not
  // configured, and the shield must not depend on an unrelated feature.
  const { installProtectedAccountFetchShield } = await import(
    "@/lib/protected-accounts-fetch-shield.server"
  );
  installProtectedAccountFetchShield();

  const { getLangfuseSpanProcessor } = await import(
    "@/lib/observability/langfuse-otel.server"
  );
  const processor = getLangfuseSpanProcessor();
  if (!processor || globalThis.__axisLangfuseOtelRegistered) return;

  const { registerOTel } = await import("@vercel/otel");
  registerOTel({
    serviceName: "proplane-agent",
    spanProcessors: [processor],
  });
  globalThis.__axisLangfuseOtelRegistered = true;
}
