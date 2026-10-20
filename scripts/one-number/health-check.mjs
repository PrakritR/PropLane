#!/usr/bin/env node
import { loadDevEnv } from "./e2e/core.mjs";
import { probe } from "./e2e/health.mjs";
const { env, resolved } = loadDevEnv();
const p = await probe(resolved, env);
console.log(JSON.stringify(p));
process.exitCode = p.ok ? 0 : 1;
