import path from "node:path";
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { environment: "node", include: ["tests/e2e/support/signup-phone-proof.fixture.ts"], maxWorkers: 1, testTimeout: 45_000 },
  resolve: { alias: { "@": path.resolve(__dirname, "../../../src"), "server-only": path.resolve(__dirname, "../../stubs/server-only.ts"), "client-only": path.resolve(__dirname, "../../stubs/server-only.ts") } },
});
