// Dev-script preload: `server-only` throws outside Next's react-server build, and running scripts under the
// `react-server` condition breaks React. Resolve the marker packages to an empty module, exactly as vitest does.
const Module = require("node:module");
const original = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "server-only" || request === "client-only") return require.resolve("./dev-empty-module.cjs");
  return original.call(this, request, ...rest);
};
