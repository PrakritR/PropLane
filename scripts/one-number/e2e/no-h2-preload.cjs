/**
 * Preloaded into the harness's dev server (NODE_OPTIONS=--require). On Node 26 the process's shared HTTP/2 connection to the model API
 * (and Supabase) is sometimes destroyed mid-run and never recreated (ERR_HTTP2_INVALID_SESSION: "The session has been destroyed"), so
 * every later agent turn fails with "Connection error". This gives fetch a dispatcher with HTTP/2 off and a short keep-alive. Dev harness only.
 */
// CommonJS by necessity: Node loads this through `--require`, before any ESM loader, so `require()` is the
// only way in. The repo's TypeScript lint rule does not apply to a `.cjs` preload.
/* eslint-disable @typescript-eslint/no-require-imports */
try {
  const { Agent } = require(require.resolve("undici", { paths: [process.cwd()] }));
  const agent = new Agent({ allowH2: false, keepAliveTimeout: 4000, keepAliveMaxTimeout: 4000 });
  const original = globalThis.fetch;
  globalThis.fetch = (input, init = {}) => original(input, { ...init, dispatcher: init.dispatcher ?? agent });
} catch (error) {
  console.warn("no-h2-preload: not applied:", error && error.message);
}
