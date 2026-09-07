import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Local scratch trees, never shipped and never tracked. `output/` holds
    // mocks, screenshots and prototype entrypoints whose .tsx files sit outside
    // the Next app, so eslint-config-next resolves no react-hooks plugin for
    // them and `npm run lint` died on a config error for anyone who had the
    // directory. `.main-green-validation/` is a full copy of the repo, so
    // linting it reported every finding twice over. Both are excluded from
    // tsconfig for the same reason. CI never sees either - which is exactly why
    // they broke only local runs.
    "output/**",
    ".main-green-validation/**",
  ]),
  {
    rules: {
      // eslint-config-next 16 enables this React Compiler rule at "error".
      // The pre-existing codebase has ~20 legitimate reset-on-dependency
      // setState-in-effect patterns; treat it as a warning like every other
      // react-hooks finding until they are migrated intentionally.
      "react-hooks/set-state-in-effect": "warn",
    },
  },
]);

export default eslintConfig;
